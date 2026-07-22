import { useEffect, useState } from 'react';
import { api, getToken, setToken, type User } from './api';
import { Auth } from './screens/Auth';
import { Home } from './screens/Home';
import { GroupScreen } from './screens/Group';

type Nav = { screen: 'home' } | { screen: 'group'; groupId: string };

/** Pull a pending invite token from /join/<token> URLs (SPA fallback). */
function pendingJoinToken(): string | null {
  const m = location.pathname.match(/\/join\/([a-f0-9]{32})$/);
  return m?.[1] ?? null;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [nav, setNav] = useState<Nav>({ screen: 'home' });
  const [joinToken, setJoinToken] = useState<string | null>(pendingJoinToken);

  // Restore the session on load.
  useEffect(() => {
    if (getToken() === null) {
      setChecked(true);
      return;
    }
    api.me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecked(true));
  }, []);

  // Accept a pending invite once signed in.
  useEffect(() => {
    if (user === null || joinToken === null) return;
    api.join(joinToken)
      .then((group) => setNav({ screen: 'group', groupId: group.id }))
      .catch(() => { /* expired invite — land on Home */ })
      .finally(() => {
        setJoinToken(null);
        history.replaceState(null, '', import.meta.env.BASE_URL);
      });
  }, [user, joinToken]);

  if (!checked) return null;

  if (user === null) {
    return (
      <Auth
        joinPending={joinToken !== null}
        onSignedIn={(token, u) => { setToken(token); setUser(u); }}
      />
    );
  }

  if (nav.screen === 'group') {
    return (
      <GroupScreen
        groupId={nav.groupId}
        user={user}
        onBack={() => setNav({ screen: 'home' })}
      />
    );
  }

  return (
    <Home
      user={user}
      onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })}
      onSignOut={() => {
        api.logout().catch(() => {});
        setToken(null);
        setUser(null);
      }}
    />
  );
}
