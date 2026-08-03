/**
 * Reading the address of a SlyTab server (#113).
 *
 * Lives in core rather than in the app because it is pure and because it is
 * about to have two callers: the phone, which takes a typed address or one
 * offered by a link, and — the moment self-hosting is real — anything else
 * that has to decide whether a string names a server it should talk to.
 */

/** Home network addresses, where plain http is a reasonable thing to allow. */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.local')
    || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * Turn what someone typed into an API base.
 *
 * People will type `example.org`, or paste the address of the web app, or the
 * API root with a trailing slash. All three name the same server, and being
 * strict would only mean rejecting people who are right.
 *
 * The one thing it will not do is accept plain http off the local network. The
 * token this app holds is a bearer credential — it *is* the account — and
 * sending it in the clear across the internet is not a trade-off worth
 * offering. On a home network that is the owner's own wire, so it is allowed.
 */
export function normaliseBase(input: string): string {
  let s = input.trim();
  if (s === '') throw new Error('enter the address of your server');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`${input} does not look like a web address`);
  }
  if (url.hostname === '') throw new Error(`${input} does not look like a web address`);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('use https — an http address would send your session in the clear');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(path)) path = `${path}/api/v1`;
  return `${url.protocol}//${url.host}${path}`;
}

/** The part of the address worth showing a person: the host they are trusting. */
export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
