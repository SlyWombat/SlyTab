<?php

declare(strict_types=1);

namespace SlyTab\Services;

use PDO;
use SlyTab\Support\Money;

/**
 * Payment reminders (issue #19).
 *
 * Two things go quiet and stay quiet:
 *
 *  - **A settlement nobody confirmed.** Someone says they paid; the other
 *    person never taps confirm. The balance stays wrong and both sides think
 *    it is the other's move.
 *  - **A balance nobody has touched.** The trip ended a month ago and three
 *    people still owe each other money that everybody has stopped thinking
 *    about.
 *
 * The hard part is not finding them — it is not becoming the app that nags.
 * So: nothing is sent twice inside the cooling-off period, nothing is sent for
 * a balance below a floor worth an email, `notify_level` is respected, and the
 * reminder always says what to do rather than only that something is wrong.
 *
 * Reuses `notification_emails` as the record of what was sent (#77) rather
 * than adding a table — the question "did we already nag this person about
 * this?" is exactly what that table answers.
 */
final class ReminderService
{
    /** A settlement unconfirmed for longer than this is probably forgotten. */
    private const UNCONFIRMED_DAYS = 3;
    /** How long a balance sits untouched before it is worth mentioning. */
    private const STALE_BALANCE_DAYS = 21;
    /** Don't email the same person about the same thing more often than this. */
    private const COOLDOWN_DAYS = 14;
    /**
     * A nudge someone sent by hand cools off faster than the automatic
     * sweep — they know they are asking, and 14 days would make the button
     * feel broken — but it still cools off, because "remind" tapped six
     * times is six emails and the end of a friendship.
     */
    private const NUDGE_COOLDOWN_DAYS = 3;
    /** Below this, an email costs more attention than the debt is worth. */
    private const MIN_MINOR = 500;

    /**
     * There is no Money::format — the codebase formats with number_format
     * against the per-currency scale, so this does the same in one place
     * rather than scattering the idiom. Zero-decimal currencies must not gain
     * two decimal places in an email any more than anywhere else.
     */
    private static function money(int $minor, string $currency): string
    {
        $scale = Money::scale($currency);
        return number_format($minor / $scale, $scale === 1 ? 0 : 2) . ' ' . $currency;
    }

    public function __construct(
        private readonly PDO $pdo,
        private readonly BalanceService $balances,
        private readonly Mailer $mailer = new Mailer(),
    ) {}

    /**
     * @return array{unconfirmed: int, stale: int, skipped: int}
     */
    public function sweep(): array
    {
        return [
            'unconfirmed' => $this->remindUnconfirmed(),
            'stale' => $this->remindStaleBalances(),
            'skipped' => $this->skipped,
        ];
    }

    private int $skipped = 0;

    /** Someone said they paid and the other side never confirmed it. */
    private function remindUnconfirmed(): int
    {
        $stmt = $this->pdo->prepare(
            "SELECT s.id, s.group_id, s.amount, s.currency, s.to_user, s.from_user,
                    g.name AS group_name,
                    payer.display_name AS payer_name,
                    u.email, u.notify_level
             FROM settlements s
             JOIN `groups` g ON g.id = s.group_id
             JOIN users u ON u.id = s.to_user AND u.deleted_at IS NULL
             JOIN users payer ON payer.id = s.from_user
             WHERE s.status = 'pending'
               AND s.created_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)",
        );
        $stmt->execute([self::UNCONFIRMED_DAYS]);

