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
 * endpoints.
 *
 * Issue #133: each report is then handed to the shared Electric RV support
 * intake as one email in the support convention (subject, header block,
 * screenshot attached, Reply-To the reporter). That system triages it, a
 * person decides, and it sends the reporter the reply. SlyTab no longer
 * files GitHub issues for reports or emails a resolution; it sends only the
 * instant receipt.
 */
final class BugReportService
{
    private const MAX_BYTES = 25 * 1024 * 1024;
    private const MIME_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

    /**
     * The support convention's reference alphabet: no B, I, O, S or Z and
     * only the digits 3 4 6 7 9, so a reference read aloud or retyped from a
     * phone screen survives. The same alphabet MegaPDF's MP- references use.
     */
    private const REF_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';

    /**
     * A report the request itself failed to forward is retried by the cron,
     * but only once it is this old, so the cron never forwards a report the
     * request that created it is still forwarding.
     */
    private const RETRY_AFTER_SECONDS = 120;

    public function __construct(
        private readonly PDO $pdo,
        private readonly Mailer $mailer = new Mailer(),
    ) {}

    /** @return array{id:string, status:string, reference:string, tracking:string} */
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

        // A clash is one in 390,625 per day; a fresh draw settles it.
        for ($attempt = 0; ; $attempt++) {
            $reference = self::newReference();
            try {
                $this->pdo->prepare(
                    'INSERT INTO bug_reports (id, reference, user_id, message, context, image_path)
                     VALUES (?, ?, ?, ?, ?, ?)',
                )->execute([$id, $reference, $userId, $message, $context === '' ? null : $context, $imagePath]);
                break;
            } catch (\PDOException $e) {
                if (($e->errorInfo[1] ?? 0) !== 1062 || $attempt >= 5) { // duplicate key
                    throw $e;
                }
            }
        }

        $forwarded = $this->forward($id);

        $user = $this->pdo->prepare('SELECT display_name, email FROM users WHERE id = ?');
        $user->execute([$userId]);
        $u = $user->fetch() ?: ['display_name' => 'there', 'email' => ''];
        if ($u['email'] !== '') {
            // The one email SlyTab still sends about a report (owner, #133:
            // keep the receipt). The answer comes from Electric RV Support.
            $this->mailer->dispatch(
                $u['email'],
                "We got your SlyTab report — {$reference}",
                "Hi {$u['display_name']},\n\n"
                . "Thanks for the report! It's in as {$reference}.\n\n"
                . "What you told us:\n"
                . "  \"{$message}\"\n\n"
                . "Electric RV Support will reply to this address once someone has\n"
                . "looked at it. If you write to us about it, quote {$reference} so\n"
                . "it joins this report.\n\n"
                . "— The SlyTab team",
            );
        }

