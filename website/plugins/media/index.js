// Docusaurus plugin for the docs' screenshots, clips and terminal recordings (<Shot>, <Clip>, <Compare>).
// See docs-media/README.md#serving-the-docs-build-fetches-media.
//
// - local (`yarn build`): downloads the files the pages use into .media-cache/media/<key>, served same-origin;
// - remote (`yarn start`): components load from the manifest's base_url, nothing is downloaded;
// - placeholder: no network, every shot is a placeholder.
// Build checks: unknown ids fail the build, planned ids render placeholders (strict: fail),
// unused manifest entries warn (strict: fail). The media hostname must not end up in the built site, unless
// QABOARD_MEDIA_MISSING=remote had readers load the shots the build couldn't download from it.
const fs = require('fs');
const path = require('path');
const logger = require('@docusaurus/logger').default;
const {resolveMediaConfig, CACHE_DIR, SERVED_PREFIX, MANIFEST, SHOT_LIST} = require('./config');
const {loadManifest, loadShotList, servedFiles} = require('./manifest');
const {scanSite} = require('./scan');
const {checkElements} = require('./check');
const {syncMedia} = require('./download');

const PLUGIN_NAME = 'qaboard-media';
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/;

// What the components need from a manifest entry (global data is in every page's bundle): files are keys
function clientEntry(entry, files) {
  const {kind, width, height, lqip, alt, caption, duration, anchors} = entry;
  const keys = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.key]));
  return {kind, width, height, lqip, alt, caption, duration, anchors, files: keys};
}

function plannedEntry(entry, listed) {
  return {
    kind: entry?.kind ?? listed.kind,
    shows: listed?.shows || entry?.alt || '',
    ...(entry ? {width: entry.width, height: entry.height, caption: entry.caption} : {}),
  };
}

function textFiles(dir, files = []) {
  for (const dirent of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, dirent.name);
    if (dirent.isDirectory())
      textFiles(file, files);
    else if (/\.(html|js|mjs|json|xml|txt|css|map|webmanifest)$/.test(dirent.name))
      files.push(file);
  }
  return files;
}

