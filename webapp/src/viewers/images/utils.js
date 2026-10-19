// Get the right IIIF endpoint for a file based on its extension.
// imageServers is a mapping like { "default": "/iiif/2/", "raw,hex,dng": "/iiif/cde/" }
export const getIiifEndpoint = (filePath, imageServers) => {
  if (!imageServers || !filePath) return '/iiif/2/';
  const ext = filePath.split('.').pop().toLowerCase();
  for (const [extensions, endpoint] of Object.entries(imageServers)) {
    if (extensions === 'default') continue;
    if (extensions.split(',').includes(ext)) return endpoint;
  }
  return imageServers.default || '/iiif/2/';
}

export const iiif_url = (output_dir_url, path, manifest = null, preferTiff = true, imageServers = undefined) => {
  path = build_image_name(path, manifest, preferTiff)
  // remove the URL's leading "/s"
  let identifier = output_dir_url.replace(/^\/*?s\//, "")
  // IIIF specs require encoding the slashes inside the identifier
  identifier = `${identifier}/${encodeURI(decodeURIComponent(path))}`.replace(/\//g, '%2F');
  let endpoint = getIiifEndpoint(path, imageServers);
  let url = `${endpoint}${identifier}`
  return url
}

export const build_image_name = (path, manifest = null, preferTiff = true) => {
  // Prefer TIFF over PNG when available
  if (preferTiff && manifest && path.endsWith('.png')) {
    const tiffPath = path.replace(/\.png$/i, '.tiff');
    if (manifest[tiffPath]) {
      path = tiffPath;
    }
  }
  return path
}


export const is_image = visualization => {
  const { type='', path } = visualization;
  if (type.startsWith('image'))
    return true;
  if (path === undefined)
    return false;
  return path.endsWith('png') ||
         path.endsWith('jpg') ||
         path.endsWith('jpeg')||
         path.endsWith('bmp') ||
         path.endsWith('pdf') ||
         path.endsWith('tif') ||
         path.endsWith('tiff')||
         path.endsWith('dng') ||
         path.endsWith('raw') ||
         path.endsWith('hex') ;
}