        return [
            'id' => $id,
            'status' => $forwarded ? 'seen' : 'new',
            'reference' => $reference,
            // The apps show `tracking` after sending. Same value under the
            // old key, so a phone on an older build shows the new reference.
            'tracking' => $reference,
        ];
    }

    /** `ST-YYMMDD-XXXX`, dated in UTC. */
    public static function newReference(): string
    {
        $tail = '';
        for ($i = 0; $i < 4; $i++) {
            $tail .= self::REF_ALPHABET[random_int(0, strlen(self::REF_ALPHABET) - 1)];
        }
        return 'ST-' . gmdate('ymd') . '-' . $tail;
    }

    /**
     * Hand one report to the support intake. True once the MTA accepted it;
     * the report is then marked forwarded and never sent again.
     */
    public function forward(string $bugId): bool
    {
        $stmt = $this->pdo->prepare(
            'SELECT b.reference, b.message, b.context, b.image_path, b.created_at, u.email
             FROM bug_reports b JOIN users u ON u.id = b.user_id
             WHERE b.id = ? AND b.forwarded_at IS NULL AND b.reference IS NOT NULL',
        );
        $stmt->execute([$bugId]);
        $r = $stmt->fetch();
        if (!$r) {
            return false;
        }
        $mail = self::supportMail($r);
        $attachments = [];
        if ($r['image_path'] !== null) {
            $ext = pathinfo((string) $r['image_path'], PATHINFO_EXTENSION);
            $attachments[] = [
                'path' => self::dataDir() . '/' . $r['image_path'],
                'name' => "{$r['reference']}-screenshot.{$ext}",
                'mime' => array_search($ext, self::MIME_EXT, true) ?: 'image/jpeg',
            ];
        }
        $ok = $this->mailer->dispatchMessage(
            Env::get('SUPPORT_INTAKE_EMAIL', 'support@electricrv.ca'),
            $mail['subject'],
            $mail['body'],
            $r['email'],
            $attachments,
        );
        if (!$ok) {
            // References only in the log, never the reporter's text.
            error_log("bug-report: support intake refused {$r['reference']}; the cron will retry");
            return false;
        }
        $this->pdo->prepare(
            "UPDATE bug_reports SET forwarded_at = NOW(), status = 'seen' WHERE id = ? AND forwarded_at IS NULL",
        )->execute([$bugId]);
        return true;
    }

    /**
     * Cron (bug-sync): forward every report the request could not. Safe to
     * run repeatedly.
     *
     * @return array{forwarded:int, pending:int}
     */
    public function forwardPending(): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id FROM bug_reports
             WHERE forwarded_at IS NULL AND reference IS NOT NULL
               AND created_at <= NOW() - INTERVAL ? SECOND
             ORDER BY created_at',
        );
        $stmt->bindValue(1, self::RETRY_AFTER_SECONDS, PDO::PARAM_INT);
        $stmt->execute();
        $forwarded = 0;
        $pending = 0;
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $this->forward((string) $id) ? $forwarded++ : $pending++;
        }
        return ['forwarded' => $forwarded, 'pending' => $pending];
    }

    /**
     * The email the support system parses (issue #133's convention, the
     * same shape as MegaPDF's): a subject carrying the reference and the
     * platform and kind tags, then a header block of `Label: value` lines,
     * then the reporter's words. The subject tags are a hint; the
     * `Reference:` line in the body is what a consumer falls back to.
     *
     * Kind is always `problem`: the only way in is "Report a bug".
     *
     * @param array{reference:string, message:string, context:?string, created_at:string} $r
     * @return array{subject:string, body:string}
     */
    public static function supportMail(array $r): array
    {
        $device = self::device((string) ($r['context'] ?? ''));
        $kind = 'problem';
        $subject = "SlyTab support {$r['reference']}"
            . ($device['platform'] !== null ? " [{$device['platform']}]" : '')
            . " [{$kind}]";
        $platformLine = $device['platform'] === null
            ? '(not given)'
            : $device['platform'] . ($device['os'] !== null ? " — {$device['os']}" : '');
        $body = "Reference: {$r['reference']}\n"
            . 'App: ' . ($device['app'] ?? 'SlyTab (version not given)') . "\n"
            . "Platform: {$platformLine}\n"
            . "Kind: {$kind}\n"
            . "\n"
            . "What happened\n"
            . trim($r['message']) . "\n"
            . "\n"
            . "Sent from the app's Report a bug form at {$r['created_at']} UTC.\n"
            . ($device['diagnostics'] !== '' ? "Diagnostics: {$device['diagnostics']}\n" : '');
        return ['subject' => $subject, 'body' => $body];
    }

    /**
     * Read the context string the apps attach:
     *   mobile: `mobile ios 18.2 app v1.2.1(18) | recent API errors: …`
     *   web:    `web <user agent>`
     *
     * @return array{platform:?string, os:?string, app:?string, diagnostics:string}
     */
    private static function device(string $context): array
    {
        if (preg_match('/^mobile (ios|android) (\S+) app v([^\s(]+)\(([^)]*)\)\s*(?:\|\s*(.*))?$/s', $context, $m) === 1) {
            $platform = $m[1] === 'ios' ? 'iOS' : 'Android';
            $build = $m[4] !== '' && $m[4] !== '?' ? " ({$m[4]})" : '';
            return [
                'platform' => $platform,
                // Android reports its API level, not the release number.
                'os' => $m[1] === 'ios' ? "iOS {$m[2]}" : "Android API {$m[2]}",
                'app' => $m[3] === '?' ? null : "SlyTab {$m[3]}{$build}",
                'diagnostics' => trim($m[5] ?? ''),
            ];
        }
        if (str_starts_with($context, 'web')) {
            return ['platform' => 'web', 'os' => null, 'app' => 'SlyTab web', 'diagnostics' => trim(substr($context, 3))];
        }
        return ['platform' => null, 'os' => null, 'app' => null, 'diagnostics' => $context];
    }

    /** Newest-first listing for the internal review endpoint. @return array<int,array<string,mixed>> */
    public function listRecent(int $limit = 50): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT b.id, b.reference, b.message, b.context, b.image_path IS NOT NULL AS has_image, b.status,
                    b.issue_number, b.forwarded_at, b.created_at, u.display_name, u.email
             FROM bug_reports b JOIN users u ON u.id = b.user_id
             ORDER BY b.created_at DESC LIMIT ?',
        );
        $stmt->bindValue(1, $limit, PDO::PARAM_INT);
        $stmt->execute();
        return array_map(static fn(array $r): array => [
            'id' => $r['id'],
            'reference' => $r['reference'],
            'from' => ['displayName' => $r['display_name'], 'email' => $r['email']],
            'message' => $r['message'],
            'context' => $r['context'],
            'hasImage' => (bool) $r['has_image'],
            'status' => $r['status'],
            'forwardedAt' => $r['forwarded_at'],
            'issueNumber' => $r['issue_number'] === null ? null : (int) $r['issue_number'],
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
