/**
 * Theme preference — System / Dark / Light (issue #92).
 *
 * `tokens.css` has carried a full `[data-theme='light']` palette since the
 * design tokens were written, and nothing ever set the attribute. So the app
 * was hard-dark by accident rather than by decision, and a user who has set
 * their machine to Light — often for the same visual-acuity reasons that
 * drive large text — had no way to get it.
 *
 * "System" is the default and means exactly that: it follows the OS and keeps
 * following it, including a change made while the app is open.
 */

export type ThemePref = 'system' | 'dark' | 'light';

const KEY = 'slytab.theme';

export function storedPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'dark' || v === 'light' ? v : 'system';
}

function systemIsLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches === true;
}

/** What the preference actually resolves to right now. */
export function resolve(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') return systemIsLight() ? 'light' : 'dark';
  return pref;
}

function paint(pref: ThemePref): void {
  const theme = resolve(pref);
  document.documentElement.dataset.theme = theme;
  // Tells the browser to draw form controls, scrollbars and the address bar
  // to match — without it a light page keeps dark native widgets.
  document.documentElement.style.colorScheme = theme;
}

export function setPref(pref: ThemePref): void {
  localStorage.setItem(KEY, pref);
  paint(pref);
}

/**
 * Call once at startup. Returns an unsubscribe so a future caller can detach;
 * today nothing does, because the listener should live as long as the app.
 */
export function initTheme(): () => void {
  paint(storedPref());
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  const onChange = () => {
    // Only "system" follows the OS; an explicit choice stays put.
    if (storedPref() === 'system') paint('system');
  };
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}
