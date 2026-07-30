<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * "Sign in with Apple" via identity-token verification — no client secret.
 *
 * Unlike Google, Apple has no tokeninfo endpoint, so the RS256 identity
 * token is verified locally: fetch Apple's JWKS, build an RSA public key
 * from the JWK's n/e (hand-rolled DER — no composer JWT dependency),
 * openssl_verify the signature, then enforce the claims that matter
 * (issuer, audience, expiry, verified email) and map the Apple account
 * onto a SlyTab user.
 *
 * APPLE_CLIENT_ID holds the Apple *Services ID* (e.g. ca.electricrv.slytab.web).
 */
class AppleAuthService
{
    private const JWKS_URL = 'https://appleid.apple.com/auth/keys';
    private const ISSUER = 'https://appleid.apple.com';

    public function __construct(
        private readonly PDO $pdo,
        private readonly AuthService $auth,
    ) {}

    public function enabled(): bool
    {
        return Env::get('APPLE_CLIENT_ID', '') !== '';
    }

    public function clientId(): string
    {
        return Env::get('APPLE_CLIENT_ID', '');
    }

    /**
     * Audiences we accept. The web flow is issued to the Services ID; a
     * native iOS sign-in is issued to the app's BUNDLE ID instead, so
     * checking only the Services ID rejects every token the iPhone app can
     * produce. Found on 2026-07-30, when a tester installed the iOS build
     * and had no way in at all: the app offered Google only, and his account
     * is Apple-linked.
     *
     * @return list<string>
     */
    private function audiences(): array
    {
        return array_values(array_filter([
            $this->clientId(),
            Env::get('APPLE_BUNDLE_ID', 'ca.electricrv.slytab'),
        ]));
    }

    /**
     * Apple's identity token never carries a name; the browser receives it
     * once, on first authorization, and passes it along as $displayName.
     *
     * @return array{token:string, user:array<string,mixed>}
     */
    public function signIn(
        string $idToken,
        string $deviceLabel = '',
        string $displayName = '',
        string $authorizationCode = '',
    ): array {
        if (!$this->enabled()) {
            throw new ApiException('APPLE_DISABLED', 'Apple sign-in is not configured', 503);
        }
        $c = $this->verify($idToken);

        $aud = (string) ($c['aud'] ?? '');
        $iss = (string) ($c['iss'] ?? '');
        $sub = (string) ($c['sub'] ?? '');
        $email = strtolower((string) ($c['email'] ?? ''));
        $exp = (int) ($c['exp'] ?? 0);
        // Apple sends email_verified as boolean or string depending on flow;
        // absent counts as unverified.
        $verified = ($c['email_verified'] ?? false) === true || ($c['email_verified'] ?? '') === 'true';

        $ok = $sub !== ''
            && self::audienceAllowed($aud, $this->audiences())
            && $iss === self::ISSUER
            && $exp > time()
            && $email !== ''
            && $verified;
        if (!$ok) {
            throw self::invalid();
        }

        $userId = $this->userForIdentity($sub, $email, mb_substr(trim($displayName), 0, 80));

        // Apple only hands over an authorization code at sign-in, and it is
        // the only route to a refresh token — which is the only thing that can
        // later revoke this account (#81). Best effort: a failure here must
        // never stop someone signing in.
        if ($authorizationCode !== '') {
            try {
                $refresh = $this->exchangeCode($authorizationCode);
                if ($refresh !== null) {
                    $this->pdo->prepare(
                        "UPDATE oauth_identities SET refresh_token = ?
                         WHERE user_id = ? AND provider = 'apple'",
                    )->execute([$refresh, $userId]);
                }
            } catch (\Throwable $e) {
                error_log('apple: code exchange failed: ' . $e->getMessage());
            }
        }

        return $this->auth->issueSession($userId, $deviceLabel);
    }

    /** @param list<string> $allowed constant-time membership, not a loose compare */
    private static function audienceAllowed(string $aud, array $allowed): bool
    {
        $ok = false;
        foreach ($allowed as $candidate) {
            // No early return: keep the comparison count independent of input.
            $ok = hash_equals($candidate, $aud) || $ok;
        }
        return $ok;
    }