module.exports = function qaboardMediaPlugin(context, options = {}) {
  const {siteDir} = context;
  const pngIds = new Set(options.png ?? ['landing/social-card']);
  const config = resolveMediaConfig();
  const cacheDir = path.join(siteDir, CACHE_DIR, SERVED_PREFIX);
  let mediaHosts = [];
  // Shots readers load from the media host (or the mirror), with QABOARD_MEDIA_MISSING=remote
  let remoteShots = [];
  let remoteHost = null;

  return {
    name: PLUGIN_NAME,

    getPathsToWatch() {
      return [path.join(siteDir, MANIFEST), path.join(siteDir, SHOT_LIST)];
    },

    async loadContent() {
      const manifest = loadManifest(siteDir);
      const shotList = loadShotList(siteDir);
      const baseUrl = config.baseUrlOverride ?? manifest.base_url;
      mediaHosts = [...new Set([manifest.base_url, baseUrl].map(url => new URL(url).host))].filter(h => !LOCAL_HOSTS.test(h));
      if (!shotList)
        logger.warn(`[qaboard-media] ${SHOT_LIST} not found: shot ids missing from ${MANIFEST} can't be checked, they render as placeholders`);

      // Build checks, on every page's sources
      const scan = await scanSite(siteDir);
      const errors = [];
      const warnings = scan.parseErrors.map(({file, message}) => `${file}: couldn't parse it to check its media (${message})`);
      const used = new Set();
      const planned = new Set();
      for (const {file, elements} of scan.files) {
        const result = checkElements(elements, {shots: manifest.shots, shotList, strict: config.strict});
        result.ids.forEach(id => used.add(id));
        result.planned.forEach(id => planned.add(id));
        for (const {level, line, message} of result.messages)
          (level === 'error' ? errors : warnings).push(`${file}:${line}: ${message}`);
      }
      // Ids kept in JS/TS arrays count as used. A string in a known area that isn't a known id is a typo.
      const areas = new Set([...Object.keys(manifest.shots), ...Object.keys(shotList ?? {})].map(id => id.split('/')[0]));
      for (const {file, line, value} of scan.strings) {
        if (manifest.shots[value] || shotList?.[value])
          used.add(value);
        else if (shotList && areas.has(value.split('/')[0]))
          errors.push(`${file}:${line}: "${value}" looks like a shot id, but it's neither in ${MANIFEST} nor in docs-media/shots.yaml`);
      }
      // The PNG masters the site uses (e.g. the social card)
      pngIds.forEach(id => manifest.shots[id] && used.add(id));
      const unused = Object.keys(manifest.shots).filter(id => !used.has(id)).sort();
      if (unused.length)
        (config.strict ? errors : warnings).push(`${MANIFEST} entries no page uses: ${unused.join(', ')}`);
      warnings.forEach(w => logger.warn(`[qaboard-media] ${w}`));
      if (errors.length) {
        const message = `[qaboard-media] ${errors.length} problem(s) with the docs' media:\n${errors.map(e => `  ${e}`).join('\n')}`;
        if (config.isBuild)
          throw new Error(message);
        // With `yarn start`, the page shows the problem instead of stopping the server
        logger.warn(message);
      }

      // Builds only ship what pages use; `yarn start` knows every shot, for the pages you are writing
      const ids = config.isBuild ? [...used] : [...new Set([...Object.keys(manifest.shots), ...Object.keys(shotList ?? {})])];
      const published = ids.filter(id => manifest.shots[id]).sort();
      remoteShots = [];
      remoteHost = null;
      const content = {mode: config.mode, base: null, shots: {}, planned: {}, remoteBase: null, remoteShots: []};
      if (config.mode === 'placeholder') {
        published.forEach(id => (content.planned[id] = plannedEntry(manifest.shots[id], shotList?.[id])));
      } else {
        const files = Object.fromEntries(published.map(id => [id, servedFiles(manifest.shots[id], {png: pngIds.has(id)})]));
        published.forEach(id => (content.shots[id] = clientEntry(manifest.shots[id], files[id])));
        if (config.mode === 'local') {
          content.base = `/${SERVED_PREFIX}/`;
          const wanted = published.flatMap(id => Object.values(files[id]));
          const allowFailures = config.missing !== 'fail' && !config.strict;
          const stats = await syncMedia(wanted, {baseUrl, destDir: cacheDir, allowFailures, log: m => logger.info(`[qaboard-media] ${m}`)});
          if (stats.removed)
            logger.info(`[qaboard-media] removed ${stats.removed} cached files no page uses`);
          // QABOARD_MEDIA_MISSING: shots with a file we couldn't download become placeholders,
          // or readers load them from the media host (the components show a placeholder if that fails too)
          const failed = new Set(stats.failed);
          const incomplete = published.filter(id => Object.values(files[id]).some(file => failed.has(file.key)));
          if (incomplete.length && config.missing === 'remote') {
            content.remoteBase = `${baseUrl}/`;
            content.remoteShots = incomplete;
            remoteShots = incomplete;
            remoteHost = new URL(baseUrl).host;
            logger.warn(`[qaboard-media] ${incomplete.length} shots load from ${baseUrl} in readers' browsers, some of their files could not be downloaded: ${incomplete.join(', ')}`);
          } else if (incomplete.length) {
            for (const id of incomplete) {
              delete content.shots[id];
              content.planned[id] = plannedEntry(manifest.shots[id], shotList?.[id]);
            }
            logger.warn(`[qaboard-media] ${incomplete.length} shots render as placeholders, some of their files could not be downloaded: ${incomplete.join(', ')}`);
          }
          // A static directory with folders but no files makes the build fail
          if (!wanted.length)
            fs.rmSync(path.join(siteDir, CACHE_DIR), {recursive: true, force: true});
        } else {
          content.base = `${baseUrl}/`;
        }
      }
      // Without shots.yaml, the kind of a planned shot isn't known: the component says what it expects
      ids.filter(id => !manifest.shots[id] && (shotList?.[id] || planned.has(id)))
        .forEach(id => (content.planned[id] = shotList?.[id] ? plannedEntry(null, shotList[id]) : {shows: ''}));
      if (config.isBuild) {
        const placeholders = Object.keys(content.planned).length;
        logger.info(`[qaboard-media] ${config.mode} mode${config.strict ? ', strict' : ''}: ${Object.keys(content.shots).length} shots served, ${placeholders} placeholders`);
      }
      return content;
    },

    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },

    // Readers never see the media hostname: it's for build tooling only
    async postBuild({outDir}) {
      if (config.mode === 'remote') {
        logger.warn(`[qaboard-media] QABOARD_MEDIA=remote: the built pages load media from ${mediaHosts.join(', ')}`);
        return;
      }
      if (remoteShots.length)
        logger.warn(`[qaboard-media] QABOARD_MEDIA_MISSING=remote: the built pages load ${remoteShots.length} shots from ${remoteHost}`);
      const hosts = mediaHosts.filter(host => !remoteShots.length || host !== remoteHost);
      const leaks = [];
      for (const file of textFiles(outDir)) {
        const content = fs.readFileSync(file);
        for (const host of hosts) {
          if (content.includes(host))
            leaks.push(`${path.relative(outDir, file)} contains ${host}`);
        }
      }
      if (leaks.length)
        throw new Error(`[qaboard-media] the media hostname must not appear in the built site:\n${leaks.slice(0, 20).map(l => `  ${l}`).join('\n')}`);
    },
  };
};
