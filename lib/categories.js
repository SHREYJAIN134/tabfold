// Which group a tab belongs to. Pure functions: no Chrome APIs.

export const CATEGORIES = Object.freeze({
  youtube: { id: 'youtube', title: 'YouTube', color: 'red' },
  technical: { id: 'technical', title: 'Technical', color: 'blue' },
  google: { id: 'google', title: 'Google', color: 'yellow' },
  others: { id: 'others', title: 'Others', color: 'grey' },
});
export const CATEGORY_ORDER = Object.freeze(['youtube', 'technical', 'google', 'others']);

const is = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const anyOf = (host, domains) => domains.some((d) => is(host, d));

const YOUTUBE = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'youtubekids.com'];

// Google products. Checked BEFORE the developer-docs rule so docs.google.com is Google Docs, not "docs.*".
const GOOGLE_HOSTS = [
  'mail.google.com', 'gmail.com', 'drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com',
  'forms.google.com', 'calendar.google.com', 'meet.google.com', 'keep.google.com', 'photos.google.com', 'contacts.google.com',
  'translate.google.com', 'maps.google.com', 'news.google.com', 'accounts.google.com', 'myaccount.google.com', 'chat.google.com',
];
// google.com, www.google.com, google.co.in, google.co.uk ... (Search). Not developers.google.com / cloud.google.com.
const GOOGLE_SEARCH_HOST = /^(?:www\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

const TECHNICAL = [
  'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'serverfault.com',
  'superuser.com', 'askubuntu.com', 'developer.mozilla.org', 'npmjs.com', 'npmjs.org', 'pypi.org', 'crates.io', 'docs.rs', 'rubygems.org',
  'nodejs.org', 'devdocs.io', 'w3schools.com', 'learn.microsoft.com', 'developer.chrome.com', 'developers.google.com', 'cloud.google.com',
  'developer.apple.com', 'developer.android.com', 'kubernetes.io', 'docker.com', 'hub.docker.com', 'python.org', 'rust-lang.org', 'go.dev',
  'react.dev', 'vuejs.org', 'angular.dev', 'typescriptlang.org', 'jsfiddle.net', 'codepen.io', 'codesandbox.io', 'replit.com',
  'dev.to', 'hashnode.com', 'vercel.com', 'netlify.com', 'localhost',
];
const DEV_PREFIX = /^(?:docs|developer|developers|dev|api|devdocs)\./; // docs.python.org, developer.mozilla.org, developers.cloudflare.com ...
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Hostname-only classification. */
export function categoryForHost(rawHost) {
  const host = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'others';
  if (anyOf(host, YOUTUBE)) return 'youtube';
  if (anyOf(host, GOOGLE_HOSTS) || GOOGLE_SEARCH_HOST.test(host)) return 'google';
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || IPV4.test(host)) return 'technical';
  if (anyOf(host, TECHNICAL) || DEV_PREFIX.test(host)) return 'technical';
  return 'others';
}

/**
 * The group a tab with this URL should be in, or null when the tab must be left alone:
 * blank tabs, Chrome's own pages, extension pages, files, devtools, view-source, anything that is not an ordinary http(s) site.
 */
export function categorize(urlString) {
  if (!urlString || typeof urlString !== 'string') return null;
  let u;
  try { u = new URL(urlString); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return categoryForHost(u.hostname);
}

/**
 * Category for the SWITCHER's filters. Unlike categorize(), nothing is left out: pages that are never grouped
 * (chrome://settings, a blank tab) count as "others" so they can still be found.
 */
export function filterCategory(urlString) {
  return categorize(urlString) || 'others';
}