    /** Resolve the Apple identity to a user id, linking or creating as needed. */
    private function userForIdentity(string $sub, string $email, string $name): string
    {
        $stmt = $this->pdo->prepare(
            'SELECT o.user_id FROM oauth_identities o
             JOIN users u ON u.id = o.user_id AND u.deleted_at IS NULL
             WHERE o.provider = ? AND o.subject = ?',
        );
        $stmt->execute(['apple', $sub]);
        $existing = $stmt->fetchColumn();
        if ($existing !== false) {
            return (string) $existing;
        }

        // Same address already registered with a password? Link it — Apple
        // has verified ownership of the mailbox, which also settles our own
        // email confirmation.
        $stmt = $this->pdo->prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL');
        $stmt->execute([$email]);
        $userId = $stmt->fetchColumn();

        if ($userId === false) {
            $userId = Ulid::generate();
            $displayName = $name !== '' ? $name : explode('@', $email)[0];
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
        )->execute([Ulid::generate(), $userId, 'apple', $sub, $email]);

        return (string) $userId;
    }

    /**
     * Decode the JWT and check its RS256 signature against Apple's JWKS.
     * @return array<string,mixed> the verified claims
     */
    /**
     * The client secret Apple wants is a short-lived ES256 JWT signed with a
     * *Sign in with Apple* key — a different key from the App Store Connect
     * one, created under Certificates, Identifiers & Profiles → Keys.
     *
     * Returns null when unconfigured, which is the normal state until that key
     * exists. Everything downstream treats null as "cannot revoke" and carries
     * on rather than failing.
     */
    private function clientSecret(): ?string
    {
        $keyId = Env::get('APPLE_SIWA_KEY_ID', '');
        $teamId = Env::get('APPLE_TEAM_ID', '');
        $keyPath = Env::get('APPLE_SIWA_KEY_PATH', '');
        if ($keyId === '' || $teamId === '' || $keyPath === '' || !is_readable($keyPath)) {
            return null;
        }
        $b64 = static fn(string $b): string => rtrim(strtr(base64_encode($b), '+/', '-_'), '=');
        $header = $b64(json_encode(['alg' => 'ES256', 'kid' => $keyId], JSON_THROW_ON_ERROR));
        $now = time();
        $claims = $b64(json_encode([
            'iss' => $teamId,
            'iat' => $now,
            'exp' => $now + 300,
            'aud' => 'https://appleid.apple.com',
            // The audience of our identity tokens is what we are asking about.
            'sub' => $this->clientId(),
        ], JSON_THROW_ON_ERROR));

        $key = openssl_pkey_get_private((string) file_get_contents($keyPath));
        if ($key === false) {
            error_log('apple: SIWA key could not be read');
            return null;
        }
        $der = '';
        if (!openssl_sign("{$header}.{$claims}", $der, $key, OPENSSL_ALGO_SHA256)) {
            return null;
        }
        // ES256 wants raw r||s; openssl gives DER.
        $raw = self::derToRaw($der);
        return $raw === null ? null : "{$header}.{$claims}." . $b64($raw);
    }

    /** DER ECDSA-Sig-Value -> the 64 raw bytes JOSE expects. */
    private static function derToRaw(string $der): ?string
    {
        $i = 0;
        if (($der[$i++] ?? '') !== "\x30") {
            return null;
        }
        $len = ord($der[$i++] ?? "\x00");
        if ($len > 0x80) {
            $i += $len - 0x80;
        }
        $out = '';
        for ($n = 0; $n < 2; $n++) {
            if (($der[$i++] ?? '') !== "\x02") {
                return null;
            }
            $l = ord($der[$i++] ?? "\x00");
            $v = substr($der, $i, $l);
            $i += $l;
            $v = ltrim($v, "\x00");
            $out .= str_pad($v, 32, "\x00", STR_PAD_LEFT);
        }
        return strlen($out) === 64 ? $out : null;
    }

    /** @return string|null the refresh token, or null if we cannot get one */
    private function exchangeCode(string $code): ?string
    {
        $secret = $this->clientSecret();
        if ($secret === null) {
            return null;
        }
        $body = http_build_query([
            'client_id' => $this->clientId(),
            'client_secret' => $secret,
            'code' => $code,
            'grant_type' => 'authorization_code',
        ]);
        $raw = self::post('https://appleid.apple.com/auth/token', $body);
        $json = json_decode((string) $raw, true);
        $token = is_array($json) ? ($json['refresh_token'] ?? null) : null;
        return is_string($token) && $token !== '' ? $token : null;
    }

