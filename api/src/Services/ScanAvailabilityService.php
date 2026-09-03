<?php

declare(strict_types=1);

namespace SlyTab\Services;

use SlyTab\Support\Env;

/**
 * Is receipt scanning available right now? (issue #123)
 *
 * Until this existed the answer was discovered by failing: `ReceiptService::parse()`
 * read the environment at the moment a receipt was posted, so a user photographed a
 * receipt, waited, and *then* learned the model host was down. FR-4.2's graceful
 * degradation is a recovery path; this is the availability one.
 *
 * WHAT "AVAILABLE" MEANS HERE (owner, 2026-09-01): "if service is advertising then it
 * is available". So this asks the front door whether it is serving, not how fast — no
 * latency budget, deliberately. A slow answer is still an answer, and the honest bar
 * for the passing model is 3.5-8.0 s anyway.
 *
 * It does check that the configured model is one the host advertises. A front door
 * that answers while lacking `LOCAL_LLM_MODEL` is the worst case, not a working one:
 * the request would fail at parse time having already taken the user's photograph.
 *
 * CACHED, because the capabilities endpoint is public. Without a TTL, anyone could use
 * it to drive an unauthenticated request per hit at the model host — which is
 * reachable on the LAN without authentication (house-network-ops#25).
 */
final class ScanAvailabilityService
{
    public const CACHE_TTL_SECONDS = 15;

    /** @var array{at: float, status: array<string,mixed>}|null */
    private static ?array $cache = null;

    /** @var (callable(string, list<string>): array{ok: bool, body: string})|null */
    private $probe;

    /**
     * @param (callable(string, list<string>): array{ok: bool, body: string})|null $probe
     *        Injected in tests; production uses the curl probe below. The second
     *        argument is the request headers — the front door's token rides there.
     */
    public function __construct(?callable $probe = null)
    {
        $this->probe = $probe;
    }

    /** Drop the memoised answer — tests, and any caller that just changed config. */
    public static function forget(): void
    {
        self::$cache = null;
    }

    /**
     * @return array{available: bool, reason: ?string}
     *         `reason` is shown to end users, so it says what they can do about it
     *         (nothing) rather than which host is down.
     */
    public function status(): array
    {
        if (self::$cache !== null && (microtime(true) - self::$cache['at']) < self::CACHE_TTL_SECONDS) {
            /** @var array{available: bool, reason: ?string} */
            return self::$cache['status'];
        }
        $status = $this->compute();
        self::$cache = ['at' => microtime(true), 'status' => $status];
        return $status;
    }

    /** @return array{available: bool, reason: ?string} */
    private function compute(): array
    {
        $engine = Env::get('RECEIPT_ENGINE', 'auto');
        $localUrl = Env::get('LOCAL_LLM_URL');
        $claudeKey = Env::get('ANTHROPIC_API_KEY');

        // Mirror ReceiptService::parse()'s engine order exactly. Two functions that
        // disagree about which engine runs would advertise one thing and do another.
        if ($engine === 'local' || ($engine === 'auto' && $localUrl !== '')) {
            if ($localUrl === '') {
                return self::off('Receipt scanning is not configured on this server');
            }
            return $this->localStatus($localUrl);
        }
        if ($engine === 'claude' || ($engine === 'auto' && $claudeKey !== '')) {
            return $claudeKey === ''
                ? self::off('Receipt scanning is not configured on this server')
                : ['available' => true, 'reason' => null];
        }
        return self::off('Receipt scanning is not configured on this server');
    }

    /** @return array{available: bool, reason: ?string} */
    private function localStatus(string $baseUrl): array
    {
        $probe = $this->probe ?? self::curlProbe(...);
        $res = $probe(rtrim($baseUrl, '/') . '/api/tags', self::headers());
        if (!$res['ok']) {
            return self::off('Receipt scanning is offline right now');
        }

        $want = Env::get('LOCAL_LLM_MODEL', 'qwen2.5vl:7b');
        if ($want === '' || self::advertises($res['body'], $want)) {
            return ['available' => true, 'reason' => null];
        }
        // Answering but without our model: available to a port scan, useless to us.
        return self::off('Receipt scanning is offline right now');
    }

    /**
     * Ollama's /api/tags lists `{"models":[{"name":"qwen2.5vl:7b",...}]}`. A tag with
     * no explicit `:tag` means `:latest` to Ollama, so compare both ways rather than
     * demanding a literal match.
     */
    private static function advertises(string $body, string $want): bool
    {
        try {
            $decoded = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return false;
        }
        if (!is_array($decoded) || !is_array($decoded['models'] ?? null)) {
            return false;
        }
        $wanted = str_contains($want, ':') ? $want : $want . ':latest';
        foreach ($decoded['models'] as $m) {
            $name = is_array($m) ? (string) ($m['name'] ?? '') : '';
            if ($name === '') {
                continue;
            }
            if ($name === $want || $name === $wanted
                || (!str_contains($name, ':') && $name . ':latest' === $wanted)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The same headers a parse sends — and it must stay the same set, or this
     * reports on a door the parse does not go through.
     *
     * The front door (#119) answers 401 to anything without SlyTab's token —
     * /api/tags included, deliberately, since a model list is a fingerprint —
     * and since #124 Cloudflare Access stands in front of that and answers 403
     * to anything without the service token. A probe missing either would
     * report the scanner offline for exactly as long as it was working.
     * Both are optional: a dev Ollama with no doors in front of it gets
     * neither. Mirrors `ReceiptService::localHeaders()`.
     *
     * @return list<string>
     */
    private static function headers(): array
    {
        $headers = [];
        $token = Env::get('LOCAL_LLM_TOKEN');
        if ($token !== '') {
            $headers[] = "Authorization: Bearer {$token}";
        }
        $cfId = Env::get('LOCAL_LLM_CF_ACCESS_ID');
        $cfSecret = Env::get('LOCAL_LLM_CF_ACCESS_SECRET');
        if ($cfId !== '' && $cfSecret !== '') {
            $headers[] = "CF-Access-Client-Id: {$cfId}";
            $headers[] = "CF-Access-Client-Secret: {$cfSecret}";
        }
        return $headers;
    }

    /**
     * @param list<string> $headers
     * @return array{ok: bool, body: string}
     */
    private static function curlProbe(string $url, array $headers = []): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => 2,
            // Short on purpose: this runs while a user waits for a screen to render.
            // Parsing gets a long timeout; asking whether the door is open does not.
            // Cloudflare Access and the tunnel (#124) add ~30-60 ms to a /api/tags
            // that already answers in single-digit ms, so 2 s / 4 s still has room.
            CURLOPT_TIMEOUT => 4,
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['ok' => $code === 200 && is_string($body), 'body' => is_string($body) ? $body : ''];
    }

    /** @return array{available: bool, reason: string} */
    private static function off(string $reason): array
    {
        return ['available' => false, 'reason' => $reason];
    }
}
