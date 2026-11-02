// Reads website/media.json (what is published) and docs-media/shots.yaml (what is planned).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const {MANIFEST, SCHEMA, SHOT_LIST} = require('./config');

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
const KINDS = ['still', 'clip', 'tape'];

let validate = null;
function loadManifest(siteDir) {
  const file = path.join(siteDir, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`[qaboard-media] can't read ${MANIFEST}: ${error.message}`);
  }
  if (!validate) {
    const schema = JSON.parse(fs.readFileSync(path.join(siteDir, SCHEMA), 'utf8'));
    // The schema's "format: date" is also checked by a pattern
    validate = new Ajv2020({allErrors: true, strict: false, validateFormats: false}).compile(schema);
  }
  if (!validate(manifest)) {
    const errors = validate.errors.slice(0, 10).map(e => `  ${e.instancePath || '/'} ${e.message}`).join('\n');
    throw new Error(`[qaboard-media] ${MANIFEST} doesn't match ${SCHEMA}:\n${errors}`);
  }
  return manifest;
}

/**
 * The shot list, as {id: {kind, shows, status, anchors}}, or null when the file isn't there
 * (e.g. an image built with website/ as its context).
 */
function loadShotList(siteDir) {
  const file = path.join(siteDir, SHOT_LIST);
  if (!fs.existsSync(file))
    return null;
  const data = yaml.load(fs.readFileSync(file, 'utf8'));
  const shots = {};
  for (const shot of data?.shots ?? []) {
    if (!ID_RE.test(shot.id ?? '') || shot.id.length > 80)
      throw new Error(`[qaboard-media] shots.yaml: invalid id "${shot.id}"`);
    if (shots[shot.id])
      throw new Error(`[qaboard-media] shots.yaml: ${shot.id} is listed twice`);
    if (!KINDS.includes(shot.kind))
      throw new Error(`[qaboard-media] shots.yaml: ${shot.id} has an invalid kind "${shot.kind}"`);
    shots[shot.id] = {
      kind: shot.kind,
      shows: String(shot.shows ?? '').trim(),
      status: shot.status ?? 'planned',
      anchors: Array.isArray(shot.anchors) ? shot.anchors.map(String) : [],
    };
  }
  return shots;
}

// The files of an entry that readers load. PNG masters only when asked for (e.g. the social card).
// `dark`: the files of its dark variant ({} when it has none).
function servedFiles(entry, {png = false, dark = false} = {}) {
  const files = dark ? entry.dark?.files ?? {} : entry.files;
  const names = entry.kind === 'still' ? ['avif', 'webp', ...(png && !dark ? ['png'] : [])] : ['mp4', 'webm', 'poster', 'vtt'];
  return Object.fromEntries(names.filter(name => files[name]).map(name => [name, files[name]]));
}

module.exports = {ID_RE, loadManifest, loadShotList, servedFiles};
