<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Db\Db;
use SlyTab\Support\ApiException;
use SlyTab\Support\Categories;

/**
 * Per-group category customisation (issue #18).
 *
 * The taxonomy ships in @slytab/core; a group may rename any entry (the
 * owner's point: keep the snark, or drop it), hide the ones it never uses,
 * and reorder. Only the differences are stored, so a group that never
 * opens the manage screen has no rows and silently inherits any future
 * improvement to the shipped defaults.
 *
 * Hiding is a picker-level concept only: an expense already filed under a
 * category keeps it, and its label still resolves, or history would change
 * meaning under the user.
 */
final class CategoryService
{
    private const MAX_LABEL = 60;

    public function __construct(
        private readonly PDO $pdo,
        private readonly GroupService $groups,
    ) {}

    /**
     * A group's overrides, keyed by slug — the clients merge these onto the
     * shipped taxonomy with resolveCategories().
     *
     * @return array<string, array{label?:string, hidden?:bool, sortOrder?:int}>
     */
    public function overridesFor(string $groupId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT slug, label, hidden, sort_order FROM group_categories WHERE group_id = ?',
        );
        $stmt->execute([$groupId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $o = [];
            if ($row['label'] !== null && $row['label'] !== '') {
                $o['label'] = (string) $row['label'];
            }
            if ((int) $row['hidden'] === 1) {
                $o['hidden'] = true;
            }
            if ($row['sort_order'] !== null) {
                $o['sortOrder'] = (int) $row['sort_order'];
            }
            if ($o !== []) {
                $out[(string) $row['slug']] = $o;
            }
        }
        return $out;
    }

    /**
     * Replace a group's customisation wholesale. Entries equal to the
     * shipped default (no label, not hidden, no explicit order) are deleted
     * rather than stored, which is what keeps the table sparse and lets a
     * "reset to default" in the UI be an ordinary save.
     *
     * @param array<string, array<string,mixed>> $overrides slug => patch
     * @return array<string, array{label?:string, hidden?:bool, sortOrder?:int}>
     */
    public function replace(string $groupId, array $overrides): array
    {
        $this->groups->assertWritable($groupId);

        $clean = [];
        foreach ($overrides as $slug => $patch) {
            if (!is_string($slug) || !Categories::isValid($slug)) {
                throw new ApiException('VALIDATION', "unknown category '{$slug}'", 422);
            }
            if (!is_array($patch)) {
                throw new ApiException('VALIDATION', "category '{$slug}' must be an object", 422);
            }

            $entry = [];
            $label = $patch['label'] ?? null;
            if ($label !== null && $label !== '') {
                if (!is_string($label) || mb_strlen(trim($label)) > self::MAX_LABEL || trim($label) === '') {
                    throw new ApiException(
                        'VALIDATION',
                        "category '{$slug}': label must be 1-" . self::MAX_LABEL . ' characters',
                        422,
                    );
                }
                $entry['label'] = trim($label);
            }
            if (($patch['hidden'] ?? false) === true) {
                $entry['hidden'] = true;
            }
            $order = $patch['sortOrder'] ?? null;
            if ($order !== null) {
                if (!is_int($order) && !(is_string($order) && ctype_digit($order))) {
                    throw new ApiException('VALIDATION', "category '{$slug}': sortOrder must be an integer", 422);
                }
                $entry['sortOrder'] = (int) $order;
            }
            if ($entry !== []) {
                $clean[$slug] = $entry;
            }
        }

        // A group can't hide every category under a heading it still needs;
        // more importantly it can't hide ALL of them and be left with no way
        // to file an expense.
        $visible = array_filter(
            Categories::SLUGS,
            fn(string $s): bool => ($clean[$s]['hidden'] ?? false) !== true,
        );
        if ($visible === []) {
            throw new ApiException('VALIDATION', 'at least one category must stay visible', 422);
        }

        $this->pdo->beginTransaction();
        try {
            $this->pdo->prepare('DELETE FROM group_categories WHERE group_id = ?')->execute([$groupId]);
            $insert = $this->pdo->prepare(
                'INSERT INTO group_categories (group_id, slug, label, hidden, sort_order, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)',
            );
            foreach ($clean as $slug => $entry) {
                $insert->execute([
                    $groupId,
                    $slug,
                    $entry['label'] ?? null,
                    ($entry['hidden'] ?? false) ? 1 : 0,
                    $entry['sortOrder'] ?? null,
                    Db::now(),
                ]);
            }
            $this->pdo->commit();
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        return $clean;
    }
}
