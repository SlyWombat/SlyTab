<?php

declare(strict_types=1);

namespace SlyTab\Services;

use SlyTab\Support\Env;

/**
 * Outbound mail (password resets). Production uses PHP mail() through the
 * cPanel MTA; anywhere mail() is unavailable or MAIL_DISABLE is set the
 * message is logged instead so flows stay testable.
 */
class Mailer // non-final: tests substitute a capturing subclass
{
    public function send(string $to, string $subject, string $body): void
    {
        $from = Env::get('MAIL_FROM', 'SlyTab <noreply@electricrv.ca>');
        if (Env::get('MAIL_DISABLE') !== '' || !function_exists('mail')) {
            error_log("mailer (disabled): to={$to} subject={$subject}");
            return;
        }
        $headers = "From: {$from}\r\nContent-Type: text/plain; charset=utf-8";
        if (!mail($to, $subject, $body, $headers)) {
            error_log("mailer: mail() returned false for {$to}");
        }
    }
}
