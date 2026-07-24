import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiFailure, type User } from '../api';
import { Mark } from '../ui';

/** Google Identity Services + Apple JS globals, loaded on demand. */
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
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string; scope: string; redirectURI: string; usePopup: boolean;
        }) => void;
        signIn: () => Promise<{
          authorization: { id_token: string; code: string };
          user?: { name?: { firstName?: string; lastName?: string }; email?: string };
        }>;
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
      <div className="muted" style={{ fontSize: '0.75rem', margin: '10px 0 6px' }}>or</div>
      <div ref={host} style={{ minHeight: 44 }} />
    </>
  );
}

/**
 * "Sign in with Apple" button. Renders nothing until the API reports a
 * configured Services ID, then loads Apple's JS SDK and shows a
 * self-styled button; the popup's identity token (plus the user's name,
 * which Apple only supplies on first authorization) is exchanged for a
 * SlyTab session.
 */
function AppleButton({ onSignedIn, onError }: {
  onSignedIn: (token: string, user: User) => void;
  onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.appleConfig()
      .then((c) => { if (c.enabled) setClientId(c.clientId); })
      .catch(() => { /* endpoint unreachable — hide the button */ });
  }, []);

  useEffect(() => {
    if (clientId === null) return;
    const init = () => {
      if (!window.AppleID) return;
      try {
        window.AppleID.auth.init({
          clientId,
          scope: 'name email',
          redirectURI: `${location.origin}/slytab/`,
          usePopup: true,
        });
        setReady(true);
      } catch (e) {
        onError('Apple sign-in could not start — try again later');
      }
    };
    if (window.AppleID) {
      init();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    script.async = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [clientId]);

  async function click() {
    if (!window.AppleID) return;
    try {
      const r = await window.AppleID.auth.signIn();
      const name = r.user?.name;
      const displayName = [name?.firstName, name?.lastName].filter(Boolean).join(' ').trim();
      const res = await api.appleSignIn(r.authorization.id_token, displayName || undefined);
      onSignedIn(res.token, res.user);
    } catch (e) {
      // Apple rejects with a plain object when the user closes the popup —
      // stay silent for that; only surface real API failures.
      if (e instanceof ApiFailure) onError(e.message);
    }
  }

  if (clientId === null) return null;
  return (
    <button
      type="button"
      className="btn block"
      disabled={!ready}
      onClick={click}
      style={{
        background: '#000', color: '#fff', border: '1px solid #000',
        width: 280, marginTop: 8, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', gap: 8,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ marginTop: -2 }}>
        <path
          fill="#fff"
          d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.01-3.76-2.04-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.89-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.28-1.27 3.14-2.53.99-1.45 1.39-2.85 1.42-2.92-.03-.02-2.72-1.05-2.74-4.13zM14.46 4.9c.72-.87 1.2-2.08 1.07-3.28-1.03.04-2.28.69-3.02 1.55-.66.77-1.24 2-1.09 3.18 1.15.09 2.33-.58 3.04-1.45z"
        />
      </svg>
      Sign in with Apple
    </button>
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
      <h1 style={{ font: '600 2rem/1.2 var(--ss-font-display)', letterSpacing: '-0.02em' }}>
        Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span>
      </h1>
      <p style={{ color: 'var(--ss-text-2)', maxWidth: '36ch' }}>
        Split expenses with the people you actually share life with.
      </p>
      {joinPending && <p className="muted">Sign in to accept your group invite.</p>}

      <form onSubmit={submit} style={{ width: 'min(340px, 100%)', textAlign: 'left' }}>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="hero" style={{ fontSize: '0.8125rem', padding: 12 }}>{notice}</div>}
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
      <AppleButton onSignedIn={onSignedIn} onError={setError} />
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
        <span className="muted" style={{ fontSize: '0.75rem' }}>Direct download (APK) — same account as the web app</span>
      </div>
    </div>
  );
}
