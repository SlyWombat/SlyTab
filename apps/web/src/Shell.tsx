/**
 * The navigation shell (issue #103).
 *
 * `ui_requirements.md` §1 specifies web as a left sidebar with the same four
 * destinations mobile has — Home, Groups, Activity, Profile. Web never got
 * one: everything hung off Home, Profile was a sheet, and Activity did not
 * exist at all. So nothing you learned on the phone transferred to the
 * laptop, which defeats the point of a shared design.
 *
 * A rail on wide viewports, a bottom bar on narrow ones. A fixed left rail on
 * a phone-width browser would eat the content, and a bottom bar is what
 * someone arriving from the mobile app already expects.
 */

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Badge } from './ui';
import type { User } from './api';

export type Dest = 'home' | 'groups' | 'activity' | 'profile';

const DESTS: { key: Dest; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'groups', label: 'Groups', icon: 'group' },
  { key: 'activity', label: 'Activity', icon: 'clock' },
  { key: 'profile', label: 'Profile', icon: 'person' },
];

export function Shell({ dest, onDest, user, children }: {
  dest: Dest;
  onDest: (d: Dest) => void;
  user: User;
  children: ReactNode;
}) {
  return (
    <div className="appshell">
      <nav className="railnav" aria-label="Main">
        <div className="railbrand">
          <span className="railmark" aria-hidden>S</span>
          <span className="railwordmark">SlyTab</span>
        </div>
        {DESTS.map((d) => (
          <button
            key={d.key}
            type="button"
            className={`raillink${dest === d.key ? ' on' : ''}`}
            aria-current={dest === d.key ? 'page' : undefined}
            onClick={() => onDest(d.key)}
          >
            {d.key === 'profile'
              ? <Badge id={user.id} name={user.displayName} hasAvatar={user.hasAvatar} sm />
              : <Icon name={d.icon} size={20} />}
            <span className="raillabel">{d.label}</span>
          </button>
        ))}
      </nav>
      <main className="railmain">{children}</main>
    </div>
  );
}
