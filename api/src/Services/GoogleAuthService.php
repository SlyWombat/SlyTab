<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * "Sign in with Google" via ID-token verification — no client secret.
 *
 * The browser (Google Identity Services) or app obtains a signed ID token
 * and posts it here. We hand the token to Google's tokeninfo endpoint,
 * which checks the RS256 signature server-side, then we enforce the
 * claims that matter (issuer, audience, expiry, verified email) and map
 * the Google account onto a SlyTab user. Fine at family scale; swap in
 * local JWKS verification if this ever needs to handle real volume.
 */
class GoogleAuthService
{
    private const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
    private const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly AuthService $auth,
    ) {}

    public function enabled(): bool
    {
        return Env::get('GOOGLE_CLIENT_ID', '') !== '';
    }

    public function clientId(): string
    {
        return Env::get('GOOGLE_CLIENT_ID', '');
    }

    /** @return array{token:string, user:array<string,mixed>} */
    public function signIn(string $idToken, string $deviceLabel = ''): array
    {
        if (!$this->enabled()) {
            throw new ApiException('GOOGLE_DISABLED', 'Google sign-in is not configured', 503);
        }
        $c = $this->fetchClaims($idToken);

        $aud = (string) ($c['aud'] ?? '');
        $iss = (string) ($c['iss'] ?? '');
        $sub = (string) ($c['sub'] ?? '');
        $email = strtolower((string) ($c['email'] ?? ''));
        $exp = (int) ($c['exp'] ?? 0);
        $verified = ($c['email_verified'] ?? 'false') === 'true' || ($c['email_verified'] ?? false) === true;

        $ok = $sub !== ''
            && hash_equals($this->clientId(), $aud)
            && in_array($iss, self::ISSUERS, true)
            && $exp > time()
            && $email !== ''
            && $verified;
        if (!$ok) {
            throw new ApiException('GOOGLE_TOKEN_INVALID', 'Google sign-in failed — try again', 401);
        }

        $userId = $this->userForIdentity($sub, $email, trim((string) ($c['name'] ?? '')));
        return $this->auth->issueSession($userId, $deviceLabel);
    }

    /** Resolve the Google identity to a user id, linking or creating as needed. */
    private function userForIdentity(string $sub, string $email, string $name): string
    {
        $stmt = $this->pdo->prepare(
            'SELECT o.user_id FROM oauth_identities o
             JOIN users u ON u.id = o.user_id AND u.deleted_at IS NULL
             WHERE o.provider = ? AND o.subject = ?',
        );
        $stmt->execute(['google', $sub]);
        $existing = $stmt->fetchColumn();
        if ($existing !== false) {
            return (string) $existing;
        }

        // Same address already registered with a password? Link it — Google
        // has verified ownership of the mailbox, which also settles our own
        // email confirmation.
        $stmt = $this->pdo->prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL');
        $stmt->execute([$email]);
        $userId = $stmt->fetchColumn();

        if ($userId === false) {
            $userId = Ulid::generate();
            $displayName = $name !== '' ? mb_substr($name, 0, 80) : explode('@', $email)[0];
            // Random unguessable password hash: the account is OAuth-only
            // until the user does a password reset to add one.
            $this->pdo->prepare(
                'INSERT INTO users (id, email, password_hash, display_name, payment_handles, email_verified_at)
                 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
            )->execute([
                $userId, $email,
                password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT),
                $displayName, '{}',
            ]);
        } else {
            $this->pdo->prepare(
                'UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()),
                        placeholder_at = NULL WHERE id = ?',
            )->execute([$userId]);
        }

        $this->pdo->prepare(
            'INSERT INTO oauth_identities (id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?)',
        )->execute([Ulid::generate(), $userId, 'google', $sub, $email]);

        return (string) $userId;
    }

    /**
     * Ask Google to validate the token and return its claims.
     * Overridden in tests. @return array<string,mixed>
     */
    protected function fetchClaims(string $idToken): array
    {
        $ch = curl_init(self::TOKENINFO_URL . '?id_token=' . urlencode($idToken));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($body === false || $status !== 200) {
            throw new ApiException('GOOGLE_TOKEN_INVALID', 'Google sign-in failed — try again', 401);
        }
        $claims = json_decode((string) $body, true);
        if (!is_array($claims)) {
            throw new ApiException('GOOGLE_TOKEN_INVALID', 'Google sign-in failed — try again', 401);
        }
        return $claims;
    }
}
