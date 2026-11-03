// What error pages need besides React: recognizing stale bundles, reloading once, and the report users can send.

// Like the backend's (qaboard/sentry_utils.py): "?token=abc&a=1" => "?token=[Filtered]&a=1"
const sensitive_params = /((?:[\w.\-[\]]*(?:token|secret|password|passwd|api_?key|signature|credential)[\w.\-[\]]*|\bauth|\bauthorization|\bsig)=)[^&#;\s"']*/gi;
export const scrubUrl = url => String(url).replace(sensitive_params, '$1[Filtered]');


// After a deploy, the pages that users had open ask for the previous version's chunks, which are gone
const chunk_errors = [
  'Failed to fetch dynamically imported module', // Chrome
  'error loading dynamically imported module', // Firefox
  'Importing a module script failed', // Safari
  'Unable to preload CSS', // vite
];
export const isChunkError = error => error?.name === 'ChunkLoadError' || chunk_errors.some(message => String(error?.message).includes(message));


// Reloads the page, to get the new version. Not again right after: if the chunks are still missing, something else is
// wrong, and users should see why. Returns whether it reloads.
const reloaded_key = 'qaboard-reloaded-for-new-version';
const reload_cooldown = 30 * 1000;
export function reloadForNewVersion({ now = Date.now(), reload = () => window.location.reload() } = {}) {
  try {
    const last = Number(sessionStorage.getItem(reloaded_key));
    if (last && now - last < reload_cooldown) return false;
    sessionStorage.setItem(reloaded_key, String(now));
  } catch {
    // no storage (private browsing...): we can't tell whether we just reloaded, users get the error page
    return false;
  }
  reload();
  return true;
}


// What users send when they report an error: what they paste in a chat, or what the email/issue starts with
export function errorDetails({ error, componentStack, eventId }) {
  const lines = [
    `Page: ${scrubUrl(window.location.href)}`,
    `Error: ${String(error)}`,
    eventId && `Reference: ${eventId}`,
    import.meta.env.QABOARD_RELEASE && `Version: ${import.meta.env.QABOARD_RELEASE}`,
    `Browser: ${navigator.userAgent}`,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
  // the components closest to the error say the most, and emails' links can't be very long
  const stack = componentStack?.trim().split('\n').slice(0, 12).map(line => line.trim()).join('\n');
  return stack ? `${lines}\n\nComponents:\n${stack}` : lines;
}


// Where users report errors (QABOARD_SUPPORT_URL), pre-filled when we know how: emails and GitHub issues
export function reportUrl(support_url, { subject, body }) {
  const support = support_url || 'https://github.com/Samsung/qaboard/issues';
  if (support.startsWith('mailto:'))
    return `${support}${support.includes('?') ? '&' : '?'}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const github_issues = support.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/issues)\/?$/);
  if (github_issues)
    return `${github_issues[1]}/new?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return support;
}
