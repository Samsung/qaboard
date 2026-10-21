// The other images of a run the image viewer offers to compare an image with (src/image-viewer/compareWith.jsx), e.g.
// the ground truth or the input next to an output. The likeliest come first: the same name in another folder
// (gt/0001.png for out/0001.png), names that start alike in the same folder (0001_gt.png for 0001.png)...
import { is_image } from './utils';

const dirname = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const basename = path => path.slice(path.lastIndexOf('/') + 1);
const stem = path => basename(path).replace(/\.[^.]*$/, '');
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
// Names of files that are usually compared with outputs
const USUAL = /(^|[^a-z])(gt|ground[ _-]?truth|input|target|expected|golden|label)([^a-z]|$)/i;

// How likely users want to compare `path` with `other`, and why. 0: no reason.
export const closeness = (path, other) => {
  if (stem(path) === stem(other)) return { score: 100, reason: dirname(path) === dirname(other) ? 'Same name, another format' : `Same name, in ${dirname(other) || 'the run'}/` };
  if (dirname(path) !== dirname(other)) return { score: 0 };
  const prefix = commonPrefix(stem(path), stem(other));
  if (prefix < 2) return { score: 0 };
  return { score: 10 + Math.min(prefix, 40) + (USUAL.test(stem(other)) ? 50 : 0), reason: 'Next to it' };
};

const SUGGESTED = 6;

// Images are the usual formats, and those the site's image servers open, e.g. { 'raw,hex,dng': '/iiif/cde/' }
const extension = path => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
export const isImageFile = (path, image_servers) => is_image({ path }) || Object.keys(image_servers ?? {})
  .filter(extensions => extensions !== 'default')
  .some(extensions => extensions.toLowerCase().split(',').map(e => e.trim()).includes(extension(path)));

// The run's images but `path`: [{ path, suggested, reason? }], the suggested first
export const compareCandidates = (path, manifest, image_servers) => {
  if (!manifest) return [];
  const paths = Object.keys(manifest)
    .filter(other => other !== path && isImageFile(other, image_servers))
    // the TIFF the viewer shows for a PNG (build_image_name) isn't listed twice
    .filter(other => !(/\.tiff$/i.test(other) && manifest[other.replace(/\.tiff$/i, '.png')] !== undefined))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const suggested = paths
    .map(other => ({ path: other, ...closeness(path, other) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGESTED)
    .map(({ path, reason }) => ({ path, reason, suggested: true }));
  const is_suggested = new Set(suggested.map(candidate => candidate.path));
  return [...suggested, ...paths.filter(other => !is_suggested.has(other)).map(other => ({ path: other, suggested: false }))];
};

// What the viewers of a visualization compare with: { page, all: path | null, runs: { [output id]: path | null } }.
// A pick applies to every run of the page (and undoes the runs picked alone), or to one run, e.g. to spot-check it.
// It's for the page it was picked on (its commit and batch): on another, the images are compared with their reference.
export const COMPARE_SCOPES = [
  { value: 'all', label: 'All runs', title: 'Every run compares with its own file of that name', phrase: 'in every run' },
  { value: 'run', label: 'This run', title: 'Only this run: the others keep what they compare with', phrase: 'in this run only' },
];

export const pickCompared = (entry, output_id, other, scope, page) => {
  if (entry?.page !== page) entry = undefined;
  return scope === 'run'
    ? { page, all: entry?.all ?? null, runs: { ...entry?.runs, [output_id]: other } }
    : { page, all: other, runs: {} };
};

// What a run compares with, and whether it differs from the other runs
export const comparedFor = (entry, output_id, page) => {
  if (entry?.page !== page) entry = undefined;
  const all = entry?.all ?? null;
  const own = entry && Object.hasOwn(entry.runs, output_id) ? entry.runs[output_id] : undefined;
  return { compared: own !== undefined ? own : all, alone: own !== undefined && own !== all };
};
