/**
 * Profile as a destination (§2.10), not a sheet (#103).
 *
 * The spec asks this screen to hold account details, payment handles, default
 * currency, theme, notifications, sessions, the phone-app links, bug
 * reporting, sign out and account deletion. That does not belong in a modal
 * over the Home screen — and on mobile it has been a screen since v0.1.3, so
 * the two clients disagreed about what Profile even is.
 *
 * The form itself is unchanged: `ProfileSheet` in Home.tsx already implements
 * all of it, and re-typing several hundred lines to move a wrapper would be a
 * good way to introduce a bug into the screen that deletes accounts. It gains
 * a `chrome={false}` mode instead, and this is the destination that uses it.
 */

import { ProfileSheet } from './Home';
import type { User } from '../api';

export function Profile({ user, onUserUpdated, onSignOut }: {
  user: User;
  onUserUpdated: (u: User) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="shell">
      <div className="header">
        <h1>Profile</h1>
      </div>
      <ProfileSheet
        chrome={false}
        user={user}
        onClose={() => {}}
        onSaved={onUserUpdated}
        onSignOut={onSignOut}
        // Already here — the shell's nav is how you leave.
        onMyExpenses={() => {}}
      />
    </div>
  );
}
