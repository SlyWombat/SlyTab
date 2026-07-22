<?php

declare(strict_types=1);

namespace SlySplit\Db;

use PDO;

/**
 * Forward-only migration runner. Each migrations/NNN_name.sql file records
 * its own version in schema_migrations; this runner executes any file whose
 * version isn't recorded yet, in ascending order.
 */
final class Migrator
{
    public function __construct(private readonly PDO $pdo) {}

    /** @return list<int> versions applied in this run */
    public function migrate(): array
    {
        $applied = $this->appliedVersions();
        $ran = [];
        foreach ($this->files() as $version => $path) {
            if (in_array($version, $applied, true)) {
                continue;
            }
            foreach (self::statements(file_get_contents($path)) as $sql) {
                $this->pdo->exec($sql);
            }
            $ran[] = $version;
        }
        return $ran;
    }

    /** Drop every table and re-run all migrations. TEST DATABASES ONLY. */
    public function fresh(): array
    {
        $this->pdo->exec('SET FOREIGN_KEY_CHECKS=0');
        $tables = $this->pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
        foreach ($tables as $t) {
            $this->pdo->exec("DROP TABLE IF EXISTS `{$t}`");
        }
        $this->pdo->exec('SET FOREIGN_KEY_CHECKS=1');
        return $this->migrate();
    }

    /** @return list<int> */
    private function appliedVersions(): array
    {
        $exists = $this->pdo->query("SHOW TABLES LIKE 'schema_migrations'")->fetchColumn();
        if ($exists === false) {
            return [];
        }
        return array_map(
            'intval',
            $this->pdo->query('SELECT version FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN),
        );
    }

    /** @return array<int,string> version => file path, ascending */
    private function files(): array
    {
        $out = [];
        foreach (glob(__DIR__ . '/migrations/*.sql') as $path) {
            if (preg_match('/^(\d{3})_/', basename($path), $m)) {
                $out[(int) $m[1]] = $path;
            }
        }
        ksort($out);
        return $out;
    }

    /**
     * Split a migration file into statements on trailing semicolons.
     * Our migrations never embed ';' inside string literals — keep it so.
     *
     * @return list<string>
     */
    private static function statements(string $sql): array
    {
        $out = [];
        $buf = '';
        foreach (explode("\n", $sql) as $line) {
            $buf .= $line . "\n";
            if (str_ends_with(rtrim($line), ';')) {
                $stmt = trim($buf);
                if ($stmt !== '') {
                    $out[] = $stmt;
                }
                $buf = '';
            }
        }
        $tail = trim($buf);
        if ($tail !== '') {
            $out[] = $tail;
        }
        return $out;
    }
}
