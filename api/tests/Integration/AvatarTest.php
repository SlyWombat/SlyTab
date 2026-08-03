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
