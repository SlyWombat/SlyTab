<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use Psr\Http\Message\UploadedFileInterface;
use SlyTab\Support\ApiException;
use SlyTab\Support\Env;

/**
 * Profile photos (#112).
 *
 * SlyTab shows a per-person badge everywhere money is attributed — payer
 * chips, member lists, balances, the activity feed. Initials and a derived
 * colour work until two people in a group share a first initial, at which
 * point the thing you read fastest stops distinguishing anyone.
 *
 * Stored small and square, deliberately. A badge is rendered at 20-40 points;
 * keeping the upload would mean carrying several megabytes to draw a circle
 * the size of a fingernail, on a disk with roughly 1 GB left.
 *
 * The initials badge is not a fallback for failure. It is what most people
 * will always have, so it stays first-class rather than becoming the
 * degraded case.
 */
final class AvatarService
{
    /** Generous for a photo, and far below the receipt limit. */
    private const MAX_BYTES = 8 * 1024 * 1024;
    /** Retina for the largest badge the app draws, and nothing beyond that. */
    private const SIDE = 256;
    private const MIME_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Accept an upload, square it, shrink it, and record it against the user.
     *
     * @return array{avatarPath: string}
     */
    public function set(string $userId, UploadedFileInterface $file): array
    {
        if ($file->getError() !== UPLOAD_ERR_OK) {
            throw new ApiException('VALIDATION', 'photo upload failed');
        }
        if ($file->getSize() === null || $file->getSize() > self::MAX_BYTES) {
            throw new ApiException('VALIDATION', 'photo must be 8 MB or smaller', 413);
        }
        $mime = $file->getClientMediaType() ?? '';
        if (!isset(self::MIME_EXT[$mime])) {
            throw new ApiException('VALIDATION', 'photo must be JPEG, PNG, or WebP');
        }
        if (!function_exists('imagecreatefromstring')) {
            throw new ApiException('UNAVAILABLE', 'the server cannot process images right now', 503);
        }

        $dir = self::dataDir() . '/avatars';
        if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
            throw new \RuntimeException("cannot create avatar directory {$dir}");
        }

