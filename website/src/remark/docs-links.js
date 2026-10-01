// Release notes link to the docs as /docs/page-id (the web app resolves those links too).
// In the build for the web app the docs are served at /docs/ with routeBasePath '/':
// /docs/page-id must become /page-id, the baseUrl (/docs/) is then prepended.
function rewriteDocsLinks() {
  const visit = node => {
    if ((node.type === 'link' || node.type === 'definition') && node.url?.startsWith('/docs/'))
      node.url = node.url.slice('/docs'.length);
    (node.children || []).forEach(visit);
  };
  return tree => visit(tree);
}

module.exports = rewriteDocsLinks;
