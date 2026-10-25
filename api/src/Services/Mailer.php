<?php

declare(strict_types=1);

namespace SlyTab\Services;

use SlyTab\Support\Env;

/**
 * Outbound mail (verification, invites, resets). Production uses PHP
 * mail() through the cPanel MTA; anywhere mail() is unavailable or
 * MAIL_DISABLE is set the message is logged instead so flows stay
 * testable.
 *
 * The envelope sender (-f) is forced to the MAIL_FROM address so SPF is
 * evaluated against our own domain rather than the shared host's — the
 * domain's SPF record must therefore include this server (see issue #8).
 */
class Mailer // non-final: tests substitute a capturing subclass
{
    public function send(string $to, string $subject, string $body): void
    {
        if (!$this->dispatch($to, $subject, $body)) {
            error_log("mailer: mail() returned false for {$to}");
        }
    }

    /** Like send(), but reports whether the MTA accepted the hand-off. */
    public function dispatch(string $to, string $subject, string $body): bool
    {
        return $this->dispatchMessage($to, $subject, $body);
    }

    /**
     * The full form: an optional Reply-To and file attachments. Issue #133
     * needs both — the support intake replies to the reporter, not to us, and
     * the reporter's screenshot travels with the report.
     *
     * @param list<array{path:string, name:string, mime:string}> $attachments
     */
    public function dispatchMessage(
        string $to,
        string $subject,
        string $body,
        ?string $replyTo = null,
        array $attachments = [],
    ): bool {
        $from = Env::get('MAIL_FROM', 'SlyTab <noreply@electricrv.ca>');
        if (Env::get('MAIL_DISABLE') !== '' || !function_exists('mail')) {
            error_log("mailer (disabled): to={$to} subject={$subject}");
            return true;
        }
        $envelope = preg_match('/<([^>]+)>/', $from, $m) === 1 ? $m[1] : $from;
        [$headers, $body] = self::compose($from, $body, $replyTo, $attachments);
        // Suppress the warning mail() emits alongside returning false —
        // under php -S it would leak into the JSON response body.
        return @mail($to, $subject, $body, $headers, '-f' . $envelope);
    }

    /**
     * The headers and body mail() is handed. Separate so a test can check
     * the MIME without a mail server.
     *
     * @param list<array{path:string, name:string, mime:string}> $attachments
     * @return array{0:string, 1:string}
     */
    public static function compose(string $from, string $body, ?string $replyTo = null, array $attachments = []): array
    {
        $headers = "From: {$from}\r\nMIME-Version: 1.0";
        if ($replyTo !== null && $replyTo !== '') {
            // The address comes from a user's account. A line break in it
            // would let it write headers of its own, so it never gets one.
            $headers .= "\r\nReply-To: " . self::oneLine($replyTo);
        }
        if ($attachments === []) {
            $headers .= "\r\nContent-Type: text/plain; charset=utf-8";
        } else {
            $boundary = 'slytab-' . bin2hex(random_bytes(12));
            $headers .= "\r\nContent-Type: multipart/mixed; boundary=\"{$boundary}\"";
            $parts = "--{$boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n"
                . "Content-Transfer-Encoding: 8bit\r\n\r\n{$body}\r\n";
            foreach ($attachments as $a) {
                $data = @file_get_contents($a['path']);
                if ($data === false) {
                    error_log("mailer: attachment unreadable, sent without it: {$a['name']}");
                    continue;
                }
                $name = str_replace('"', '', self::oneLine($a['name']));
                $parts .= "--{$boundary}\r\nContent-Type: " . self::oneLine($a['mime']) . "; name=\"{$name}\"\r\n"
                    . "Content-Transfer-Encoding: base64\r\n"
                    . "Content-Disposition: attachment; filename=\"{$name}\"\r\n\r\n"
                    . chunk_split(base64_encode($data)) . "\r\n";
            }
            $body = $parts . "--{$boundary}--\r\n";
        }
        return [$headers, $body];
    }

    private static function oneLine(string $s): string
    {
        return trim(str_replace(["\r", "\n"], '', $s));
    }
}