        $tmp = "{$dir}/{$userId}.upload";
        $file->moveTo($tmp);
        try {
            $raw = (string) @file_get_contents($tmp);
            $src = @imagecreatefromstring($raw);
            if ($src === false) {
                throw new ApiException('VALIDATION', 'that file is not an image we can read');
            }

            // Stand the photo up before doing anything else.
            //
            // A phone camera writes portrait pixels in landscape order and
            // records the rotation as an EXIF tag; imagecreatefromstring reads
            // the pixels and ignores the tag. So a portrait photo arrived
            // sideways, was centre-cropped sideways, and every badge showed a
            // face on its side. The web client made it likelier still: it only
            // re-encodes files over 500 KB, so anything smaller reached here
            // with the tag intact and untouched.
            $src = self::uprightByExif($src, $tmp);

            // Centre square crop, then one resample to the final side. Cropping
            // first means the shrink never has to think about aspect ratio, and
            // a badge is a circle — anything outside the square is cut off by
            // the client regardless.
            $w = imagesx($src);
            $h = imagesy($src);
            $side = min($w, $h);
            $dst = imagecreatetruecolor(self::SIDE, self::SIDE);
            imagecopyresampled(
                $dst, $src,
                0, 0,
                (int) (($w - $side) / 2), (int) (($h - $side) / 2),
                self::SIDE, self::SIDE, $side, $side,
            );
            imagedestroy($src);

            // Re-encoded as JPEG, which is also what removes the metadata: the
            // EXIF block, including any GPS fix, does not survive the round
            // trip. Nothing here needs the location of someone's face.
            // A token in the filename, so replacing a photo changes its URL.
            //
            // The endpoint is /users/<id>/avatar, which is stable, and the
            // reply is cacheable — so with a fixed filename a new photo was
            // invisible until the cache expired. Reported by the owner on
            // 2026-08-03: uploaded a new picture, navigated away and back, and
            // still saw the old one. Making the URL change is what fixes that
            // without giving up caching; the alternative, revalidating every
            // time, costs a round trip per badge and a group screen draws
            // dozens.
            $token = bin2hex(random_bytes(4));
            $rel = "avatars/{$userId}-{$token}.jpg";
            $ok = imagejpeg($dst, self::dataDir() . '/' . $rel, 88);
            imagedestroy($dst);
            if (!$ok) {
                throw new \RuntimeException('could not write the resized photo');
            }

            // The one it replaces, or every change leaves a file behind for
            // good on a disk with about a gigabyte free.
            $prev = $this->pathOf($userId);
            $this->pdo->prepare('UPDATE users SET avatar_path = ? WHERE id = ?')
                ->execute([$rel, $userId]);
            if ($prev !== null && $prev !== $rel) {
                @unlink(self::dataDir() . '/' . $prev);
            }
            return ['avatarPath' => $rel];
        } finally {
            @unlink($tmp);
        }
    }

    /**
     * Rotate an image to match its EXIF Orientation tag.
     *
     * Only the three rotations matter in practice — 3, 6 and 8 are what
     * cameras write. The mirrored orientations (2, 4, 5, 7) come from
     * deliberate flips rather than from how a phone was held, and treating
     * them as rotations would make those photos worse, not better.
     *
     * Returns the original image untouched when there is no tag, when the
     * exif extension is absent, or when anything about reading it fails: an
     * unrotated photo is a much smaller problem than no photo.
     */
    private static function uprightByExif(\GdImage $img, string $path): \GdImage
    {
        if (!function_exists('exif_read_data')) {
            return $img;
        }
        // Read from the temp file, which is still on disk at this point: the
        // data:// wrapper would work too, but only if it stays registered,
        // and a path cannot be turned off by configuration.
        $exif = @exif_read_data($path);
        $orientation = is_array($exif) ? ($exif['Orientation'] ?? null) : null;
        $angle = match ((int) $orientation) {
            3 => 180,
            6 => -90,
            8 => 90,
            default => 0,
        };
        if ($angle === 0) {
            return $img;
        }
        $rotated = @imagerotate($img, $angle, 0);
        if ($rotated === false) {
            return $img;
        }
        imagedestroy($img);
        return $rotated;
    }

    /** The stored path for a user, or null when they have no photo. */
    private function pathOf(string $userId): ?string
    {
        $stmt = $this->pdo->prepare('SELECT avatar_path FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $rel = $stmt->fetchColumn();
        return is_string($rel) && $rel !== '' ? $rel : null;
    }

    /**
     * The version a client puts on the URL as ?v=… (#112).
     *
     * Taken from the stored filename rather than kept in its own column: the
     * filename already changes on every upload, so a second source of truth
     * could only ever disagree with it.
     */
    public static function versionOf(?string $path): ?string
    {
        if ($path === null || $path === '') {
            return null;
        }
        return preg_match('/-([0-9a-f]{8})\.jpg$/', $path, $m) === 1 ? $m[1] : null;
    }

    /** Remove the photo and fall back to initials. */
    public function clear(string $userId): void
    {
        $stmt = $this->pdo->prepare('SELECT avatar_path FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $rel = $stmt->fetchColumn();
        if (is_string($rel) && $rel !== '') {
            @unlink(self::dataDir() . '/' . $rel);
        }
        $this->pdo->prepare('UPDATE users SET avatar_path = NULL WHERE id = ?')->execute([$userId]);
    }

    /**
     * The file for a user's photo, if they have one and the asker may see it.
     *
     * Visible to the person themselves and to anyone who shares a group with
     * them — the same people who already see their name and what they are
     * owed. A photo is more personal than a balance, so this is checked rather
     * than assumed from possession of a user id.
     *
     * @return array{path: string, mime: string}
     */
    public function fileFor(string $viewerId, string $userId): array
    {
        if ($viewerId !== $userId) {
            $stmt = $this->pdo->prepare(
                'SELECT 1 FROM memberships a
                   JOIN memberships b ON b.group_id = a.group_id
                  WHERE a.user_id = ? AND a.left_at IS NULL
                    AND b.user_id = ? AND b.left_at IS NULL
                  LIMIT 1'
            );
            $stmt->execute([$viewerId, $userId]);
            if ($stmt->fetchColumn() === false) {
                throw new ApiException('FORBIDDEN', 'you do not share a group with that person', 403);
            }
        }

        $stmt = $this->pdo->prepare('SELECT avatar_path FROM users WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$userId]);
        $rel = $stmt->fetchColumn();
        if (!is_string($rel) || $rel === '') {
            throw new ApiException('NOT_FOUND', 'no photo for that person', 404);
        }
        $path = self::dataDir() . '/' . $rel;
        if (!is_file($path)) {
            throw new ApiException('NOT_FOUND', 'no photo for that person', 404);
        }
        return ['path' => $path, 'mime' => 'image/jpeg'];
    }

    private static function dataDir(): string
    {
        return rtrim(Env::get('DATA_DIR', dirname(__DIR__, 3) . '/slytab-data'), '/');
    }
}
