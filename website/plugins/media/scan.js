// Collects the media components used by every page of the site, before webpack runs.
// The MDX loader's results can come from webpack's persistent cache, so the build checks parse the sources
// themselves, with the same parser and plugins as Docusaurus' MDX loader.
const fs = require('fs');
const path = require('path');
const {createRequire} = require('module');
const {pathToFileURL} = require('url');
const {collectFromTree, collectFromJs} = require('./collect');

// Content folders, relative to the website. site-docs/ holds every site's docs: they are scanned even when
// QABOARD_SITE doesn't build them, so that a typo there fails too.
const CONTENT_DIRS = ['docs', 'blog', 'release-notes', 'src/pages', 'site-docs'];
const SOURCE_DIR = 'src';
// The components themselves, and the theme's mapping, use ids as variables
const SOURCE_EXCLUDES = /(^|\/)(components\/(Shot|Clip|Compare|StackPicker)(\.[jt]sx?|\/)|components\/media\/|theme\/MDXComponents\.[jt]sx?)/;

function walk(dir, extensions, files = []) {
  if (!fs.existsSync(dir))
    return files;
  for (const dirent of fs.readdirSync(dir, {withFileTypes: true})) {
    if (dirent.name === 'node_modules' || dirent.name.startsWith('.'))
      continue;
    const file = path.join(dir, dirent.name);
    if (dirent.isDirectory())
      walk(file, extensions, files);
    else if (extensions.includes(path.extname(dirent.name)))
      files.push(file);
  }
  return files;
}

let parserPromise = null;
// The MDX parser with Docusaurus' syntax extensions (front matter, admonitions, GFM, HTML comments)
async function getParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      const mdxLoaderRequire = createRequire(require.resolve('@docusaurus/mdx-loader'));
      const load = async name => (await import(pathToFileURL(mdxLoaderRequire.resolve(name)).href)).default;
      const {createProcessor} = await import(pathToFileURL(mdxLoaderRequire.resolve('@mdx-js/mdx')).href);
      const remarkPlugins = await Promise.all(
        ['remark-frontmatter', 'remark-directive', 'remark-gfm', '@slorber/remark-comment'].map(load));
      const processor = createProcessor({format: 'mdx', remarkPlugins});
      const utils = createRequire(require.resolve('@docusaurus/core/package.json'))('@docusaurus/utils');
      return content => processor.parse(utils.escapeMarkdownHeadingIds(utils.unwrapMdxCodeBlocks(content)));
    })();
  }
  return parserPromise;
}

/**
 * Returns {files: [{file, elements}], strings: [{file, line, value}] (id-like string literals in JS/TS sources),
 * parseErrors: [{file, message}]}. Paths are relative to siteDir.
 */
async function scanSite(siteDir) {
  const parse = await getParser();
  const files = [];
  const parseErrors = [];
  for (const dir of CONTENT_DIRS) {
    for (const file of walk(path.join(siteDir, dir), ['.md', '.mdx'])) {
      const relative = path.relative(siteDir, file);
      const content = fs.readFileSync(file, 'utf8');
      if (!/<(Shot|Clip|Compare)\b/.test(content))
        continue;
      try {
        files.push({file: relative, elements: collectFromTree(parse(content))});
      } catch (error) {
        // The MDX loader reports it with more context
        parseErrors.push({file: relative, message: error.message});
      }
    }
  }
  const strings = [];
  for (const file of walk(path.join(siteDir, SOURCE_DIR), ['.js', '.jsx', '.ts', '.tsx'])) {
    const relative = path.relative(siteDir, file);
    if (SOURCE_EXCLUDES.test(relative.split(path.sep).join('/')))
      continue;
    const found = collectFromJs(fs.readFileSync(file, 'utf8'));
    found.strings.forEach(s => strings.push({file: relative, ...s}));
    if (found.elements.length)
      files.push({file: relative, elements: found.elements});
  }
  return {files, strings, parseErrors};
}

module.exports = {scanSite, getParser, walk, CONTENT_DIRS};
