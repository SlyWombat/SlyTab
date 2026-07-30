<?php

declare(strict_types=1);

namespace SlyTab\Tests;

use PHPUnit\Framework\TestCase;
use ReflectionMethod;
use SlyTab\Services\ReceiptService;

/**
 * Issue #83: receipt photos must not carry the camera's GPS fix to the server.
 *
 * Every client has a path that uploads a file untouched — the web shrinker
 * returns the original below 500 KB, both shrinkers fall back on error — so
 * this is enforced server-side, and it must be LOSSLESS: the receipt corpus
 * depends on the stored image still being the image that was uploaded.
 */
final class ExifStripTest extends TestCase
{
    private string $path;

    protected function setUp(): void
    {
        $this->path = sys_get_temp_dir() . '/slytab-exif-' . getmypid() . '.jpg';
    }

    protected function tearDown(): void
    {
        @unlink($this->path);
    }

    private static function strip(string $path): void
    {
        $m = new ReflectionMethod(ReceiptService::class, 'stripJpegMetadata');
        $m->setAccessible(true);
        $m->invoke(null, $path);
    }

    /** A minimal but structurally real JPEG: SOI, APP0, [APP1], SOS + data, EOI. */
    private static function jpeg(bool $withExif): string
    {
        $app0 = "\xFF\xE0" . pack('n', 16) . "JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00";
        $exifPayload = "Exif\x00\x00" . 'II*' . "\x00" . 'GPSLatitude=45.4215 GPSLongitude=-75.6972';
        $app1 = "\xFF\xE1" . pack('n', strlen($exifPayload) + 2) . $exifPayload;
        $scan = "\xFF\xDA" . pack('n', 8) . "\x01\x01\x00\x00\x3F\x00" . 'IMAGEDATA' . "\xFF\xD9";
        return "\xFF\xD8" . $app0 . ($withExif ? $app1 : '') . $scan;
    }

    public function testGpsBearingExifIsRemoved(): void
    {
        file_put_contents($this->path, self::jpeg(true));
        self::assertStringContainsString('GPSLatitude', file_get_contents($this->path));

        self::strip($this->path);

        $out = file_get_contents($this->path);
        self::assertStringNotContainsString('GPSLatitude', $out);
        self::assertStringNotContainsString('GPSLongitude', $out);
        self::assertStringNotContainsString('Exif', $out);
    }

    /** Lossless: the scan data and every other segment survive byte for byte. */
    public function testTheImageItselfIsUntouched(): void
    {
        file_put_contents($this->path, self::jpeg(true));
        self::strip($this->path);

        $out = file_get_contents($this->path);
        self::assertSame(self::jpeg(false), $out, 'stripping must remove APP1 and nothing else');
        self::assertStringContainsString('IMAGEDATA', $out, 'scan data intact');
        self::assertStringContainsString('JFIF', $out, 'APP0 kept — dropping it is not our business');
        self::assertSame("\xFF\xD8", substr($out, 0, 2), 'still a JPEG');
        self::assertSame("\xFF\xD9", substr($out, -2), 'still terminated');
    }

    public function testAJpegWithNoMetadataIsLeftAlone(): void
    {
        $clean = self::jpeg(false);
        file_put_contents($this->path, $clean);

        self::strip($this->path);

        self::assertSame($clean, file_get_contents($this->path));
    }

    /** A PNG carries no EXIF from our clients; do not rewrite what we don't parse. */
    public function testNonJpegIsIgnored(): void
    {
        $png = "\x89PNG\r\n\x1a\n" . 'not-really-a-png-but-not-a-jpeg';
        file_put_contents($this->path, $png);

        self::strip($this->path);

        self::assertSame($png, file_get_contents($this->path));
    }

    /** Better to keep a file we cannot parse than to truncate someone's receipt. */
    public function testAMalformedJpegIsLeftIntactRatherThanTruncated(): void
    {
        // Segment length claims far more bytes than the file actually holds.
        $bad = "\xFF\xD8" . "\xFF\xE1" . pack('n', 9999) . 'short';
        file_put_contents($this->path, $bad);

        self::strip($this->path);

        self::assertSame($bad, file_get_contents($this->path));
    }
}
