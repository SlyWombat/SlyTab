<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use Psr\Http\Message\UploadedFileInterface;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * Receipt storage + Claude-powered itemization — FR-4.x. The image and the
 * parse both stay server-side; the API key never reaches a client. Parsing
 * is best-effort: on any failure the client falls back to manual entry
 * with the stored photo attached (FR-4.2).
 */
final class ReceiptService
{
    private const MAX_BYTES = 25 * 1024 * 1024; // Pixel "Motion Photos" easily exceed 10 MB
    private const MAX_DIMENSION = 1600;
    private const MIME_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    private const CLAUDE_MODEL = 'claude-opus-4-8';

    public function __construct(private readonly PDO $pdo) {}

    /** @return array<string,mixed> receipt row incl. parsed data or parseError */
    public function ingest(string $groupId, string $userId, UploadedFileInterface $file, string $currencyHint = ''): array
    {
        $currencyHint = preg_match('/^[A-Z]{3}$/', $currencyHint) ? $currencyHint : '';
        if ($file->getError() !== UPLOAD_ERR_OK) {
            throw new ApiException('VALIDATION', 'image upload failed');
        }
        if ($file->getSize() === null || $file->getSize() > self::MAX_BYTES) {
            throw new ApiException('VALIDATION', 'image must be 25 MB or smaller', 413);
        }
        $mime = $file->getClientMediaType() ?? '';
        if (!isset(self::MIME_EXT[$mime])) {
            throw new ApiException('VALIDATION', 'image must be JPEG, PNG, or WebP');
        }

        $id = Ulid::generate();
        $dir = self::dataDir() . "/receipts/{$groupId}";
        if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
            throw new \RuntimeException("cannot create receipt directory {$dir}");
        }
        $uploadBytes = (int) $file->getSize();
        $relPath = "receipts/{$groupId}/{$id}." . self::MIME_EXT[$mime];
        $file->moveTo(self::dataDir() . '/' . $relPath);

        $t0 = microtime(true);
        [$relPath, $mime] = $this->normalizeImage($relPath, $mime);
        $normalizeMs = (int) round((microtime(true) - $t0) * 1000);
        $normalizedBytes = (int) (filesize(self::dataDir() . '/' . $relPath) ?: 0);

        // The receipt row exists from here on, parsed or not: a queued scan
        // has to be something the client can come back for.
        $this->pdo->prepare(
            'INSERT INTO receipts (id, group_id, image_path, parsed, created_by) VALUES (?, ?, ?, NULL, ?)',
        )->execute([$id, $groupId, $relPath, $userId]);

        // One parse per backend, across the whole app — and a LINE for the
        // rest (#123, requirement 2).
        //
        // The vision model serialises absolutely — four concurrent requests
        // measured 3.2s, 6.3s, 9.3s, 12.4s, one behind the other. A real
        // first-seen parse takes ~22s (p50, n=21), so a second scan arriving
        // during a first waits ~22s and then takes ~22s, blowing past the
        // host's ~30s request limit. That has already happened in production
        // at four users: report 01KYDXM6JR ("on wifi but still failed") was
        // filed 55 seconds after a parse this table records as SUCCESSFUL.
        //
        // Worse, a blocked upload holds one of the account's twenty entry
        // processes for its whole duration, so twenty simultaneous scans take
        // the entire app down with 508s for several minutes.
        //
        // So nobody waits inside a request. A scan that cannot start now gets a
        // ticket and a place in line, and the client asks again (rescan with
        // the ticket) when told to. The photo is already stored by this point,
        // so the user keeps it either way.
        $queue = new ScanQueue($this->pdo);
        $admission = $queue->admit($id, $userId, null, self::eta($this->pdo)['typicalMs']);
        if ($admission['queued'] !== null) {
            $this->recordMetrics([
                'receipt_id' => $id,
                'group_id' => $groupId,
                'upload_bytes' => $uploadBytes,
                'normalized_bytes' => $normalizedBytes,
                'normalize_ms' => $normalizeMs,
                'engine' => $this->engineName(),
                'parse_ms' => 0,
                'outcome' => 'queued',
                'confidence' => null,
                'error' => null,
            ]);
            return self::queuedResult($id, $groupId, $admission['queued']);
        }

        $parsed = null;
        $parseError = null;
        $t1 = microtime(true);
        try {
            $parsed = $this->parse(self::dataDir() . '/' . $relPath, $mime, $currencyHint);
            // Issue #10: keep the raw parse for repeat testing (data dir only).
            @file_put_contents(
                self::dataDir() . '/' . preg_replace('/\.[a-z]+$/', '.parse.json', $relPath),
                json_encode($parsed, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR),
            );
            $this->pdo->prepare('UPDATE receipts SET parsed = ? WHERE id = ?')
                ->execute([json_encode($parsed, JSON_THROW_ON_ERROR), $id]);
        } catch (\Throwable $e) {
            $parseError = $e instanceof ApiException
                ? $e->getMessage()
                : (str_contains($e->getMessage(), 'unreachable')
                    ? 'the receipt reader is offline right now — the photo is attached, try Rescan later'
                    : 'could not read this receipt — the photo is attached, enter the details manually');
            error_log('receipt parse failed: ' . $e->getMessage());
        } finally {
            $queue->release($admission['slot']);
        }
        $parseMs = (int) round((microtime(true) - $t1) * 1000);

