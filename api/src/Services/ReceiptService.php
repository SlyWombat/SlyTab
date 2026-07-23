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
    public function ingest(string $groupId, string $userId, UploadedFileInterface $file): array
    {
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

        $parsed = null;
        $parseError = null;
        $t1 = microtime(true);
        try {
            $parsed = $this->parse(self::dataDir() . '/' . $relPath, $mime);
            // Issue #10: keep the raw parse for repeat testing (data dir only).
            @file_put_contents(
                self::dataDir() . '/' . preg_replace('/\.[a-z]+$/', '.parse.json', $relPath),
                json_encode($parsed, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR),
            );
        } catch (\Throwable $e) {
            $parseError = $e instanceof ApiException
                ? $e->getMessage()
                : (str_contains($e->getMessage(), 'unreachable')
                    ? 'the receipt reader is offline right now — the photo is attached, try Rescan later'
                    : 'could not read this receipt — the photo is attached, enter the details manually');
            error_log('receipt parse failed: ' . $e->getMessage());
        }
        $parseMs = (int) round((microtime(true) - $t1) * 1000);

        $this->pdo->prepare(
            'INSERT INTO receipts (id, group_id, image_path, parsed, created_by) VALUES (?, ?, ?, ?, ?)',
        )->execute([
            $id, $groupId, $relPath,
            $parsed === null ? null : json_encode($parsed, JSON_THROW_ON_ERROR),
            $userId,
        ]);
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
    private function normalizeImage(string $relPath, string $mime): array
    {
        $path = self::dataDir() . '/' . $relPath;
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
        // Issue #10: keep the untouched upload for repeat testing.
        $origRel = preg_replace('/\.([a-z]+)$/', '.orig.$1', $relPath) ?? $relPath;
        @rename($path, self::dataDir() . '/' . $origRel);
        rename($tmpOut, self::dataDir() . '/' . $newRel);
        return [$newRel, 'image/jpeg'];
    }

    /** @return array{path: string, mime: string, groupId: string} */
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
    private function parse(string $path, string $mime): array
    {
        $engine = Env::get('RECEIPT_ENGINE', 'auto');
        $localUrl = Env::get('LOCAL_LLM_URL');
        $claudeKey = Env::get('ANTHROPIC_API_KEY');

        if ($engine === 'local' || ($engine === 'auto' && $localUrl !== '')) {
            return $this->parseLocal($path, $mime, $localUrl);
        }
        if ($engine === 'claude' || ($engine === 'auto' && $claudeKey !== '')) {
            return $this->parseClaude($path, $mime, $claudeKey);
        }
        throw new ApiException('RECEIPT_PARSING_UNAVAILABLE', 'receipt scanning is not configured on this server', 503);
    }

    /**
     * Local vision model via Ollama (default qwen2.5vl:7b). The model
     * transcribes decimal amounts exactly as printed; we convert to minor
     * units and recompute confidence server-side — no model arithmetic.
     *
     * @return array<string,mixed>
     */
    private function parseLocal(string $path, string $mime, string $baseUrl): array
    {
        $body = json_encode([
            'model' => Env::get('LOCAL_LLM_MODEL', 'qwen2.5vl:7b'),
            'stream' => false,
            'format' => self::localSchema(),
            'options' => ['temperature' => 0],
            'messages' => [[
                'role' => 'user',
                'content' => 'Transcribe this receipt into JSON. Copy every amount as the '
                    . 'number printed on the receipt (e.g. 12.99); do not convert units. '
                    . 'CAREFUL with separators: in many countries "." or a space groups '
                    . 'thousands and "," is the decimal mark — e.g. Chilean "$4.240" means '
                    . 'four thousand two hundred forty pesos (output 4240), and "12,50" '
                    . 'means twelve and a half (output 12.5). quantity is the item count '
                    . '(default 1; may be fractional for weighed goods). date is '
                    . 'YYYY-MM-DD; currency is the 3-letter code. Use null for anything '
                    . 'unreadable.',
                'images' => [base64_encode(file_get_contents($path))],
            ]],
        ], JSON_THROW_ON_ERROR);

        $ch = curl_init(rtrim($baseUrl, '/') . '/api/chat');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_TIMEOUT => (int) Env::get('LOCAL_LLM_TIMEOUT', '90'),
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new \RuntimeException("local model unreachable: {$err}");
        }
        $resp = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        if (isset($resp['error'])) {
            throw new \RuntimeException('local model error: ' . $resp['error']);
        }
        $doc = json_decode($resp['message']['content'], true, 16, JSON_THROW_ON_ERROR);

        $currency = preg_match('/^[A-Z]{3}$/', (string) ($doc['currency'] ?? '')) ? $doc['currency'] : null;
        $scale = \SlyTab\Support\Money::scale($currency ?? 'XXX');
        $toMinor = static fn(mixed $v): ?int => is_numeric($v) ? (int) round(((float) $v) * $scale) : null;
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
            'merchant' => is_string($doc['merchant'] ?? null) ? mb_substr($doc['merchant'], 0, 120) : null,
            'date' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($doc['date'] ?? '')) ? $doc['date'] : null,
            'currency' => $currency,
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
        $sum = array_sum(array_column($p['items'], 'totalMinor'))
            + ($p['taxMinor'] ?? 0) + ($p['tipMinor'] ?? 0);
        $delta = abs($sum - $p['totalMinor']) / $p['totalMinor'];
        return $delta <= 0.0001 ? 'high' : ($delta <= 0.02 ? 'medium' : 'low');
    }

    /** @return array<string,mixed> decimal-dollars schema for the local model */
    private static function localSchema(): array
    {
        $nullableNumber = ['type' => ['number', 'null']];
        return [
            'type' => 'object',
            'properties' => [
                'merchant' => ['type' => ['string', 'null']],
                'date' => ['type' => ['string', 'null']],
                'currency' => ['type' => ['string', 'null']],
                'items' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'name' => ['type' => 'string'],
                            'quantity' => ['type' => 'number'],
                            'total' => ['type' => 'number'],
                        ],
                        'required' => ['name', 'quantity', 'total'],
                    ],
                ],
                'subtotal' => $nullableNumber,
                'tax' => $nullableNumber,
                'tip' => $nullableNumber,
                'total' => $nullableNumber,
            ],
            'required' => ['merchant', 'date', 'currency', 'items', 'subtotal', 'tax', 'tip', 'total'],
        ];
    }

    /**
     * Claude API fallback engine — strict JSON schema, minor units native.
     *
     * @return array<string,mixed>
     */
    private function parseClaude(string $path, string $mime, string $apiKey): array
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
                            . '(cents) of the receipt currency. Use null for anything unreadable. '
                            . 'quantity may be fractional (weighed goods). confidence is "low" when '
                            . 'items+tax+tip differ from the total by more than 2%.',
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
                return json_decode($block->text, true, 16, JSON_THROW_ON_ERROR);
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
            'required' => ['merchant', 'date', 'currency', 'items', 'subtotalMinor', 'taxMinor', 'tipMinor', 'totalMinor', 'confidence'],
            'additionalProperties' => false,
        ];
    }

    private static function dataDir(): string
    {
        return rtrim(Env::get('DATA_DIR', dirname(__DIR__, 3) . '/slytab-data'), '/');
    }
}
