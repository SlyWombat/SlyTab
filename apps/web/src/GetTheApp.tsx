/**
 * "Get the app" prompt for people using SlyTab in a browser.
 *
 * While the apps are in testing, the hard part is not signing in — it's
 * getting testers onto TestFlight at all. So this is deliberately the
 * short version: notice who this is for, offer the one link that matters,
 * and stay out of the way once dismissed.
 *
 * It renders INLINE at the top of the screen rather than floating over it.
 * A fixed toast on this app would sit on top of the "Add expense" FAB, and
 * we have just spent a release fixing exactly that class of overlap.
 *
 * Who sees it (2026-07-30): anyone who signs in with Apple, on any browser,
 * plus anyone on an iOS device however they signed in. It used to be user
 * agent only, and a tester on his phone reported seeing nothing at all —
 * with no stored user agent there was afterwards no way to tell whether he
 * was on Android, running it from the home screen, or served a stale
 * bundle. Signing in with Apple is a fact the server knows, so the common
 * case no longer rests on guessing from the browser.
 */

import { useState } from 'react';
import type { User } from './api';

/** Public TestFlight link for the "SlyTab family" group (no invite needed). */
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/eK9sm1jH';
const DISMISS_KEY = 'slytab.appPrompt.dismissedAt';
/** Ask again after a fortnight — a tester who said "not now" may have changed phones. */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
/** Tapping through is not the same as finishing; ask again tomorrow. */
const RETRY_MS = 24 * 60 * 60 * 1000;

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so the touch count is the giveaway.
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Already running as an installed app? Then there is nothing to offer. */
function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as { standalone?: boolean }).standalone === true;
}

function snoozed(): boolean {
  const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
  return at > 0 && Date.now() - at < SNOOZE_MS;
}

export function signedInWithApple(user?: Pick<User, 'signInProviders'>): boolean {
  return user?.signInProviders?.includes('apple') === true;
}

export function GetTheApp({ user }: { user?: Pick<User, 'signInProviders'> }) {
  const apple = signedInWithApple(user);
  const onDevice = isIos();
  const [hidden, setHidden] = useState(
    () => (!apple && !onDevice) || isStandalone() || snoozed(),
  );
  if (hidden) return null;

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 12, borderColor: 'var(--ss-brand)' }}>
      <span aria-hidden style={{ fontSize: '1.5rem', lineHeight: 1.2 }}>📱</span>
      <div className="grow">
        <div className="name">SlyTab runs better as an app</div>
        <p className="meta" style={{ margin: '2px 0 8px' }}>
          {onDevice
            ? <>The iPhone app is in testing — join through TestFlight and you'll get
              each new version automatically. Sign in with Apple and you're straight in.</>
            : <>There's an iPhone app in testing. <b>Open this on your iPhone</b> to join
              through TestFlight — sign in with Apple and your groups are already there.</>}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="btn primary sm" href={TESTFLIGHT_URL} target="_blank" rel="noreferrer"
            style={{ textDecoration: 'none' }}
            onClick={() => {
              // Joining TestFlight takes several steps and people get
              // interrupted. Snooze until tomorrow, not for a fortnight.
              localStorage.setItem(DISMISS_KEY, String(Date.now() - SNOOZE_MS + RETRY_MS));
            }}>
            Get the iPhone app
          </a>
          <button type="button" className="btn sm"
            onClick={() => {
              localStorage.setItem(DISMISS_KEY, String(Date.now()));
              setHidden(true);
            }}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
