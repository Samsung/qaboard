// llms.txt (https://llmstxt.org): the docs pages, one section per sidebar (audience), each with its frontmatter
// `description`, for coding agents and other LLM tools that read the docs. Written to <baseUrl>llms.txt at build time,
// from the docs plugin's own data, so it can't drift: a new page with a `description` is in it.
// Only for the public site (docusaurus.config.ts): the web app's docs build doesn't add it.
const fs = require('fs');
const path = require('path');

// The doc ids of a sidebar, in order: docs, and categories' own pages. Links to other sidebars are skipped.
function sidebarDocIds(items) {
  const ids = [];
  for (const item of items) {
    if (item.type === 'doc' || item.type === 'ref')
      ids.push(item.id);
    else if (item.type === 'category') {
      if (item.link?.type === 'doc')
        ids.push(item.link.id);
      ids.push(...sidebarDocIds(item.items));
    }
  }
  return ids;
}

// One line, no Markdown links or line breaks: llms.txt list items are "- [title](url): notes"
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

module.exports = function llmsTxtPlugin(context, options) {
  const {siteConfig, outDir} = context;
  const {title, summary, details = [], sections, optional = []} = options;
  // The URLs the site serves and its canonical links use (siteConfig.trailingSlash)
  const absoluteUrl = permalink => siteConfig.url + (siteConfig.trailingSlash && !permalink.endsWith('/') ? `${permalink}/` : permalink);
  let text = null;

  return {
    name: 'qaboard-llms-txt',
    async allContentLoaded({allContent}) {
      const docsContent = allContent['docusaurus-plugin-content-docs']?.default;
      const version = docsContent?.loadedVersions?.[0];
      if (!version)
        throw new Error('[qaboard-llms-txt] no docs found');
      const docs = new Map(version.docs.filter(doc => !doc.unlisted && !doc.draft).map(doc => [doc.id, doc]));
      const listed = new Set();
      const item = doc => `- [${oneLine(doc.title)}](${absoluteUrl(doc.permalink)})${doc.description ? `: ${oneLine(doc.description)}` : ''}`;

      const lines = [`# ${title}`, '', `> ${oneLine(summary)}`, ''];
      for (const paragraph of details)
        lines.push(oneLine(paragraph), '');
      for (const {sidebar, label} of sections) {
        const items = version.sidebars[sidebar];
        if (!items)
          throw new Error(`[qaboard-llms-txt] unknown sidebar: ${sidebar}`);
        lines.push(`## ${label}`, '');
        for (const id of sidebarDocIds(items)) {
          const doc = docs.get(id);
          if (!doc || listed.has(id))
            continue;
          listed.add(id);
          lines.push(item(doc));
        }
        lines.push('');
      }
      // Docs outside the sidebars (the roadmap), then the extra links: what agents can skip
      lines.push('## Optional', '');
      for (const doc of docs.values())
        if (!listed.has(doc.id))
          lines.push(item(doc));
      for (const {title: linkTitle, href, description} of optional)
        lines.push(`- [${linkTitle}](${siteConfig.url}${siteConfig.baseUrl}${href.replace(/^\//, '')}): ${oneLine(description)}`);
      text = lines.join('\n') + '\n';
    },
    async postBuild() {
      if (text)
        fs.writeFileSync(path.join(outDir, 'llms.txt'), text);
    },
  };
};
