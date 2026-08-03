<?php

declare(strict_types=1);

namespace SlyTab\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;
use SlyTab\App;
use SlyTab\Db\Db;
use SlyTab\Db\Migrator;

/**
 * Profile photos (#112).
 *
 * The interesting assertions are the refusals. A photo is more personal than a
 * balance, and the id it hangs off is a ULID that appears in API responses —
 * so "knows the id" must not be the same as "may see the face".
 */
final class AvatarTest extends TestCase
{
    private static ?SlimApp $app = null;

    public static function setUpBeforeClass(): void
    {
        try {
            $pdo = Db::pdo();
        } catch (\Throwable $e) {
            self::markTestSkipped('test database unreachable: ' . $e->getMessage());
        }
        (new Migrator($pdo))->fresh();
        self::$app = App::create();
    }

    private function request(
        string $method,
        string $path,
        ?array $body = null,
        ?string $token = null,
        array $files = [],
    ): ResponseInterface {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $request = $request->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream(json_encode($body, JSON_THROW_ON_ERROR)));
        }
        if ($files !== []) {
            $request = $request->withUploadedFiles($files);
        }
        if ($token !== null) {
            $request = $request->withHeader('Authorization', "Bearer {$token}");
        }
        return self::$app->handle($request);
    }

    /** @return array<string,mixed> */
    private static function json(ResponseInterface $r): array
    {
        return json_decode((string) $r->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    /** @return array{token:string, id:string} */
    private function register(string $email, string $name): array
    {
        $r = self::json($this->request('POST', '/api/v1/auth/register', [
            'email' => $email, 'password' => 'a-long-enough-password', 'displayName' => $name,
        ]));
        return ['token' => $r['token'], 'id' => $r['user']['id']];
    }

    /** A real 2x2 PNG, so GD has something it can genuinely decode. */
    private function png(): UploadedFile
    {
        $img = imagecreatetruecolor(64, 40);
        imagefilledrectangle($img, 0, 0, 63, 39, imagecolorallocate($img, 200, 40, 90));
        $tmp = tempnam(sys_get_temp_dir(), 'av') . '.png';
        imagepng($img, $tmp);
        imagedestroy($img);
        return new UploadedFile($tmp, 'face.png', 'image/png', filesize($tmp), UPLOAD_ERR_OK);
    }

    /**
     * A JPEG whose pixels say one thing and whose EXIF tag says another —
     * which is exactly what a phone camera produces.
     *
     * Built by hand because there is no way to ask GD for one: it writes
     * pixels and no metadata. The APP1 segment is the smallest legal Exif
     * block — a TIFF header, one IFD entry (Orientation), and a null next-IFD
     * pointer.
     *
     * @param int $orientation EXIF Orientation value (3 = 180°, 6 = 90° CW, 8 = 90° CCW)
     */
    private function jpegWithOrientation(int $orientation, int $w, int $h): UploadedFile
    {
        $img = imagecreatetruecolor($w, $h);
        // Two halves, so which way up it ended can be read off a single pixel.
        imagefilledrectangle($img, 0, 0, $w - 1, intdiv($h, 2) - 1, imagecolorallocate($img, 255, 0, 0));
        imagefilledrectangle($img, 0, intdiv($h, 2), $w - 1, $h - 1, imagecolorallocate($img, 0, 0, 255));
        $plain = tempnam(sys_get_temp_dir(), 'av') . '.jpg';
        imagejpeg($img, $plain, 100);
        imagedestroy($img);

        $tiff = "II\x2a\x00\x08\x00\x00\x00"          // little-endian, magic 42, IFD0 at byte 8
            . "\x01\x00"                                  // one entry
            . "\x12\x01"                                  // tag 0x0112 Orientation
            . "\x03\x00"                                  // type SHORT
            . "\x01\x00\x00\x00"                        // count 1
            . chr($orientation) . "\x00\x00\x00"         // value, padded to 4 bytes
            . "\x00\x00\x00\x00";                       // no next IFD
        $app1 = "Exif\x00\x00" . $tiff;
        $segment = "\xff\xe1" . pack('n', strlen($app1) + 2) . $app1;

        $bytes = (string) file_get_contents($plain);
        // Straight after SOI, before everything else.
        $withExif = substr($bytes, 0, 2) . $segment . substr($bytes, 2);
        $out = tempnam(sys_get_temp_dir(), 'av') . '.jpg';
        file_put_contents($out, $withExif);
        @unlink($plain);
        return new UploadedFile($out, 'face.jpg', 'image/jpeg', filesize($out), UPLOAD_ERR_OK);
    }

    /** The colour at a point in the stored avatar, as [r, g, b]. */
    private function pixelAt(string $jpeg, int $x, int $y): array
    {
        $img = imagecreatefromstring($jpeg);
        self::assertNotFalse($img);
        $rgb = imagecolorat($img, $x, $y);
        imagedestroy($img);
        return [($rgb >> 16) & 255, ($rgb >> 8) & 255, $rgb & 255];
    }

    /**
     * A phone writes portrait pixels in landscape order and records the
     * rotation as a tag. GD reads the pixels and ignores the tag, so before
     * this was handled every photo taken in portrait was stored on its side —
     * cropped sideways too, since the crop ran on the unrotated image.
     */
    public function testAPortraitPhotoIsStoodUpright(): void
    {
        $ann = $this->register('ann-exif@example.com', 'Ann');

        // Orientation 3 is a half turn: red on top becomes blue on top.
        $res = $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], [
            'image' => $this->jpegWithOrientation(3, 200, 200),
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        $bytes = (string) $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $ann['token'])->getBody();
        [$r, , $b] = $this->pixelAt($bytes, 128, 20);
        self::assertGreaterThan(
            $r,
            $b,
            'the top of a photo tagged as upside-down should be its blue half — the rotation was ignored',
        );
    }

    /**
     * A quarter turn moves the halves sideways, which is the whole point.
     *
     * The fixture is 300x100 with red above blue. Tagged 6, the picture as
     * seen is 100 wide by 300 tall, and the half that was on top is now on the
     * RIGHT — rotation swaps the axis the split runs along. Getting this
     * backwards in the test was more instructive than the code: a 90 degree
     * case that still reads red-above-blue has not been rotated at all.
     *
     * Note this fixture cannot tell rotate-then-crop from crop-then-rotate:
     * its halves are symmetric about the centre, so both orders land the same
     * pixels here. The order still matters for which part of a real frame is
     * kept — cropping first takes the middle of the sideways image rather than
     * the middle of what was framed — and the code rotates first for that
     * reason.
     */
    public function testAQuarterTurnMovesTheHalvesSideways(): void
    {
        $ann = $this->register('ann-exif2@example.com', 'Ann');

        $res = $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], [
            'image' => $this->jpegWithOrientation(6, 300, 100),
        ]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        $bytes = (string) $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $ann['token'])->getBody();
        [$w, $h] = getimagesizefromstring($bytes);
        self::assertSame(256, $w);
        self::assertSame(256, $h);

        [, , $bLeft] = $this->pixelAt($bytes, 20, 128);
        [$rLeft] = $this->pixelAt($bytes, 20, 128);
        [$rRight, , $bRight] = $this->pixelAt($bytes, 235, 128);
        self::assertGreaterThan($rLeft, $bLeft, 'the lower half should have turned to the left');
        self::assertGreaterThan($bRight, $rRight, 'the upper half should have turned to the right');
    }

    public function testUploadThenSeeItAndRemoveIt(): void
    {
        $ann = $this->register('ann-av@example.com', 'Ann');

        self::assertFalse(self::json($this->request('GET', '/api/v1/me', null, $ann['token']))['hasAvatar']);

        $res = $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], ['image' => $this->png()]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        self::assertTrue(self::json($this->request('GET', '/api/v1/me', null, $ann['token']))['hasAvatar']);

        $img = $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $ann['token']);
        self::assertSame(200, $img->getStatusCode());
        self::assertSame('image/jpeg', $img->getHeaderLine('Content-Type'));

        // Squared and shrunk to the badge size, not stored as uploaded.
        $bytes = (string) $img->getBody();
        [$w, $h] = getimagesizefromstring($bytes);
        self::assertSame(256, $w);
        self::assertSame(256, $h, 'a badge is a circle; the stored image must be square');

        $this->request('DELETE', '/api/v1/me/avatar', null, $ann['token']);
        self::assertFalse(self::json($this->request('GET', '/api/v1/me', null, $ann['token']))['hasAvatar']);
        self::assertSame(404, $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $ann['token'])->getStatusCode());
    }

    public function testOnlyPeopleYouShareAGroupWithCanSeeIt(): void
    {
        $ann = $this->register('ann-av2@example.com', 'Ann');
        $ben = $this->register('ben-av2@example.com', 'Ben');
        $stranger = $this->register('stranger-av2@example.com', 'Stranger');

        $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], ['image' => $this->png()]);

        // A stranger holding Ann's id — which appears in ordinary API
        // responses — must not be able to fetch her face.
        self::assertSame(
            403,
            $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $stranger['token'])->getStatusCode(),
        );

        // Ben joins her group and may.
        $group = self::json($this->request('POST', '/api/v1/groups', [
            'name' => 'Trip', 'emoji' => '✈️', 'homeCurrency' => 'CAD',
        ], $ann['token']));
        $invite = self::json($this->request('POST', "/api/v1/groups/{$group['id']}/invites", [], $ann['token']));
        $this->request('POST', "/api/v1/join/{$invite['token']}", [], $ben['token']);

        self::assertSame(
            200,
            $this->request('GET', "/api/v1/users/{$ann['id']}/avatar", null, $ben['token'])->getStatusCode(),
        );

        // And the group's member list says who has one, so a client knows
        // whether to ask at all.
        $members = self::json($this->request('GET', "/api/v1/groups/{$group['id']}", null, $ben['token']))['members'];
        $annRow = current(array_filter($members, static fn(array $m): bool => $m['displayName'] === 'Ann'));
        self::assertTrue($annRow['hasAvatar']);
    }

    public function testSignedOutCallersGetNothing(): void
    {
        $ann = $this->register('ann-av3@example.com', 'Ann');
        $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], ['image' => $this->png()]);
        self::assertSame(401, $this->request('GET', "/api/v1/users/{$ann['id']}/avatar")->getStatusCode());
    }

    public function testRubbishIsRejected(): void
    {
        $ann = $this->register('ann-av4@example.com', 'Ann');
        $tmp = tempnam(sys_get_temp_dir(), 'av');
        file_put_contents($tmp, 'this is not an image');
        $res = $this->request('POST', '/api/v1/me/avatar', null, $ann['token'], [
            'image' => new UploadedFile($tmp, 'face.png', 'image/png', filesize($tmp), UPLOAD_ERR_OK),
        ]);
        // 400, not 422: VALIDATION is a bad request in this API, and the
        // message names the actual problem rather than blaming the server.
        self::assertSame(400, $res->getStatusCode(), (string) $res->getBody());
        self::assertStringContainsString('not an image', (string) $res->getBody());
    }
}
