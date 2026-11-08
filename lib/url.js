// URL handling for launchers. Pure functions: no Chrome APIs, so they can be unit-tested in Node.

const MAX_URL_LENGTH = 2048;
const HOST_WITH_PORT = /^[^\s/?#:@]+:\d+(?:[/?#]|$)/; // "localhost:3000/app" looks like a scheme but is a host and port
const HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Hosts that are normally served over plain http during development. */
export function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || IPV4.test(h);
}

/**
 * Turns what the user typed into a safe http(s) URL.
 * Returns { ok: true, url, host } or { ok: false, error }.
 *   github.com            -> https://github.com/
 *   localhost:3000/app    -> http://localhost:3000/app   (development servers are rarely https)
 *   javascript:alert(1)   -> rejected, as is every non-http(s) scheme (data:, file:, chrome:, ftp:, blob:, ...)
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a website address, for example github.com.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'That address is too long.' };
  if (/\s/.test(raw)) return { ok: false, error: 'Addresses cannot contain spaces.' };

  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    candidate = raw;
  } else if (HAS_SCHEME.test(raw) && !HOST_WITH_PORT.test(raw)) {
    const scheme = raw.slice(0, raw.indexOf(':') + 1).toLowerCase();
    return { ok: false, error: `Only http and https websites are allowed (not "${scheme}").` };
  } else if (raw.startsWith('//')) {
    candidate = `https:${raw}`;
  } else {
    const probe = raw.replace(/[/?#].*$/, '').replace(/:\d+$/, '');
    candidate = `${isLocalHost(probe) ? 'http' : 'https'}://${raw}`;
  }

  let u;
  try { u = new URL(candidate); } catch { return { ok: false, error: 'That does not look like a valid web address.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https websites are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'Remove the username and password from the address.' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, error: 'That does not look like a valid web address.' };
  if (!host.includes('.') && !isLocalHost(host) && !host.includes(':')) {
    return { ok: false, error: 'Enter a full address such as github.com.' };
  }
  return { ok: true, url: u.href, host };
}

/** Hostname without a leading "www.", for display and matching. Empty string for anything that is not a URL. */
export function displayHost(urlString) {
  try { return new URL(urlString).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

/** A launcher is only ever opened if what is in storage is still a plain http(s) URL. */
export function isSafeLaunchUrl(urlString) {
  try { const u = new URL(urlString); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; }
}