    /**
     * Tell Apple this account is gone. Best effort by design — the user asked
     * to be deleted, and our deletion must not hinge on Apple answering.
     *
     * @return bool whether Apple accepted the revocation
     */
    public function revokeForUser(string $userId): bool
    {
        $secret = $this->clientSecret();
        if ($secret === null) {
            error_log('apple: revoke skipped — no Sign in with Apple key configured');
            return false;
        }
        $stmt = $this->pdo->prepare(
            "SELECT refresh_token FROM oauth_identities
             WHERE user_id = ? AND provider = 'apple' AND refresh_token IS NOT NULL",
        );
        $stmt->execute([$userId]);
        $ok = false;
        foreach ($stmt->fetchAll() as $row) {
            $body = http_build_query([
                'client_id' => $this->clientId(),
                'client_secret' => $secret,
                'token' => $row['refresh_token'],
                'token_type_hint' => 'refresh_token',
            ]);
            // Apple answers 200 with an empty body on success.
            $ok = self::post('https://appleid.apple.com/auth/revoke', $body) !== null || $ok;
        }
        return $ok;
    }

    /** @return string|null response body, or null on transport failure */
    private static function post(string $url, string $body): ?string
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_TIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code < 200 || $code >= 300) {
            error_log("apple: POST {$url} returned {$code}");
            return null;
        }
        return is_string($raw) ? $raw : '';
    }

    private function verify(string $idToken): array
    {
        $parts = explode('.', $idToken);
        if (count($parts) !== 3) {
            throw self::invalid();
        }
        [$h64, $p64, $s64] = $parts;
        $header = json_decode(self::b64uDecode($h64), true);
        $claims = json_decode(self::b64uDecode($p64), true);
        $sig = self::b64uDecode($s64);
        if (!is_array($header) || !is_array($claims) || ($header['alg'] ?? '') !== 'RS256') {
            throw self::invalid();
        }

        $kid = (string) ($header['kid'] ?? '');
        $jwk = null;
        foreach ($this->fetchJwks()['keys'] ?? [] as $key) {
            if (is_array($key) && ($key['kid'] ?? null) === $kid && ($key['kty'] ?? null) === 'RSA') {
                $jwk = $key;
                break;
            }
        }
        if ($kid === '' || $jwk === null || !isset($jwk['n'], $jwk['e'])) {
            throw self::invalid();
        }

        $pem = self::jwkToPem((string) $jwk['n'], (string) $jwk['e']);
        if (openssl_verify("{$h64}.{$p64}", $sig, $pem, OPENSSL_ALGO_SHA256) !== 1) {
            throw self::invalid();
        }
        return $claims;
    }

    /**
     * GET Apple's current signing keys. Overridden in tests.
     * @return array<string,mixed>
     */
    protected function fetchJwks(): array
    {
        $ch = curl_init(self::JWKS_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($body === false || $status !== 200) {
            throw self::invalid();
        }
        $jwks = json_decode((string) $body, true);
        if (!is_array($jwks)) {
            throw self::invalid();
        }
        return $jwks;
    }

    /** Build a PEM public key from a JWK's base64url modulus and exponent. */
    private static function jwkToPem(string $n, string $e): string
    {
        // SubjectPublicKeyInfo ::= SEQUENCE {
        //   SEQUENCE { OID rsaEncryption, NULL },
        //   BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
        $rsa = self::derSequence(self::derInteger(self::b64uDecode($n)) . self::derInteger(self::b64uDecode($e)));
        $algorithm = self::derSequence("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00");
        $bitString = "\x03" . self::derLength(strlen($rsa) + 1) . "\x00" . $rsa;
        $der = self::derSequence($algorithm . $bitString);
        return "-----BEGIN PUBLIC KEY-----\n"
            . chunk_split(base64_encode($der), 64, "\n")
            . "-----END PUBLIC KEY-----\n";
    }

    /** DER INTEGER from unsigned big-endian bytes (prefix 0x00 if high bit set). */
    private static function derInteger(string $bytes): string
    {
        if ($bytes === '' || (ord($bytes[0]) & 0x80) !== 0) {
            $bytes = "\x00" . $bytes;
        }
        return "\x02" . self::derLength(strlen($bytes)) . $bytes;
    }

    private static function derSequence(string $content): string
    {
        return "\x30" . self::derLength(strlen($content)) . $content;
    }

    private static function derLength(int $length): string
    {
        if ($length < 0x80) {
            return chr($length);
        }
        $bytes = ltrim(pack('N', $length), "\x00");
        return chr(0x80 | strlen($bytes)) . $bytes;
    }

    private static function b64uDecode(string $s): string
    {
        $decoded = base64_decode(strtr($s, '-_', '+/'), true);
        if ($decoded === false) {
            throw self::invalid();
        }
        return $decoded;
    }

    private static function invalid(): ApiException
    {
        return new ApiException('APPLE_TOKEN_INVALID', 'Apple sign-in failed — try again', 401);
    }
}
