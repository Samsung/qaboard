// Remark plugin for the MDX loader: while editing with `yarn start`, warns about the media components of the page
// you changed (unknown ids, wrong kinds...). In builds, the plugin's own scan already checked every page.
const fs = require('fs');
const path = require('path');
const logger = require('@docusaurus/logger').default;
const {remarkCollectMedia} = require('./collect');
const {checkElements} = require('./check');
const {loadManifest, loadShotList} = require('./manifest');
const {resolveMediaConfig, MANIFEST, SHOT_LIST} = require('./config');

const siteDir = path.resolve(__dirname, '..', '..');
let context = null;
let contextStamp = null;

// The manifest and the shot list, reloaded when they change
function getContext() {
  const stamp = [MANIFEST, SHOT_LIST].map(f => fs.statSync(path.join(siteDir, f), {throwIfNoEntry: false})?.mtimeMs).join();
  if (stamp !== contextStamp) {
    const {strict} = resolveMediaConfig();
    context = {shots: loadManifest(siteDir).shots, shotList: loadShotList(siteDir), strict};
    contextStamp = stamp;
  }
  return context;
}

function remarkQaboardMedia() {
  if (resolveMediaConfig().isBuild)
    return () => {};
  return remarkCollectMedia({
    onElements(elements, file) {
      if (!elements.length)
        return;
      let ctx;
      try {
        ctx = getContext();
      } catch (error) {
        logger.warn(error.message);
        return;
      }
      const relative = path.relative(siteDir, file.path ?? '');
      for (const {line, message} of checkElements(elements, ctx).messages)
        logger.warn(`[qaboard-media] ${relative}:${line}: ${message}`);
    },
  });
}

module.exports = remarkQaboardMedia;
