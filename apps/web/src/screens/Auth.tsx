import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiFailure, type User } from '../api';
import { Mark } from '../ui';

/** Google Identity Services global, loaded on demand. */
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, string | number>) => void;
        };
      };
    };
  }
}

/**
 * "Sign in with Google" button. Renders nothing until the API reports a
 * configured client id, then loads the GIS script and mounts the official
 * button; the returned ID token is exchanged for a SlyTab session.
 */
function GoogleButton({ onSignedIn, onError }: {
  onSignedIn: (token: string, user: User) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    api.googleConfig()
      .then((c) => { if (c.enabled) setClientId(c.clientId); })
      .catch(() => { /* endpoint unreachable — hide the button */ });
  }, []);

  useEffect(() => {
    if (clientId === null || host.current === null) return;
    const mount = () => {
      if (!window.google || host.current === null) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          api.googleSignIn(credential)
            .then((r) => onSignedIn(r.token, r.user))
            .catch((e) => onError(e instanceof ApiFailure ? e.message : 'Google sign-in failed — try again'));
        },
      });
      window.google.accounts.id.renderButton(host.current, {
        theme: 'outline', size: 'large', width: 280, text: 'continue_with',
      });
    };
    if (window.google) {
      mount();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = mount;
    document.head.appendChild(script);
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (clientId === null) return null;
  return (
    <>
      <div className="muted" style={{ fontSize: 12, margin: '10px 0 6px' }}>or</div>
      <div ref={host} style={{ minHeight: 44 }} />
    </>
  );
}

export function Auth({ onSignedIn, joinPending }: {
  onSignedIn: (token: string, user: User) => void;
  joinPending: boolean;
}) {
  const [mode, setMode] = useState<'signin' | 'create' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        await api.resetRequest(email);
        setNotice('If that address has an account, a reset link is on its way. Check your inbox.');
        setMode('signin');
        return;
      }
      const result = mode === 'create'
        ? await api.register(email, password, displayName)
        : await api.login(email, password);
      onSignedIn(result.token, result.user);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'something went wrong — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <Mark size={56} />
      <h1 style={{ font: '600 32px/1.2 var(--ss-font-display)', letterSpacing: '-0.02em' }}>
        Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span>
      </h1>
      <p style={{ color: 'var(--ss-text-2)', maxWidth: '36ch' }}>
        Split expenses with the people you actually share life with.
      </p>
      {joinPending && <p className="muted">Sign in to accept your group invite.</p>}

      <form onSubmit={submit} style={{ width: 'min(340px, 100%)', textAlign: 'left' }}>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="hero" style={{ fontSize: 13, padding: 12 }}>{notice}</div>}
        {mode === 'create' && (
          <label className="field"><span>Your name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
          </label>
        )}
        <label className="field"><span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        {mode !== 'forgot' && (
          <label className="field"><span>Password{mode === 'create' ? ' (10+ characters)' : ''}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={mode === 'create' ? 10 : 1} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} />
          </label>
        )}
        <button className="btn primary block" disabled={busy}>
          {busy ? '…' : mode === 'create' ? 'Create account' : mode === 'forgot' ? 'Email me a reset link' : 'Sign in'}
        </button>
      </form>
      <button className="link-btn" onClick={() => { setMode(mode === 'create' ? 'signin' : 'create'); setError(null); }}>
        {mode === 'create' ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
      {mode === 'signin' && (
        <button className="link-btn" onClick={() => { setMode('forgot'); setError(null); }}>
          Forgot password?
        </button>
      )}
      <GoogleButton onSignedIn={onSignedIn} onError={setError} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ss-space-1)', marginTop: 'var(--ss-space-5)' }}>
        <a
          className="btn"
          href={`${import.meta.env.BASE_URL}downloads/slytab.apk`}
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 'var(--ss-space-2)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8.4 5.4 7.2 3.5" fill="none" />
              <path d="M15.6 5.4l1.2-1.9" fill="none" />
            </g>
            <path d="M6 12.5a6 6 0 0 1 12 0v1.2H6z" fill="currentColor" />
            <circle cx="9.6" cy="9.9" r="1" fill="var(--ss-surface-2)" />
            <circle cx="14.4" cy="9.9" r="1" fill="var(--ss-surface-2)" />
          </svg>
          Get the Android app
        </a>
        <span className="muted" style={{ fontSize: 12 }}>Direct download (APK) — same account as the web app</span>
      </div>
    </div>
  );
}
