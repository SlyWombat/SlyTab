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
        $from = Env::get('MAIL_FROM', 'SlyTab <noreply@electricrv.ca>');
        if (Env::get('MAIL_DISABLE') !== '' || !function_exists('mail')) {
            error_log("mailer (disabled): to={$to} subject={$subject}");
            return true;
        }
        $envelope = preg_match('/<([^>]+)>/', $from, $m) === 1 ? $m[1] : $from;
        $headers = "From: {$from}\r\nContent-Type: text/plain; charset=utf-8";
        // Suppress the warning mail() emits alongside returning false —
        // under php -S it would leak into the JSON response body.
        return @mail($to, $subject, $body, $headers, '-f' . $envelope);
    }
}
