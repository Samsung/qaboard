// Linux <=> Windows paths, with the path mappings from /api/v1/config (via setPathMappings).
// Each entry is [windows_prefix, linux_prefix], e.g. ["\\\\netapp\\algo", "/algo"]
// Kept apart from utils.js so that small pages (e.g. the file browser) can use it without utils.js's dependencies.
let _path_mappings = [];

const setPathMappings = (mappings) => {
  _path_mappings = mappings || [];
};

const hasPathMappings = () => _path_mappings.length > 0

// "/algo/a b" => "\\netapp\algo\a b"
const path_to_windows = path => {
  for (const [windows_prefix, linux_prefix] of _path_mappings) {
    if (path.startsWith(linux_prefix)) {
      // Convert backslashes in windows_prefix to forward slashes for matching,
      // then convert everything to backslashes at the end
      const win = windows_prefix.replace(/\\/g, '/')
      return (win + path.slice(linux_prefix.length)).replace(/\//g, '\\')
    }
  }
  return path.replace(/\//g, '\\')
}

// For URLs of files, e.g. "/s/algo/a%20b" => "\\netapp\algo\a b"
const linux_to_windows = path => {
  if (path === undefined || path === null)
    return path
  return path_to_windows(decodeURI(path).replace(/\/s\//, '/'))
}

// "\\netapp\algo\x" or "//netapp/algo/x" => "/algo/x", null if no mapping applies
const windows_to_linux = path => {
  const normalized = path.replace(/\\/g, '/')
  for (const [windows_prefix, linux_prefix] of _path_mappings) {
    const win = windows_prefix.replace(/\\/g, '/').replace(/\/+$/, '')
    const rest = normalized.slice(win.length)
    if (normalized.toLowerCase().startsWith(win.toLowerCase()) && (rest === '' || rest.startsWith('/')))
      return linux_prefix.replace(/\/+$/, '') + rest
  }
  return null
}

// Links to folders under /s/ end with "/": they open the file browser even when the folder doesn't exist (yet),
// e.g. for runs that failed or didn't start, instead of nginx's 404 page. And nginx doesn't need to redirect.
const folder_url = url => !url || url.endsWith('/') ? url : `${url}/`

export { setPathMappings, hasPathMappings, path_to_windows, linux_to_windows, windows_to_linux, folder_url }
