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
    private const MAX_BYTES = 10 * 1024 * 1024;
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
            throw new ApiException('VALIDATION', 'image must be 10 MB or smaller', 413);
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
        $relPath = "receipts/{$groupId}/{$id}." . self::MIME_EXT[$mime];
        $file->moveTo(self::dataDir() . '/' . $relPath);

        $parsed = null;
        $parseError = null;
        try {
            $parsed = $this->parse(self::dataDir() . '/' . $relPath, $mime);
        } catch (\Throwable $e) {
            $parseError = $e instanceof ApiException ? $e->getMessage() : 'could not read this receipt';
            error_log('receipt parse failed: ' . $e->getMessage());
        }

        $this->pdo->prepare(
            'INSERT INTO receipts (id, group_id, image_path, parsed, created_by) VALUES (?, ?, ?, ?, ?)',
        )->execute([
            $id, $groupId, $relPath,
            $parsed === null ? null : json_encode($parsed, JSON_THROW_ON_ERROR),
            $userId,
        ]);

        $out = ['id' => $id, 'groupId' => $groupId, 'parsed' => $parsed];
        if ($parseError !== null) {
            $out['parseError'] = $parseError;
        }
        return $out;
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
     * Send the image to the Claude API with a strict JSON schema so the
     * result is guaranteed parseable (architecture §6).
     *
     * @return array<string,mixed>
     */
    private function parse(string $path, string $mime): array
    {
        $apiKey = Env::get('ANTHROPIC_API_KEY');
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
