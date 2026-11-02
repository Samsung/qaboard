// The image viewer: compares an image with a reference. See README.md.
export { ImageViewer } from './ImageViewer';
export { MODES, DEFAULT_MODE } from './modes';
export { DIFF_METHODS, DEFAULT_DIFF, normalizeDiff, diffAt } from './metrics';
export { DEFAULT_ADJUSTMENTS, normalizeAdjustments } from './adjustments';
export { iiifUrl, openImage, thumbnailUrl } from './sources';
export { regionAsYaml, scaleRegion, clipRegion } from './regions';