        $this->recordMetrics([
            'receipt_id' => $id,
            'group_id' => $groupId,
            'upload_bytes' => $uploadBytes,
            'normalized_bytes' => $normalizedBytes,
            'normalize_ms' => $normalizeMs,
            'engine' => $this->engineName(),
            'parse_ms' => $parseMs,
            'outcome' => $parsed !== null ? 'parsed' : 'parse_failed',
            'confidence' => $parsed['confidence'] ?? null,
            'error' => $parseError,
        ]);

        $out = ['id' => $id, 'groupId' => $groupId, 'parsed' => $parsed];
        if ($parseError !== null) {
            $out['parseError'] = $parseError;
        }
        return $out;
    }

    /**
     * The shape a client gets while its receipt waits in line. `parsed` is
     * null and `parseError` is filled in so a client from before the queue
     * existed shows something true ("in line, tap Rescan") instead of
     * nothing; a current client reads `queued` and asks again by itself.
     *
     * @param array<string,mixed> $queued
     * @return array<string,mixed>
     */
    private static function queuedResult(string $id, string $groupId, array $queued): array
    {
        $ahead = (int) $queued['ahead'];
        $line = $ahead === 0
            ? 'the receipt reader is busy with another receipt'
            : sprintf('%d receipt%s %s ahead of yours', $ahead, $ahead === 1 ? '' : 's', $ahead === 1 ? 'is' : 'are');
        return [
            'id' => $id,
            'groupId' => $groupId,
            'parsed' => null,
            'queued' => $queued,
            'parseError' => "{$line} — the photo is attached, tap Rescan in a moment",
        ];
    }

    /**
     * How long a scan takes here, from the last twenty that worked (issue #9:
     * historical timing, not a static guess). Shared by the ETA endpoint and
     * the queue's "about N seconds".
     *
     * @return array{samples: int, typicalMs: int, slowMs: int}
     */
    public static function eta(PDO $pdo): array
    {
        // RECENT parses only, and few of them. The reader's speed is a property
        // of the hardware behind the door, and that changes: on 2026-09-03 it
        // moved from an iGPU to an R9700 and went from ~19 s a receipt to ~3.2 s
        // (#124). A median over the last 20 of all time then promised people
        // "about 19s" for something that took three, which is not feedback, it
        // is a stale number wearing feedback's clothes.
        //
        // Ten samples inside a week: enough to be a median rather than a
        // coin-flip, few enough that the estimate follows a hardware change
        // within about five scans instead of ten. If the last week is too thin
        // to say anything, fall back to the last ten whenever they happened —
        // an old number beats no number, and `samples` tells the caller which
        // it got.
        $recent = "SELECT parse_ms FROM receipt_metrics
                    WHERE outcome = 'parsed' AND parse_ms > 0
                      AND created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY
                 ORDER BY id DESC LIMIT 10";
        $any = "SELECT parse_ms FROM receipt_metrics
                 WHERE outcome = 'parsed' AND parse_ms > 0
              ORDER BY id DESC LIMIT 10";
        try {
            $ms = array_map('intval', $pdo->query($recent)->fetchAll(PDO::FETCH_COLUMN));
            if (count($ms) < 3) {
                $ms = array_map('intval', $pdo->query($any)->fetchAll(PDO::FETCH_COLUMN));
            }
        } catch (\Throwable) {
            $ms = [];
        }
        sort($ms);
        $n = count($ms);
        return [
            'samples' => $n,
            'typicalMs' => $n > 0 ? $ms[intdiv($n, 2)] : 15000,
            'slowMs' => $n > 0 ? $ms[min($n - 1, (int) floor($n * 0.9))] : 40000,
        ];
    }

    /** Testing-phase telemetry (issue #10). Never allowed to break an upload. */
    private function recordMetrics(array $m): void
    {
        try {
            $this->pdo->prepare(
                'INSERT INTO receipt_metrics (id, receipt_id, group_id, upload_bytes, normalized_bytes,
                                              normalize_ms, engine, parse_ms, outcome, confidence, error)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )->execute([
                Ulid::generate(), $m['receipt_id'], $m['group_id'], $m['upload_bytes'],
                $m['normalized_bytes'], $m['normalize_ms'], $m['engine'], $m['parse_ms'],
                $m['outcome'], $m['confidence'], $m['error'] === null ? null : mb_substr($m['error'], 0, 500),
            ]);
        } catch (\Throwable $e) {
            error_log('receipt metrics failed: ' . $e->getMessage());
        }
    }

    private function engineName(): string
    {
        $engine = Env::get('RECEIPT_ENGINE', 'auto');
        if ($engine !== 'auto') {
            return $engine;
        }
        return Env::get('LOCAL_LLM_URL') !== '' ? 'local'
            : (Env::get('ANTHROPIC_API_KEY') !== '' ? 'claude' : 'none');
    }

    /**
     * Re-encode oversized photos: downscale to MAX_DIMENSION and save as
     * JPEG. Cuts multi-MB phone photos (and strips the video trailer that
     * Pixel "Motion Photos" append) so the vision model gets a fast,
     * clean image. No-op when GD is unavailable or the image is already
     * small.
     *
     * @return array{0:string,1:string} [relPath, mime] after normalization
     */
    /**
     * Remove EXIF/XMP from a JPEG in place, losslessly.
     *
     * Receipt photos carry the camera's GPS fix — where the user was, to a
     * few metres — and every client has a path that uploads the file
     * untouched: the web shrinker returns the original below 500 KB, both
     * shrinkers fall back to the original on error, and the server skips
     * images that are already small. So the only place this can be
     * guaranteed is here, where all of them converge (issue #83).
     *
     * This rewrites the segment list rather than re-encoding: APP1 holds
     * EXIF and XMP and is dropped, everything else — including the APP2
     * ICC profile and the image data itself — is copied byte for byte. No
     * quality is lost and no pixels change.
     */
    private static function stripJpegMetadata(string $path): void
    {
        $raw = @file_get_contents($path);
        if ($raw === false || strncmp($raw, "\xFF\xD8", 2) !== 0) {
            return; // not a JPEG; PNGs carry no EXIF GPS from our clients
        }
        $out = "\xFF\xD8";
        $i = 2;
        $len = strlen($raw);
        while ($i + 4 <= $len && $raw[$i] === "\xFF") {
            $marker = ord($raw[$i + 1]);
            // Start of scan: the rest is entropy-coded image data, copy it whole.
            if ($marker === 0xDA) {
                $out .= substr($raw, $i);
                break;
            }
            $segLen = (ord($raw[$i + 2]) << 8) | ord($raw[$i + 3]);
            if ($segLen < 2 || $i + 2 + $segLen > $len) {
                return; // malformed — leave the file exactly as it was
            }
            if ($marker !== 0xE1) { // 0xE1 = APP1 = EXIF and XMP
                $out .= substr($raw, $i, 2 + $segLen);
            }
            $i += 2 + $segLen;
        }
        if ($out !== $raw) {
            @file_put_contents($path, $out);
        }
    }

    private function normalizeImage(string $relPath, string $mime): array
    {
        $path = self::dataDir() . '/' . $relPath;
        // Before anything else, and regardless of which branch below runs.
        self::stripJpegMetadata($path);
        if (!function_exists('imagecreatefromstring')) {
            return [$relPath, $mime];
        }
        $size = @getimagesize($path);
        if ($size === false) {
            return [$relPath, $mime];
        }
        [$w, $h] = $size;
        $big = max($w, $h);
        if ($big <= self::MAX_DIMENSION && (filesize($path) ?: 0) <= 2 * 1024 * 1024) {
            return [$relPath, $mime];
        }
        $src = @imagecreatefromstring((string) file_get_contents($path));
        if ($src === false) {
            return [$relPath, $mime];
        }
        $scale = min(1.0, self::MAX_DIMENSION / $big);
        $nw = max(1, (int) round($w * $scale));
        $nh = max(1, (int) round($h * $scale));
        $dst = imagecreatetruecolor($nw, $nh);
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
        imagedestroy($src);

        $newRel = preg_replace('/\.[a-z]+$/', '.jpg', $relPath) ?? $relPath;
        $tmpOut = self::dataDir() . '/' . $newRel . '.tmp';
        $ok = imagejpeg($dst, $tmpOut, 85);
        imagedestroy($dst);
        if (!$ok) {
            @unlink($tmpOut);
            return [$relPath, $mime];
        }
        // Issue #10: keep the untouched upload for repeat testing. "Untouched"
        // means unresized — it has still had its metadata stripped above, so
        // the corpus keeps its value without keeping anyone's GPS fix.
        $origRel = preg_replace('/\.([a-z]+)$/', '.orig.$1', $relPath) ?? $relPath;
        @rename($path, self::dataDir() . '/' . $origRel);
        rename($tmpOut, self::dataDir() . '/' . $newRel);
        return [$newRel, 'image/jpeg'];
    }

    /** @return array{path: string, mime: string, groupId: string} */
    /**
     * Re-run the parser on an already-stored receipt image (no re-upload:
     * the photo is retained per issue #10). Updates the stored parse and
     * returns the same shape as ingest().
     *
     * @return array<string,mixed>
     */
    /**
     * Re-run the parser on the stored photo. Also how a QUEUED scan is
     * collected: the client that was handed a ticket calls this with it when
     * told to, and either gets its turn (a real parse) or a refreshed place in
     * line. `$charge` is the FR-4.5 cost guard, applied only when a parse
     * actually happens — asking "is it my turn yet?" must not eat the day's
     * scans.
     *
     * @param ?callable(): void $charge
     * @return array<string,mixed>
     */
    public function rescan(string $receiptId, string $userId, string $currencyHint = '', ?string $ticket = null, ?callable $charge = null): array
    {
        $currencyHint = preg_match('/^[A-Z]{3}$/', $currencyHint) ? $currencyHint : '';
        $stmt = $this->pdo->prepare('SELECT id, group_id, image_path FROM receipts WHERE id = ?');
        $stmt->execute([$receiptId]);
        $r = $stmt->fetch();
        if (!$r) {
            throw new ApiException('NOT_FOUND', 'receipt not found', 404);
        }
        $path = self::dataDir() . '/' . $r['image_path'];
        if (!is_file($path)) {
            throw new ApiException('NOT_FOUND', 'the stored receipt photo is missing', 404);
        }
        $ext = pathinfo($r['image_path'], PATHINFO_EXTENSION);
        $mime = array_search($ext === 'jpg' ? 'jpg' : $ext, self::MIME_EXT, true) ?: 'image/jpeg';

        $queue = new ScanQueue($this->pdo);
        $admission = $queue->admit($receiptId, $userId, $ticket, self::eta($this->pdo)['typicalMs']);
        if ($admission['queued'] !== null) {
            return self::queuedResult($receiptId, (string) $r['group_id'], $admission['queued']);
        }

        $parsed = null;
        $parseError = null;
        $t0 = microtime(true);
        try {
            if ($charge !== null) {
                $charge();
            }
            $parsed = $this->parse($path, $mime, $currencyHint);
            @file_put_contents(
                self::dataDir() . '/' . preg_replace('/\.[a-z]+$/', '.parse.json', $r['image_path']),
                json_encode($parsed, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR),
            );
            $this->pdo->prepare('UPDATE receipts SET parsed = ? WHERE id = ?')
                ->execute([json_encode($parsed, JSON_THROW_ON_ERROR), $receiptId]);
        } catch (\Throwable $e) {
            $parseError = $e instanceof ApiException
                ? $e->getMessage()
                : (str_contains($e->getMessage(), 'unreachable')
                    ? 'the receipt reader is offline right now — try Rescan later'
                    : 'could not read this receipt');
            error_log('receipt rescan failed: ' . $e->getMessage());
        } finally {
            $queue->release($admission['slot']);
        }
        $this->recordMetrics([
            'receipt_id' => $receiptId,
            'group_id' => $r['group_id'],
            'upload_bytes' => (int) (filesize($path) ?: 0),
            'normalized_bytes' => (int) (filesize($path) ?: 0),
            'normalize_ms' => 0,
            'engine' => $this->engineName(),
            'parse_ms' => (int) round((microtime(true) - $t0) * 1000),
            'outcome' => $parsed !== null ? 'rescanned' : 'rescan_failed',
            'confidence' => $parsed['confidence'] ?? null,
            'error' => $parseError,
        ]);

        $out = ['id' => $receiptId, 'groupId' => $r['group_id'], 'parsed' => $parsed];
        if ($parseError !== null) {
            $out['parseError'] = $parseError;
        }
        return $out;
    }

    public function imageFile(string $receiptId): array
    {
        $stmt = $this->pdo->prepare('SELECT group_id, image_path FROM receipts WHERE id = ?');
        $stmt->execute([$receiptId]);
        $r = $stmt->fetch();
        if (!$r) {
            throw new ApiException('NOT_FOUND', 'receipt not found', 404);
        }
        $ext = pathinfo($r['image_path'], PATHINFO_EXTENSION);
        $mime = array_search($ext === 'jpg' ? 'jpg' : $ext, self::MIME_EXT, true) ?: 'image/jpeg';
        return ['path' => self::dataDir() . '/' . $r['image_path'], 'mime' => $mime, 'groupId' => $r['group_id']];
    }

    /**
     * Itemize the receipt. Engine order (RECEIPT_ENGINE=auto): the local
     * vision model on our own hardware first (photos never leave home),
     * Claude only when explicitly configured. Both paths emit the same
     * shape: integer minor units + a deterministic confidence.
     *
     * @return array<string,mixed>
     */
    private function parse(string $path, string $mime, string $currencyHint = ''): array
    {
        $engine = Env::get('RECEIPT_ENGINE', 'auto');
        $localUrl = Env::get('LOCAL_LLM_URL');
        $claudeKey = Env::get('ANTHROPIC_API_KEY');

        if ($engine === 'local' || ($engine === 'auto' && $localUrl !== '')) {
            return $this->parseLocal($path, $mime, $localUrl, $currencyHint);
        }
        if ($engine === 'claude' || ($engine === 'auto' && $claudeKey !== '')) {
            return $this->parseClaude($path, $mime, $claudeKey, $currencyHint);
        }
        throw new ApiException('RECEIPT_PARSING_UNAVAILABLE', 'receipt scanning is not configured on this server', 503);
    }

    /**
     * The headers that get a request past everything standing in front of the
     * model. Both credentials are optional, so a dev box talking straight to
     * its own Ollama sends neither and behaves exactly as it always did.
     *
     * Two doors since #124: Cloudflare Access at the edge of the tunnel that
     * publishes the model host, which checks a service token; then SlyTab's
     * own nginx front door (#119), which checks a bearer token. Ollama has no
     * authentication of its own, so all of the protection is out here — the
     * same pattern SlyTesla uses for its own hostname.
     *
     * @return list<string>
     */
    private static function localHeaders(): array
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
     * An unreadable merchant is null, never "".
     *
     * The model does return an empty string — a real scan on 2026-09-03 came
     * back `merchant: ""` — and an empty string is a *present* value where a
     * null is an absent one. It defeats every `?? 'Receipt'` fallback in both
     * clients, and lands in the expense form as a description that looks
     * filled in behind its placeholder and is not, which is how a user ends up
     * with a Save button that will not go.
     */
    private static function normalizeMerchant(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $name = trim($raw);
        return $name === '' ? null : mb_substr($name, 0, 120);
    }

    /**
     * Nothing between us and the model answers in JSON when it says no — every
     * layer has its own status code and its own error page — so a refusal read
     * as a parse becomes a JsonException about a syntax error at offset 0,
     * which names neither the layer nor the fix. This sorts them out and hands
     * back the exception to throw, or null when the body really is the model's
     * answer.
     *
     * Four kinds, because four different things are wrong and three different
     * people fix them:
     *
     *   403 / 30x  Cloudflare Access, before the request reaches the house at
     *              all: the service token is wrong, expired or out of the
     *              policy. HTML, or a redirect to its login page.
     *   401        SlyTab's own front door (#119): `LOCAL_LLM_TOKEN` against
     *              the door's `token` file. The single word `unauthorized`.
     *   429 / 503  The door's rate limiter (`limit_req`, 60 r/m on one shared
     *              bucket — every request arrives from cloudflared on
     *              127.0.0.1, so it is one bucket for everybody). This is the
     *              reader being BUSY, not broken, and the difference matters to
     *              the person holding the phone: "try again in a moment" is
     *              true and "enter the details manually" is not. Measured
     *              2026-09-04: 12 requests at once, one came back 503.
     *   502 / 504  No backend serving, or the gateway gave up. That is the
     *              reader being offline; `unreachable` in the message is what
     *              both callers match on to say so and offer Rescan.
     *
     * Only the busy case reaches the user as itself, as an ApiException the
     * callers pass through. The rest are for `error_log` and whoever reads it:
     * an auth failure shuts `ScanAvailabilityService` too, so the scan buttons
     * are already disabled before a photo is taken (#123).
     */
    private static function refusal(int $code, string $raw): ?\Throwable
    {
        if ($code === 403 || ($code >= 300 && $code < 400)) {
            return new \RuntimeException(sprintf(
                'Cloudflare Access refused the request (HTTP %d) — check %s / %s, '
                . 'and that the service token is still in the Access policy',
                $code,
                'LOCAL_LLM_CF_ACCESS_ID',
                'LOCAL_LLM_CF_ACCESS_SECRET',
            ));
        }
        if ($code === 401 || trim($raw) === 'unauthorized') {
            // The front door answered, the token did not match. Worth its own
            // message: everything else here means "the model struggled", and
            // this means nobody has updated LOCAL_LLM_TOKEN.
            return new \RuntimeException('local model refused the token — check LOCAL_LLM_TOKEN');
        }
        if ($code === 429 || $code === 503) {
            return new ApiException(
                'SCAN_BUSY',
                'the receipt reader is busy right now — the photo is attached, try Rescan in a moment',
                429,
            );
        }
        if ($code === 502 || $code === 504) {
            return new \RuntimeException(
                "local model unreachable: the front door answered {$code} — no backend is serving",
            );
        }
        return null;
    }

    /**
     * Local vision model via Ollama (default qwen2.5vl:7b). The model
     * transcribes amounts as printed TEXT, separators and all; the server
     * turns that into minor units using the currency's rules and recomputes
     * confidence — no model arithmetic, and no model guessing at locales
     * (it got Chilean grouping wrong even when told, issue #75).
     *
     * @return array<string,mixed>
     */
    private function parseLocal(string $path, string $mime, string $baseUrl, string $currencyHint = ''): array
    {
        $body = json_encode([
            'model' => Env::get('LOCAL_LLM_MODEL', 'qwen2.5vl:7b'),
            'stream' => false,
            // Pin the model in memory. A cold load adds ~20s, pushing the
            // synchronous upload+parse response past the shared host's ~30s
            // limit — the client then reports a network failure even though
            // the parse completed (bug report 01KYDXM6JR, 2026-07-26).
            // Warm scans (~3-6s) stay far under it.
            'keep_alive' => -1,
            'format' => self::localSchema(),
            'options' => ['temperature' => 0],
            'messages' => [[
                'role' => 'user',
                'content' => 'Transcribe this receipt into JSON. Every amount is a STRING '
                    . 'copied CHARACTER FOR CHARACTER as printed, keeping its separators '
                    . 'and dropping only the currency symbol: "$4.240" → "4.240", '
                    . '"12,50" → "12,50", "$1,234.56" → "1234.56" is WRONG, it is '
                    . '"1,234.56". Do not convert, round, reformat or interpret the '
                    . 'separators — we decide what they mean from the currency. If an '
                    . 'amount is unreadable use null. quantity is the item count '
                    . '(default 1; may be fractional for weighed goods). date is '
                    . 'YYYY-MM-DD; currency is the 3-letter code'
                    . ($currencyHint !== ''
                        ? " (if the symbol is ambiguous, e.g. just '\$', the buyer expects {$currencyHint})"
                        : '')
                    . '; currencyExplicit is true ONLY when the receipt itself pins the '
                    . 'currency down — a 3-letter code, a currency name like "pesos '
                    . 'chilenos", or a symbol used by one single currency (€, £, ₹). A '
                    . 'bare "$" or "peso" fits many currencies, so currencyExplicit is '
                    . 'false even if you can guess'
                    . '. A "suggested tip"/"Tip 10%"/"propina sugerida" line printed near '
                    . 'the total is tip, never tax. Loyalty/rewards lines ("credits earned", '
                    . 'points, cashback, "Uber One credits") are NOT items and NOT part of '
                    . 'the bill — omit them entirely, even when they show an amount. '
                    . 'Use null for anything unreadable.',
                'images' => [base64_encode(file_get_contents($path))],
            ]],
        ], JSON_THROW_ON_ERROR);

        // The house Ollama has no authentication of its own and is published
        // to the internet, so SlyTab does not talk to it directly: it talks
        // through Cloudflare Access and a token-checking front door. Both
        // credentials are optional — see localHeaders().
        $headers = array_merge(['Content-Type: application/json'], self::localHeaders());

        $ch = curl_init(rtrim($baseUrl, '/') . '/api/chat');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_TIMEOUT => (int) Env::get('LOCAL_LLM_TIMEOUT', '90'),
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw === false) {
            throw new \RuntimeException("local model unreachable: {$err}");
        }
        $refusal = self::refusal($code, (string) $raw);
        if ($refusal !== null) {
            throw $refusal;
        }
        $resp = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        if (isset($resp['error'])) {
            throw new \RuntimeException('local model error: ' . $resp['error']);
        }
        $doc = json_decode($resp['message']['content'], true, 16, JSON_THROW_ON_ERROR);

        $model = preg_match('/^[A-Z]{3}$/', (string) ($doc['currency'] ?? '')) ? $doc['currency'] : null;
        $currency = self::resolveCurrency($model, ($doc['currencyExplicit'] ?? null) === true, $currencyHint);
        $scale = \SlyTab\Support\Money::scale($currency ?? 'XXX');
        // Amounts arrive as printed text ("88.930"); the currency decides
        // whether a separator groups or divides (issue #75). Numbers are
        // still accepted so a model that ignores the schema, or a parse
        // stored before this change, keeps working.
        $toMinor = static fn(mixed $v): ?int => match (true) {
            is_string($v) => \SlyTab\Support\Money::parsePrinted($v, $currency ?? 'XXX'),
            is_numeric($v) => (int) round(((float) $v) * $scale),
            default => null,
        };
        $items = [];
        foreach (($doc['items'] ?? []) as $item) {
            $minor = $toMinor($item['total'] ?? null);
            if (!is_string($item['name'] ?? null) || $minor === null) {
                continue;
            }
            $items[] = [
                'name' => mb_substr($item['name'], 0, 120),
                'quantity' => is_numeric($item['quantity'] ?? null) ? (float) $item['quantity'] : 1.0,
                'totalMinor' => $minor,
            ];
        }

        $parsed = [
            'merchant' => self::normalizeMerchant($doc['merchant'] ?? null),
            'date' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($doc['date'] ?? '')) ? $doc['date'] : null,
            'currency' => $currency,
            // The scale the *Minor fields are written in. With no currency
            // this is a guess (100) — clients MUST rescale via this field
            // once a currency is known (the Boragó 100x bug).
            'scale' => $scale,
            'items' => $items,
            'subtotalMinor' => $toMinor($doc['subtotal'] ?? null),
            'taxMinor' => $toMinor($doc['tax'] ?? null),
            'tipMinor' => $toMinor($doc['tip'] ?? null),
            'totalMinor' => $toMinor($doc['total'] ?? null),
        ];
        $parsed['confidence'] = self::deriveConfidence($parsed);
        return $parsed;
    }

    /**
     * Deterministic confidence: FR-4.1's 2% reconciliation check computed
     * here rather than trusting model self-assessment.
     *
     * @param array<string,mixed> $p
     */
    private static function deriveConfidence(array $p): string
    {
        if ($p['items'] === [] || $p['totalMinor'] === null || $p['totalMinor'] <= 0) {
            return 'low';
        }
        $base = array_sum(array_column($p['items'], 'totalMinor')) + ($p['taxMinor'] ?? 0);
        // Pre-cuenta receipts print a suggested tip that is NOT in the
        // total — score whichever interpretation reconciles better.
        $delta = min(
            abs($base + ($p['tipMinor'] ?? 0) - $p['totalMinor']),
            abs($base - $p['totalMinor']),
        ) / $p['totalMinor'];
        return $delta <= 0.0001 ? 'high' : ($delta <= 0.02 ? 'medium' : 'low');
    }

    /**
     * Pick the receipt currency. A currency the model actually read off the
     * paper still wins (FR-4), but the caller's hint — the EXIF-GPS country
     * when available, else the buyer's chosen currency — outranks a model
     * *guess*: a Chilean "$"-only receipt came back ARS over a correct CLP
     * hint (report 01KYFV22E099CMFNW7867SW0FV).
     */
    public static function resolveCurrency(?string $modelCurrency, bool $explicit, string $hint): ?string
    {
        if ($modelCurrency !== null && ($explicit || $hint === '')) {
            return $modelCurrency;
        }
        return $hint !== '' ? $hint : $modelCurrency;
    }

    /** @return array<string,mixed> decimal-dollars schema for the local model */
    /**
     * Amounts come back as STRINGS, exactly as printed on the paper.
     *
     * They used to be JSON numbers, which silently destroyed the one clue
     * that tells a thousands separator from a decimal point: "88.930" and
     * "88.93" are the same number, so a Chilean receipt for 88,930 pesos
     * arrived as 88.93 and stored as 89 (issue #75). Keeping the printed
     * text lets Money::parsePrinted() decide, with the currency in hand.
     */
    private static function localSchema(): array
    {
        $nullableAmount = ['type' => ['string', 'null']];
        return [
            'type' => 'object',
            'properties' => [
                'merchant' => ['type' => ['string', 'null']],
                'date' => ['type' => ['string', 'null']],
                'currency' => ['type' => ['string', 'null']],
                'currencyExplicit' => ['type' => 'boolean'],
                'items' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'name' => ['type' => 'string'],
                            'quantity' => ['type' => 'number'],
                            'total' => ['type' => 'string'],
                        ],
                        'required' => ['name', 'quantity', 'total'],
                    ],
                ],
                'subtotal' => $nullableAmount,
                'tax' => $nullableAmount,
                'tip' => $nullableAmount,
                'total' => $nullableAmount,
            ],
            'required' => ['merchant', 'date', 'currency', 'currencyExplicit', 'items', 'subtotal', 'tax', 'tip', 'total'],
        ];
    }

    /**
     * Claude API fallback engine — strict JSON schema, minor units native.
     *
     * @return array<string,mixed>
     */
    private function parseClaude(string $path, string $mime, string $apiKey, string $currencyHint = ''): array
    {
        if ($apiKey === '') {
            throw new ApiException('RECEIPT_PARSING_UNAVAILABLE', 'receipt scanning is not configured on this server', 503);
        }

        $client = new \Anthropic\Client(apiKey: $apiKey);
        $message = $client->messages->create(
            model: self::CLAUDE_MODEL,
            maxTokens: 8192,
            messages: [[
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'image',
                        'source' => [
                            'type' => 'base64',
                            'mediaType' => $mime,
                            'data' => base64_encode(file_get_contents($path)),
                        ],
                    ],
                    [
                        'type' => 'text',
                        'text' => 'Itemize this receipt. All monetary values are integer minor units '
                            . 'of the receipt currency — cents for 2-decimal currencies, whole units '
                            . 'for zero-decimal ones (JPY, KRW, VND, CLP, ISK, HUF). Use null for '
                            . 'anything unreadable. Loyalty/rewards lines ("credits earned", points, '
                            . 'cashback) are NOT items and NOT part of the bill — omit them. '
                            . 'quantity may be fractional (weighed goods). '
                            . 'confidence is "low" when items+tax+tip differ from the total by more '
                            . 'than 2%. currencyExplicit is true ONLY when the receipt itself pins '
                            . 'the currency down — a 3-letter code, a currency name like "pesos '
                            . 'chilenos", or a symbol used by one single currency (€, £, ₹); a bare '
                            . '"$" or "peso" fits many currencies, so it is false even if you can guess.'
                            . ($currencyHint !== ''
                                ? " If the currency symbol is ambiguous (e.g. just '\$'), the buyer expects {$currencyHint}."
                                : ''),
                    ],
                ],
            ]],
            outputConfig: [
                'format' => [
                    'type' => 'json_schema',
                    'schema' => self::receiptSchema(),
                ],
            ],
        );

        if ($message->stopReason !== 'end_turn') {
            throw new \RuntimeException("unexpected stop_reason: {$message->stopReason}");
        }
        foreach ($message->content as $block) {
            if ($block->type === 'text') {
                $doc = json_decode($block->text, true, 16, JSON_THROW_ON_ERROR);
                $model = preg_match('/^[A-Z]{3}$/', (string) ($doc['currency'] ?? '')) ? $doc['currency'] : null;
                $currency = self::resolveCurrency($model, ($doc['currencyExplicit'] ?? null) === true, $currencyHint);
                unset($doc['currencyExplicit']);
                $doc['currency'] = $currency;
                $doc['scale'] = \SlyTab\Support\Money::scale($currency ?? 'XXX');
                return $doc;
            }
        }
        throw new \RuntimeException('no text block in Claude response');
    }

    /** @return array<string,mixed> */
    private static function receiptSchema(): array
    {
        $nullableInt = ['type' => ['integer', 'null']];
        return [
            'type' => 'object',
            'properties' => [
                'merchant' => ['type' => ['string', 'null']],
                'date' => ['type' => ['string', 'null']],
                'currency' => ['type' => ['string', 'null']],
                'currencyExplicit' => ['type' => 'boolean'],
                'items' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'name' => ['type' => 'string'],
                            'quantity' => ['type' => 'number'],
                            'totalMinor' => ['type' => 'integer'],
                        ],
                        'required' => ['name', 'quantity', 'totalMinor'],
                        'additionalProperties' => false,
                    ],
                ],
                'subtotalMinor' => $nullableInt,
                'taxMinor' => $nullableInt,
                'tipMinor' => $nullableInt,
                'totalMinor' => $nullableInt,
                'confidence' => ['type' => 'string', 'enum' => ['high', 'medium', 'low']],
            ],
            'required' => ['merchant', 'date', 'currency', 'currencyExplicit', 'items', 'subtotalMinor', 'taxMinor', 'tipMinor', 'totalMinor', 'confidence'],
            'additionalProperties' => false,
        ];
    }

    /**
     * Drop the unresized originals for groups that have settled up.
     *
     * normalizeImage() keeps a `.orig.*` alongside every downscaled upload for
     * the issue-#10 repeat-parse corpus. Measured on production: 331 KB each,
     * about a quarter of all receipt bytes, against 1,018 MB of remaining disk
     * quota — roughly 2,300 uploads of headroom in total.
     *
     * Owner's rule (2026-08-02): once a group has settled, the compressed
     * image is enough. The corpus only needs originals while a parse might
     * still be argued about, and nobody argues about a bill that is paid.
     *
     * "Settled" means every net balance in the group is zero — the same
     * question the app answers on the Balances tab, not a proxy for it. A
     * group with no expenses at all is not settled, it is empty, and its
     * receipts are left alone.
     *
     * The served image is never touched. Losing an original costs the test
     * corpus one sample; losing the served image would take a receipt away
     * from the person who photographed it.
     *
     * @return array{groups:int, files:int, bytes:int, dryRun:bool}
     */
    public function pruneSettledOriginals(BalanceService $balances, bool $dryRun = false): array
    {
        $groups = $this->pdo->query(
            'SELECT DISTINCT r.group_id FROM receipts r'
        )->fetchAll(PDO::FETCH_COLUMN);

        $settled = 0;
        $files = 0;
        $bytes = 0;
        foreach ($groups as $groupId) {
            $net = $balances->forGroup((string) $groupId)['net'] ?? [];
            if ($net === [] || array_filter($net, static fn(int $v): bool => $v !== 0) !== []) {
                continue;
            }
            $settled++;
            $dir = self::dataDir() . "/receipts/{$groupId}";
            foreach (glob("{$dir}/*.orig.*") ?: [] as $path) {
                $size = (int) (@filesize($path) ?: 0);
                if ($dryRun || @unlink($path)) {
                    $files++;
                    $bytes += $size;
                }
            }
        }
        return ['groups' => $settled, 'files' => $files, 'bytes' => $bytes, 'dryRun' => $dryRun];
    }

    private static function dataDir(): string
    {
        return rtrim(Env::get('DATA_DIR', dirname(__DIR__, 3) . '/slytab-data'), '/');
    }
}
