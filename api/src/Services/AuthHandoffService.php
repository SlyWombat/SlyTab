<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;
use SlyTab\Support\Ulid;

/**
 * Browser handoff for mobile "Sign in with Google" (issue #39).
 *
 * The app binary has no Google SDK, so it delegates to the system
 * browser: it starts a handoff here (keeping the secret verifier), opens
 * the web app's /app-signin/<state> page, and polls claim(). The browser
 * page signs in with Google Identity Services and posts the ID token to
 * completeGoogle(); the session is only released to the caller holding
 * the verifier, so neither the URL nor the deep link back to the app is
 * worth stealing, and the browser never sees a session token.
 */
class AuthHandoffService
{
    private const TTL_SECONDS = 600; // ten minutes to finish signing in

    public function __construct(
        private readonly PDO $pdo,
        private readonly AuthService $auth,
        private readonly GoogleAuthService $google,
    ) {}

    /** @return array{state:string, verifier:string, expiresIn:int} */
    public function start(string $deviceLabel): array
    {
        if (!$this->google->enabled()) {
            throw new ApiException('GOOGLE_DISABLED', 'Google sign-in is not configured', 503);
        }
        // Housekeeping: abandoned handoffs have no value — drop them.
        $this->pdo->exec('DELETE FROM auth_handoffs WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR');

        $state = bin2hex(random_bytes(16));
        $verifier = bin2hex(random_bytes(32));
        $this->pdo->prepare(
            'INSERT INTO auth_handoffs (id, state, verifier_hash, device_label, created_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
        )->execute([Ulid::generate(), $state, hash('sha256', $verifier), mb_substr($deviceLabel, 0, 80)]);
        return ['state' => $state, 'verifier' => $verifier, 'expiresIn' => self::TTL_SECONDS];
    }

    /** Browser side: the Google ID token proves who signed in. @return array{ok:true} */
    public function completeGoogle(string $state, string $idToken): array
    {
        $row = $this->rowForState($state);
        if ($row === null || $row['completed_at'] !== null) {
            throw new ApiException('HANDOFF_INVALID', 'This sign-in link has expired — start again from the app', 410);
        }
        $userId = $this->google->resolveUser($idToken);
        $this->pdo->prepare(
            'UPDATE auth_handoffs SET user_id = ?, completed_at = UTC_TIMESTAMP() WHERE id = ? AND completed_at IS NULL',
        )->execute([$userId, $row['id']]);
        return ['ok' => true];
    }

    /**
     * App side: exchange state + verifier for a session once the browser
     * side is done. Single-use — the row dies the moment a session leaves.
     * @return array{pending:true}|array{token:string, user:array<string,mixed>}
     */
    public function claim(string $state, string $verifier): array
    {
        $row = $this->rowForState($state);
        if ($row === null || !hash_equals((string) $row['verifier_hash'], hash('sha256', $verifier))) {
            throw new ApiException('HANDOFF_INVALID', 'This sign-in attempt has expired — try again', 410);
        }
        if ($row['completed_at'] === null || $row['user_id'] === null) {
            return ['pending' => true];
        }
        $this->pdo->prepare('DELETE FROM auth_handoffs WHERE id = ?')->execute([$row['id']]);
        return $this->auth->issueSession((string) $row['user_id'], (string) $row['device_label']);
    }

    /** @return array<string,mixed>|null */
    private function rowForState(string $state): ?array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, verifier_hash, device_label, user_id, completed_at FROM auth_handoffs
             WHERE state = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ' . self::TTL_SECONDS . ' SECOND',
        );
        $stmt->execute([$state]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }
}
