<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use Psr\Http\Message\UploadedFileInterface;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;
use SlyTab\Support\Ulid;

/**
 * In-app bug reports (profile page): a comment plus an optional
 * screenshot, stored like receipts (image in DATA_DIR, row in MySQL) so
 * the reviewer sees both together via the token-guarded internal
 * endpoints. If BUG_REPORT_EMAIL is configured the owner also gets an
 * email heads-up; mail failure never loses the report.
 */
final class BugReportService
{
    private const MAX_BYTES = 25 * 1024 * 1024;
    private const MIME_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

    public function __construct(
        private readonly PDO $pdo,
        private readonly Mailer $mailer = new Mailer(),
    ) {}

    /** @return array{id:string, status:string} */
    public function report(string $userId, string $message, string $context, ?UploadedFileInterface $image): array
    {
        $message = trim($message);
        if ($message === '') {
            throw new ApiException('VALIDATION', 'describe the bug in a sentence or two');
        }
        $message = mb_substr($message, 0, 2000);
        $context = mb_substr(trim($context), 0, 500);

        $id = Ulid::generate();
        $imagePath = null;
        if ($image !== null) {
            if ($image->getError() !== UPLOAD_ERR_OK) {
                throw new ApiException('VALIDATION', 'screenshot upload failed');
            }
            if ($image->getSize() === null || $image->getSize() > self::MAX_BYTES) {
                throw new ApiException('VALIDATION', 'screenshot must be 25 MB or smaller', 413);
            }
            $mime = $image->getClientMediaType() ?? '';
            if (!isset(self::MIME_EXT[$mime])) {
                throw new ApiException('VALIDATION', 'screenshot must be JPEG, PNG, or WebP');
            }
            $dir = self::dataDir() . '/bugs';
            if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
                throw new \RuntimeException("cannot create bug report directory {$dir}");
            }
            $imagePath = 'bugs/' . $id . '.' . self::MIME_EXT[$mime];
            $image->moveTo(self::dataDir() . '/' . $imagePath);
        }

        $this->pdo->prepare(
            'INSERT INTO bug_reports (id, user_id, message, context, image_path) VALUES (?, ?, ?, ?, ?)',
        )->execute([$id, $userId, $message, $context === '' ? null : $context, $imagePath]);

        $notify = Env::get('BUG_REPORT_EMAIL');
        if ($notify !== '') {
            $user = $this->pdo->prepare('SELECT display_name, email FROM users WHERE id = ?');
            $user->execute([$userId]);
            $u = $user->fetch() ?: ['display_name' => 'unknown', 'email' => 'unknown'];
            $this->mailer->dispatch(
                $notify,
                "SlyTab bug report from {$u['display_name']}",
                "{$u['display_name']} <{$u['email']}> reports:\n\n{$message}\n\n"
                . ($context !== '' ? "Context: {$context}\n" : '')
                . ($imagePath !== null ? "Screenshot attached — review at /api/internal/bugs (report {$id}).\n" : '')
                . "\nReport id: {$id}",
            );
        }

        return ['id' => $id, 'status' => 'new'];
    }

    /** Newest-first listing for the internal review endpoint. @return array<int,array<string,mixed>> */
    public function listRecent(int $limit = 50): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT b.id, b.message, b.context, b.image_path IS NOT NULL AS has_image, b.status,
                    b.created_at, u.display_name, u.email
             FROM bug_reports b JOIN users u ON u.id = b.user_id
             ORDER BY b.created_at DESC LIMIT ?',
        );
        $stmt->bindValue(1, $limit, PDO::PARAM_INT);
        $stmt->execute();
        return array_map(static fn(array $r): array => [
            'id' => $r['id'],
            'from' => ['displayName' => $r['display_name'], 'email' => $r['email']],
            'message' => $r['message'],
            'context' => $r['context'],
            'hasImage' => (bool) $r['has_image'],
            'status' => $r['status'],
            'createdAt' => $r['created_at'],
        ], $stmt->fetchAll());
    }

    /** @return array{path:string, mime:string} */
    public function imageFile(string $bugId): array
    {
        $stmt = $this->pdo->prepare('SELECT image_path FROM bug_reports WHERE id = ?');
        $stmt->execute([$bugId]);
        $path = $stmt->fetchColumn();
        if ($path === false || $path === null) {
            throw new ApiException('NOT_FOUND', 'no screenshot on this report', 404);
        }
        $ext = pathinfo((string) $path, PATHINFO_EXTENSION);
        $mime = array_search($ext, self::MIME_EXT, true) ?: 'image/jpeg';
        return ['path' => self::dataDir() . '/' . $path, 'mime' => $mime];
    }

    private static function dataDir(): string
    {
        return rtrim(Env::get('DATA_DIR', dirname(__DIR__, 3) . '/slytab-data'), '/');
    }
}
