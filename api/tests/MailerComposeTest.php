<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use SlyTab\Services\Mailer;

/**
 * Issue #133: the support email carries a Reply-To and the reporter's
 * screenshot. Nothing in a test run reaches a mail server, so the MIME is
 * checked here, where a malformed part would otherwise be found only by a
 * screenshot that never arrives.
 */
final class MailerComposeTest extends TestCase
{
    private const FROM = 'SlyTab <noreply@electricrv.ca>';

    public function testPlainMessageIsUnchanged(): void
    {
        [$headers, $body] = Mailer::compose(self::FROM, "hello\n");
        self::assertSame("From: " . self::FROM . "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8", $headers);
        self::assertSame("hello\n", $body);
    }

    public function testReplyToCannotInjectHeaders(): void
    {
        [$headers] = Mailer::compose(self::FROM, 'x', "reader@example.com\r\nBcc: everyone@example.com");
        self::assertStringContainsString("\r\nReply-To: reader@example.comBcc: everyone@example.com", $headers);
        self::assertStringNotContainsString("\r\nBcc:", $headers);
    }

    public function testAttachmentIsAWellFormedMultipartPart(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'shot');
        file_put_contents($file, "\x89PNG fake bytes");
        try {
            [$headers, $body] = Mailer::compose(self::FROM, "Reference: ST-261025-AC34\n", null, [
                ['path' => $file, 'name' => 'ST-261025-AC34-screenshot.png', 'mime' => 'image/png'],
            ]);
        } finally {
            unlink($file);
        }
        self::assertMatchesRegularExpression('/Content-Type: multipart\/mixed; boundary="(slytab-[0-9a-f]{24})"/', $headers);
        preg_match('/boundary="([^"]+)"/', $headers, $m);
        $b = $m[1];

        // Text part first, then the image, then the closing boundary.
        self::assertStringStartsWith("--{$b}\r\nContent-Type: text/plain; charset=utf-8\r\n", $body);
        self::assertStringContainsString("Reference: ST-261025-AC34\n", $body);
        self::assertStringContainsString(
            "--{$b}\r\nContent-Type: image/png; name=\"ST-261025-AC34-screenshot.png\"\r\n"
            . "Content-Transfer-Encoding: base64\r\n"
            . "Content-Disposition: attachment; filename=\"ST-261025-AC34-screenshot.png\"\r\n\r\n"
            . base64_encode("\x89PNG fake bytes"),
            $body,
        );
        self::assertStringEndsWith("--{$b}--\r\n", $body);
    }

    public function testMissingAttachmentStillSendsTheText(): void
    {
        [, $body] = Mailer::compose(self::FROM, 'the report', null, [
            ['path' => '/nonexistent/shot.png', 'name' => 'shot.png', 'mime' => 'image/png'],
        ]);
        self::assertStringContainsString('the report', $body);
        self::assertStringNotContainsString('image/png', $body);
    }
}
