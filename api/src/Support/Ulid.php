<?php

declare(strict_types=1);

namespace SlySplit\Support;

/**
 * ULID generator — 26-char Crockford base32, 48-bit ms timestamp +
 * 80 random bits. Lexicographically sortable by creation time, which is
 * why id columns are CHAR(26) and remainder tie-breaks use id ordering.
 */
final class Ulid
{
    private const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    public static function generate(): string
    {
        $timeMs = (int) floor(microtime(true) * 1000);

        // 10 chars of timestamp (48 bits)
        $time = '';
        for ($i = 9; $i >= 0; $i--) {
            $time = self::ALPHABET[$timeMs & 31] . $time;
            $timeMs = intdiv($timeMs, 32);
        }

        // 16 chars of randomness (80 bits)
        $rand = '';
        $bytes = random_bytes(10);
        $carry = 0;
        $bits = 0;
        for ($i = 0; $i < 10; $i++) {
            $carry = ($carry << 8) | ord($bytes[$i]);
            $bits += 8;
            while ($bits >= 5) {
                $bits -= 5;
                $rand .= self::ALPHABET[($carry >> $bits) & 31];
            }
        }

        return $time . $rand;
    }
}
