export const iiif_url = (output_dir_url, path) => {
  // remove the URL's leading "/s"
  let identifier = output_dir_url.replace(/\/*?s\//, "")
  // IIIF specs require encoding the slashes inside the identifier
  identifier = `${identifier}/${encodeURI(decodeURIComponent(path))}`.replace(/\//g, '%2F');
  let url = `/iiif/2/${identifier}`
  return url
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
         path.endsWith('tiff');
}