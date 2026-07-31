import { useEffect, useState, type FormEvent } from 'react';
import { api, getToken, setToken, type User } from './api';
import { AppSignIn, Auth } from './screens/Auth';
import { Home } from './screens/Home';
import { Groups } from './screens/Groups';
import { Activity } from './screens/Activity';
import { Profile } from './screens/Profile';
import { Shell, type Dest } from './Shell';
import { GroupScreen } from './screens/Group';
import { Onboarding } from './screens/Onboarding';
import { Mark } from './ui';

// A destination from the shell, or a screen pushed over it. Group detail is
// pushed rather than a destination — §1: "Groups open as a pushed screen".
type Nav =
  | { screen: 'dest'; dest: Dest }
  | { screen: 'group'; groupId: string };

/** Pull a pending invite token from /join/<token> URLs (SPA fallback). */
function pendingJoinToken(): string | null {
  const m = location.pathname.match(/\/join\/([a-f0-9]{32})$/);
  return m?.[1] ?? null;
}

/** Pull a mobile sign-in handoff state from /app-signin/<state> URLs (issue #39). */
function pendingAppSignInState(): string | null {
  const m = location.pathname.match(/\/app-signin\/([a-f0-9]{32})$/);
  return m?.[1] ?? null;
}

/** Pull a password-reset token from /reset/<token> URLs. */
function pendingResetToken(): string | null {
  const m = location.pathname.match(/\/reset\/([a-f0-9]{64})$/);
  return m?.[1] ?? null;
}

/** Pull an email-verification token from /verify/<token> URLs. */
function pendingVerifyToken(): string | null {
  const m = location.pathname.match(/\/verify\/([a-f0-9]{64})$/);
  return m?.[1] ?? null;
}

function ResetScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="center">
      <Mark size={48} />
      <h1 style={{ font: '600 1.625rem var(--ss-font-display)' }}>Choose a new password</h1>
      {done ? (
        <>
          <p style={{ color: 'var(--ss-text-2)' }}>Password updated. Sign in with it now.</p>
          <button className="btn primary" onClick={onDone}>Go to sign in</button>
        </>
      ) : (
        <form onSubmit={submit} style={{ width: 'min(340px, 100%)', textAlign: 'left' }}>
          {error && <div className="error" role="alert">{error}</div>}
          <label className="field"><span>New password (10+ characters)</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={10} autoComplete="new-password" />
          </label>
          <button className="btn primary block">Set password</button>
        </form>
      )}
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [nav, setNav] = useState<Nav>({ screen: 'dest', dest: 'home' });
  const [appSignInState] = useState<string | null>(pendingAppSignInState);
  const [joinToken, setJoinToken] = useState<string | null>(pendingJoinToken);
  const [resetToken, setResetToken] = useState<string | null>(pendingResetToken);
  const [verifyState, setVerifyState] = useState<'pending' | 'done' | 'failed' | null>(
    pendingVerifyToken() === null ? null : 'pending',
  );

  // Confirm the email address from /verify/<token> links.
  useEffect(() => {
    const token = pendingVerifyToken();
    if (token === null) return;
    api.verifyEmail(token)
      .then(() => setVerifyState('done'))
      .catch(() => setVerifyState('failed'))
      .finally(() => history.replaceState(null, '', import.meta.env.BASE_URL));
  }, []);

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

  // Mobile handoff page: always the sign-in prompt, even with a web
  // session — the app's session comes from Google's proof, not this tab's.
  if (appSignInState !== null) {
    return <AppSignIn state={appSignInState} />;
  }

  if (!checked) return null;

  if (verifyState === 'pending') {
    return <div className="center"><p className="muted">Confirming your email…</p></div>;
  }
  if (verifyState === 'done' || verifyState === 'failed') {
    return (
      <div className="center">
        <Mark size={48} />
        <p style={{ color: 'var(--ss-text-2)' }}>
          {verifyState === 'done'
            ? 'Email confirmed ✓ — you can close this tab or continue below.'
            : 'This confirmation link has expired — sign in and use "Resend" to get a new one.'}
        </p>
        <button className="btn primary" onClick={() => setVerifyState(null)}>Continue</button>
      </div>
    );
  }

  if (resetToken !== null) {
    return (
      <ResetScreen token={resetToken} onDone={() => {
        setResetToken(null);
        history.replaceState(null, '', import.meta.env.BASE_URL);
      }} />
    );
  }

  if (user === null) {
    return (
      <Auth
        joinPending={joinToken !== null}
        onSignedIn={(token, u) => { setToken(token); setUser(u); }}
      />
    );
  }

  // Issue #36: first-run welcome, before anything else (invite-joins then
  // continue into their group via the existing join flow). Only an explicit
  // null triggers it — a missing field (old API) means an established user.
  if (user.onboardedAt === null) {
    return <Onboarding user={user} onDone={setUser} />;
  }

  if (nav.screen === 'group') {
    return (
      <GroupScreen
        groupId={nav.groupId}
        user={user}
        onBack={() => setNav({ screen: 'dest', dest: 'groups' })}
      />
    );
  }

  const signOut = () => {
    api.logout().catch(() => {});
    setToken(null);
    setUser(null);
  };
  const openGroup = (groupId: string) => setNav({ screen: 'group', groupId });
  const dest = nav.dest;

  return (
    <Shell user={user} dest={dest} onDest={(d) => setNav({ screen: 'dest', dest: d })}>
      {dest === 'home' && (
        <Home
          user={user}
          onUserUpdated={setUser}
          onOpenGroup={openGroup}
          onMyExpenses={() => setNav({ screen: 'dest', dest: 'activity' })}
          onSignOut={signOut}
        />
      )}
      {dest === 'groups' && (
        <Groups
          onOpenGroup={openGroup}
          onNewGroup={() => setNav({ screen: 'dest', dest: 'home' })}
        />
      )}
      {dest === 'activity' && (
        <Activity userId={user.id} onOpenGroup={openGroup} />
      )}
      {dest === 'profile' && (
        <Profile user={user} onUserUpdated={setUser} onSignOut={signOut} />
      )}
    </Shell>
  );
}
