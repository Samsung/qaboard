// How the docs get their screenshots and clips (docs-media/README.md#serving-the-docs-build-fetches-media).
// Read by docusaurus.config.ts (static directories) and by the plugin, so both agree on the mode.
const path = require('path');

const MODES = ['local', 'remote', 'placeholder'];
// QABOARD_MEDIA_MISSING: what local builds do with shots whose files can't be downloaded
const MISSING = ['fail', 'placeholder', 'remote'];

// Downloaded files, served at <baseUrl>media/<key> (the folder is a static directory in local mode)
const CACHE_DIR = '.media-cache';
const SERVED_PREFIX = 'media';

// The manifest and the shot list, relative to the website's folder
const MANIFEST = 'media.json';
const SCHEMA = 'media.schema.json';
const SHOT_LIST = path.join('..', 'docs-media', 'shots.yaml');

// `docusaurus build` and `docusaurus deploy` (which builds) download the media; `start` and the rest don't
function isBuildCommand(argv = process.argv) {
  return argv.slice(2).some(arg => arg === 'build' || arg === 'deploy');
}

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/**
 * QABOARD_MEDIA=local|remote|placeholder overrides the mode (default: local for builds, remote otherwise),
 * QABOARD_MEDIA_BASE_URL points at a mirror of the bucket, QABOARD_MEDIA_STRICT=1 turns warnings into errors.
 * QABOARD_MEDIA_MISSING: in local mode, what to do with shots whose files can't be downloaded (e.g. a proxy blocks
 * videos). fail (default) fails the build, placeholder renders them as placeholders, remote has readers' browsers load
 * them from the media host (or the mirror), with a placeholder if that fails too. Strict builds always fail.
 */
function resolveMediaConfig(env = process.env, argv = process.argv) {
  const requested = String(env.QABOARD_MEDIA ?? '').trim().toLowerCase();
  if (requested && !MODES.includes(requested))
    throw new Error(`QABOARD_MEDIA=${env.QABOARD_MEDIA}: expected one of ${MODES.join(', ')}`);
  const isBuild = isBuildCommand(argv);
  const baseUrlOverride = String(env.QABOARD_MEDIA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrlOverride && !/^https?:\/\/[^/]+/.test(baseUrlOverride))
    throw new Error(`QABOARD_MEDIA_BASE_URL=${baseUrlOverride}: expected an http(s) URL`);
  const missing = String(env.QABOARD_MEDIA_MISSING ?? '').trim().toLowerCase() || 'fail';
  if (!MISSING.includes(missing))
    throw new Error(`QABOARD_MEDIA_MISSING=${env.QABOARD_MEDIA_MISSING}: expected one of ${MISSING.join(', ')}`);
  return {
    mode: requested || (isBuild ? 'local' : 'remote'),
    strict: truthy(env.QABOARD_MEDIA_STRICT),
    baseUrlOverride: baseUrlOverride || null,
    missing,
    isBuild,
  };
}

// For docusaurus.config.ts: in local mode, the downloaded files are a static directory
function mediaStaticDirectories() {
  return resolveMediaConfig().mode === 'local' ? [CACHE_DIR] : [];
}

// The social card for themeConfig.image, once published: its PNG master, served with the site in local mode (the
// plugin downloads the PNG of the ids in its `png` option). Else null: the media hostname never appears in a page.
function socialCardImage(siteDir, id = 'landing/social-card') {
  if (resolveMediaConfig().mode !== 'local')
    return null;
  try {
    const manifest = JSON.parse(require('fs').readFileSync(path.join(siteDir, MANIFEST), 'utf8'));
    const key = manifest.shots?.[id]?.files?.png?.key;
    return key ? `${SERVED_PREFIX}/${key}` : null;
  } catch {
    return null;
  }
}

module.exports = {
  MODES, MISSING, CACHE_DIR, SERVED_PREFIX, MANIFEST, SCHEMA, SHOT_LIST,
  isBuildCommand, resolveMediaConfig, mediaStaticDirectories, socialCardImage,
};
