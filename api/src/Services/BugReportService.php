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

        $user = $this->pdo->prepare('SELECT display_name, email FROM users WHERE id = ?');
        $user->execute([$userId]);
        $u = $user->fetch() ?: ['display_name' => 'unknown', 'email' => 'unknown'];

        $notify = Env::get('BUG_REPORT_EMAIL');
        if ($notify !== '') {
            $this->mailer->dispatch(
                $notify,
                "SlyTab bug report from {$u['display_name']}",
                "{$u['display_name']} <{$u['email']}> reports:\n\n{$message}\n\n"
                . ($context !== '' ? "Context: {$context}\n" : '')
                . ($imagePath !== null ? "Screenshot attached — review at /api/internal/bugs (report {$id}).\n" : '')
                . "\nReport id: {$id}",
            );
        }

        // Issues #25 + #34: immediate acknowledgment with a tracking number.
        $tracking = self::trackingCode($id);
        $this->mailer->dispatch(
            $u['email'],
            "We got your SlyTab report — {$tracking}",
            "Hi {$u['display_name']},\n\n"
            . "Thanks for the report! It's in our queue as {$tracking}.\n\n"
            . "What you told us:\n"
            . "  \"{$message}\"\n\n"
            . "We'll email you at this address as soon as it's fixed, with what\n"
            . "changed and how to pick up the update.\n\n"
            . "— The SlyTab team",
        );

        return ['id' => $id, 'status' => 'new', 'tracking' => $tracking];
    }

    /** Issue #34: short human-friendly tracking ref, stable per report. */
    public static function trackingCode(string $bugId): string
    {
        return 'SLY-' . substr($bugId, -6);
    }

    /** Issue #25: remember which GitHub issue tracks this report. */
    public function linkIssue(string $bugId, int $issueNumber): void
    {
        $this->pdo->prepare('UPDATE bug_reports SET issue_number = ? WHERE id = ?')
            ->execute([$issueNumber, $bugId]);
    }

    /**
     * Issue #25: …and hears back again when the issue closes. Marks the
     * report closed; safe to call once per report.
     */
    public function closeAndNotify(string $bugId, string $resolution = ''): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT b.message, b.status, b.context, b.issue_number, u.display_name, u.email
             FROM bug_reports b JOIN users u ON u.id = b.user_id WHERE b.id = ?',
        );
        $stmt->execute([$bugId]);
        $r = $stmt->fetch();
        if (!$r) {
            throw new ApiException('NOT_FOUND', 'bug report not found', 404);
        }
        if ($r['status'] !== 'closed') {
            $this->pdo->prepare("UPDATE bug_reports SET status = 'closed' WHERE id = ?")->execute([$bugId]);
            $tracking = self::trackingCode($bugId);
            // Issues #34 + #38: plain, friendly, and strictly user-facing —
            // no GitHub links or internal jargon. Say what's fixed, then how
            // to pick it up on the platform they reported from.
            $howTo = str_starts_with((string) $r['context'], 'mobile')
                ? 'Update to the latest version of the SlyTab app to get the fix.'
                : 'Refresh SlyTab in your browser to get the fix (hold Shift and click reload if it looks unchanged).';
            $this->mailer->dispatch(
                $r['email'],
                "Fixed: your SlyTab report {$tracking}",
                "Hi {$r['display_name']},\n\n"
                . "Good news — the issue you reported is fixed and live.\n\n"
                . "Your report ({$tracking}):\n"
                . "  \"{$r['message']}\"\n\n"
                . ($resolution !== '' ? "What changed: {$resolution}\n\n" : '')
                . "{$howTo}\n\n"
                . "Thanks for helping make SlyTab better.\n\n"
                . "— The SlyTab team",
            );
        }
        return ['id' => $bugId, 'status' => 'closed'];
    }

    /** Newest-first listing for the internal review endpoint. @return array<int,array<string,mixed>> */
    public function listRecent(int $limit = 50): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT b.id, b.message, b.context, b.image_path IS NOT NULL AS has_image, b.status,
                    b.issue_number, b.created_at, u.display_name, u.email
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
            'issueNumber' => $r['issue_number'] === null ? null : (int) $r['issue_number'],
            'createdAt' => $r['created_at'],
        ], $stmt->fetchAll());
    }

    /**
     * Durable feedback pipeline (server cron / internal endpoint): file a
     * GitHub issue for every new report, and email the reporter when a
     * previously filed issue has been closed. Safe to run repeatedly.
     * $http is injectable for tests: fn(method, url, ?body) => array.
     *
     * @param ?callable(string,string,?array):array $http
     * @return array{filed:int, notified:int, skipped:string}
     */
    public function syncGithub(?callable $http = null): array
    {
        $token = Env::get('BUG_GITHUB_TOKEN');
        $repo = Env::get('BUG_GITHUB_REPO', 'SlyWombat/SlyTab');
        if ($token === '' && $http === null) {
            return ['filed' => 0, 'notified' => 0, 'skipped' => 'BUG_GITHUB_TOKEN not configured'];
        }
        $http ??= static function (string $method, string $url, ?array $body) use ($token): array {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_TIMEOUT => 30,
                CURLOPT_USERAGENT => 'slytab-bug-sync',
                CURLOPT_HTTPHEADER => [
                    "Authorization: Bearer {$token}",
                    'Accept: application/vnd.github+json',
                    'Content-Type: application/json',
                ],
            ]);
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
            }
            $raw = curl_exec($ch);
            curl_close($ch);
            return is_string($raw) ? (json_decode($raw, true) ?: []) : [];
        };

        $filed = 0;
        $new = $this->pdo->query(
            "SELECT b.id, b.message, b.context, b.image_path IS NOT NULL AS has_image, b.created_at,
                    u.display_name
             FROM bug_reports b JOIN users u ON u.id = b.user_id
             WHERE b.status = 'new' ORDER BY b.created_at",
        )->fetchAll();
        foreach ($new as $r) {
            $firstLine = trim(explode("\n", trim($r['message']))[0]);
            $title = mb_strlen($firstLine) > 70 ? mb_substr($firstLine, 0, 67) . '...' : $firstLine;
            $quoted = '> ' . str_replace("\n", "\n> ", trim($r['message']));
            $body = "**In-app bug report** from **{$r['display_name']}** at {$r['created_at']} UTC (report `{$r['id']}`).\n\n"
                . "{$quoted}\n\n"
                . '- Context: `' . ($r['context'] ?: 'none') . "`\n"
                . '- Screenshot: ' . ($r['has_image']
                    ? "attached — review with `GET /api/internal/bugs/{$r['id']}/image` (X-Admin-Token)"
                    : 'none') . "\n\n"
                . "Filed automatically by the server-side feedback pipeline (FR-10.3).";
            $resp = $http('POST', "https://api.github.com/repos/{$repo}/issues",
                ['title' => "Bug report: {$title}", 'body' => $body, 'labels' => ['bug']]);
            if (isset($resp['number'])) {
                $this->pdo->prepare("UPDATE bug_reports SET status = 'seen', issue_number = ? WHERE id = ?")
                    ->execute([(int) $resp['number'], $r['id']]);
                $filed++;
            }
        }

        $notified = 0;
        $open = $this->pdo->query(
            "SELECT id, issue_number FROM bug_reports
             WHERE issue_number IS NOT NULL AND status <> 'closed'",
        )->fetchAll();
        foreach ($open as $r) {
            $issue = $http('GET', "https://api.github.com/repos/{$repo}/issues/{$r['issue_number']}", null);
            if (($issue['state'] ?? '') === 'closed') {
                // No resolution text here — the email stays link-free and
                // human (issue #38); a hand-written summary can still be
                // passed via the notify-closed endpoint when closing manually.
                $this->closeAndNotify($r['id'], '');
                $notified++;
                // Owner policy (issue #38 follow-on): once fixed, end-user
                // reports leave no public trace — delete the GitHub issue.
                // The full record stays in bug_reports.
                if (isset($issue['node_id'])) {
                    $http('POST', 'https://api.github.com/graphql', [
                        'query' => 'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }',
                        'variables' => ['id' => $issue['node_id']],
                    ]);
                }
            }
        }
        return ['filed' => $filed, 'notified' => $notified, 'skipped' => ''];
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
