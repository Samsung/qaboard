export const iiif_url = (output_dir_url, path) => {
  // we only serve data from there
  let identifier = output_dir_url.replace("/stage/algo_data", "")
  // remove the URL' leading "/s"
  identifier = identifier.replace(/\/*?s\//, "")
  identifier = `${identifier}/${path}`;
  // IIIF specs require encoding the slashes inside the identifier
  let is_cde_file = identifier.endsWith('dng') || identifier.endsWith('raw') || identifier.endsWith('hex')
  let endpoint = is_cde_file
    ? `${window.location.protocol}//${window.location.hostname}:8186/fcgi-bin/iipsrv.fcgi?IIIF=`
    : `${window.location.protocol}//${window.location.hostname}:8183/iiif/2/`
  if (process.env.NODE_ENV !== 'production') {
    endpoint = is_cde_file
      ? `/fcgi-bin/iipsrv.fcgi?IIIF=`
      : `/iiif/2/`
  }
  identifier = encodeURIComponent(identifier)
  let url = `${endpoint}${identifier}`
  return url
}

