export const iiif_url = (output_dir_url, path) => {
  // remove the URL's leading "/s"
  let identifier = output_dir_url.replace(/^\/*?s\//, "")
  // /algo/CIS/inputs is a symlink to /algo/CIS_inputs but in the IIIF container it breaks
  // because folders are mounted under /var/www/localhost/images  
  identifier = identifier.replace(/\/algo\/([A-Za-z0-9]*)\/inputs/, "/algo/$1_inputs")
  // IIIF specs require encoding the slashes inside the identifier
  identifier = `${identifier}/${encodeURI(decodeURIComponent(path))}`.replace(/\//g, '%2F');
  let is_cde_file = identifier.endsWith('dng') || identifier.endsWith('raw') || identifier.endsWith('hex')
  let endpoint = is_cde_file ? "/iiif/cde?IIIF=" : "https://cantaloupe-svc.transchip.com/iiif/2/"
  let url = `${endpoint}${identifier}`
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
         path.endsWith('tiff')||
         path.endsWith('dng') ||
         path.endsWith('raw') ||
         path.endsWith('hex') ;
}