        $sent = 0;
        foreach ($stmt->fetchAll() as $r) {
            if (!$this->shouldSend($r['to_user'], 'reminder_settlement', (string) $r['notify_level'])) {
                continue;
            }
            $amount = self::money((int) $r['amount'], (string) $r['currency']);
            $body = "{$r['payer_name']} says they paid you {$amount} in \"{$r['group_name']}\", "
                . "and it is still waiting for you to confirm it.\n\n"
                . "Until you do, the balance between you stays as it was — so if the money "
                . "did arrive, confirming it is what squares you up.\n\n"
                . "Open SlyTab: " . self::appUrl() . "\n\n"
                . "If it never arrived, you can decline it there instead.\n\n"
                . self::footer((string) $r['to_user']);
            $this->send((string) $r['to_user'], (string) $r['email'], (string) $r['group_id'],
                'reminder_settlement',
                "{$r['payer_name']} is waiting for you to confirm a payment", $body,
                (string) $r['group_name']);
            $sent++;
        }
        return $sent;
    }

    /** A group where nothing has happened for weeks and money is still owed. */
    private function remindStaleBalances(): int
    {
        $groups = $this->pdo->prepare(
            "SELECT g.id, g.name, g.home_currency
             FROM `groups` g
             WHERE g.archived_at IS NULL
               AND (SELECT MAX(e.created_at) FROM expenses e
                    WHERE e.group_id = g.id AND e.deleted_at IS NULL)
                   <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)",
        );
        $groups->execute([self::STALE_BALANCE_DAYS]);

        $sent = 0;
        foreach ($groups->fetchAll() as $g) {
            $plan = $this->balances->forGroup((string) $g['id'])['plan'] ?? [];
            foreach ($plan as $tr) {
                $owed = (int) ($tr['amountMinor'] ?? 0);
                if ($owed < self::MIN_MINOR) {
                    $this->skipped++;
                    continue;
                }
                // Only the payer is reminded. Telling the person who is OWED
                // to go and ask is how an app makes someone chase a friend.
                $who = $this->person((string) ($tr['from'] ?? ''));
                $to = $this->person((string) ($tr['to'] ?? ''));
                if ($who === null || $to === null) {
                    continue;
                }
                if (!$this->shouldSend($who['id'], 'reminder_balance', (string) $who['notify_level'])) {
                    continue;
                }
                $amount = self::money($owed, (string) $g['home_currency']);
                $body = "Nothing has happened in \"{$g['name']}\" for a few weeks, and there is "
                    . "still {$amount} to settle: you owe {$to['display_name']}.\n\n"
                    . "You can pay however you normally do — SlyTab just needs to know it "
                    . "happened, so record it and {$to['display_name']} confirms.\n\n"
                    . "Open SlyTab: " . self::appUrl() . "\n\n"
                    . self::footer($who['id']);
                $this->send($who['id'], $who['email'], (string) $g['id'], 'reminder_balance',
                    "You still owe {$to['display_name']} {$amount}", $body, (string) $g['name']);
                $sent++;
            }
        }
        return $sent;
    }

    /**
     * A reminder one person sent on purpose (#120): "you still owe me".
     *
     * The automatic sweep deliberately never does this — an app that tells
     * you to go and chase your friend is an app nobody keeps. Asked for by
     * hand it is a different act, so this is a route, not a cron job. What
     * survives from the sweep's rules: the debt has to be real, the person
     * has to be reachable and willing to hear from us, and it cools off.
     *
     * @param string $creditorId the member who is owed — the one asking
     * @param string $debtorId   the member who owes
     * @return array{sent: bool, reason: string}
     */
    public function nudge(string $groupId, string $creditorId, string $debtorId): array
    {
        $g = $this->pdo->prepare('SELECT id, name, home_currency FROM `groups` WHERE id = ?');
        $g->execute([$groupId]);
        $group = $g->fetch();
        if ($group === false) {
            return ['sent' => false, 'reason' => 'no_group'];
        }

        // The plan, not the raw pairwise ledger: it is what both people are
        // looking at on the balances screen, so it is what a reminder about
        // "what you owe me" has to agree with.
        $owed = 0;
        foreach ($this->balances->forGroup($groupId)['plan'] ?? [] as $tr) {
            if (($tr['from'] ?? '') === $debtorId && ($tr['to'] ?? '') === $creditorId) {
                $owed = (int) ($tr['amountMinor'] ?? 0);
            }
        }
        if ($owed <= 0) {
            return ['sent' => false, 'reason' => 'no_debt'];
        }

        $debtor = $this->person($debtorId);
        $creditor = $this->person($creditorId);
        if ($creditor === null) {
            return ['sent' => false, 'reason' => 'no_debt'];
        }
        // `person` filters out placeholders and deleted accounts: someone
        // whose history is waiting for them to register has no inbox to
        // reach. The clients hide the button for them (`isPlaceholder`);
        // this is the backstop that makes the silence honest.
        if ($debtor === null) {
            return ['sent' => false, 'reason' => 'unreachable'];
        }
        if ($debtor['notify_level'] === 'none') {
            return ['sent' => false, 'reason' => 'muted'];
        }
        if (!$this->shouldSend($debtorId, 'reminder_nudge', (string) $debtor['notify_level'])) {
            return ['sent' => false, 'reason' => 'too_soon'];
        }

        $amount = self::money($owed, (string) $group['home_currency']);
        $body = "{$creditor['display_name']} is squaring up \"{$group['name']}\" and there is "
            . "still {$amount} outstanding: you owe {$creditor['display_name']}.\n\n"
            . "Pay however the two of you normally do — SlyTab never touches the money. "
            . "It just needs to know it happened, so record it in the app and "
            . "{$creditor['display_name']} confirms it.\n\n"
            . 'Open SlyTab: ' . self::appUrl() . "\n\n"
            . self::footer($debtorId);
        $this->send($debtorId, (string) $debtor['email'], $groupId, 'reminder_nudge',
            "{$creditor['display_name']} is waiting on {$amount}", $body, (string) $group['name']);
        return ['sent' => true, 'reason' => 'sent'];
    }

    /** @return array{id:string,email:string,display_name:string,notify_level:string}|null */
    private function person(string $userId): ?array
    {
        if ($userId === '') {
            return null;
        }
        $stmt = $this->pdo->prepare(
            'SELECT id, email, display_name, notify_level FROM users
             WHERE id = ? AND deleted_at IS NULL AND placeholder_at IS NULL',
        );
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Respect the preference, and never nag twice inside the cooling-off
     * period. A reminder that arrives weekly stops being read.
     */
    private function shouldSend(string $userId, string $kind, string $notifyLevel): bool
    {
        if ($notifyLevel === 'none') {
            $this->skipped++;
            return false;
        }
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) FROM notification_emails
             WHERE user_id = ? AND kind = ?
               AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
        );
        $stmt->execute([$userId, $kind,
            $kind === 'reminder_nudge' ? self::NUDGE_COOLDOWN_DAYS : self::COOLDOWN_DAYS]);
        if ((int) $stmt->fetchColumn() > 0) {
            $this->skipped++;
            return false;
        }
        return true;
    }

    private function send(string $userId, string $email, string $groupId,
                          string $kind, string $subject, string $body, string $groupName): void
    {
        // Recorded first: if the mail fails we would rather skip a reminder
        // than risk sending it repeatedly on every sweep.
        $this->pdo->prepare(
            'INSERT INTO notification_emails
                (id, user_id, group_id, kind, title, body, group_name, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        )->execute([\SlyTab\Support\Ulid::generate(), $userId, $groupId, $kind,
                    mb_substr($subject, 0, 200), mb_substr($body, 0, 500), mb_substr($groupName, 0, 120)]);

        if (filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->mailer->dispatch($email, $subject, $body);
        }
    }

    private static function appUrl(): string
    {
        return \SlyTab\Support\Env::get('APP_URL', 'https://electricrv.ca/slytab');
    }

    private static function footer(string $userId): string
    {
        return "—\nYou're getting this because you share expenses on SlyTab.\n"
            . 'Change what you hear about, or stop these emails: '
            . EmailNotificationService::unsubscribeUrl($userId);
    }
}
