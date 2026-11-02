// <RepoFile path="charts/qaboard/kind.yaml" />: shows a file of the repository in a code block, imported raw at build
// time, so the docs always show the file as it is (website/src/components/RepoFile). This remark plugin adds
//   import __repoFile0 from "@site/../charts/qaboard/kind.yaml?raw";
// to the page, and source={__repoFile0} to the element. Webpack then tracks the file like any other import.
// The `?raw` rule is in ./index.js. Paths are relative to the repository's root.
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Files that webpack already handles with other loaders: their `?raw` import wouldn't be the raw file
const UNSUPPORTED = /\.(mdx?|[cm]?[jt]sx?|css|scss|svg|png|jpe?g|gif|webp|avif|ico)$/i;

const isRepoFile = node => (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'RepoFile';

function identifier(name) {
  return {type: 'Identifier', name};
}

function importNode(name, source) {
  const raw = JSON.stringify(source);
  return {
    type: 'mdxjsEsm',
    value: `import ${name} from ${raw};`,
    data: {
      estree: {
        type: 'Program',
        sourceType: 'module',
        comments: [],
        body: [{
          type: 'ImportDeclaration',
          specifiers: [{type: 'ImportDefaultSpecifier', local: identifier(name)}],
          source: {type: 'Literal', value: source, raw},
          attributes: [],
        }],
      },
    },
  };
}

function expressionAttribute(name, variable) {
  return {
    type: 'mdxJsxAttribute',
    name,
    value: {
      type: 'mdxJsxAttributeValueExpression',
      value: variable,
      data: {estree: {type: 'Program', sourceType: 'module', comments: [], body: [{type: 'ExpressionStatement', expression: identifier(variable)}]}},
    },
  };
}

/** The repository path of a <RepoFile>, checked; throws with the page and line otherwise. */
function resolveRepoPath(node, file) {
  const where = `${path.relative(REPO_ROOT, file.path ?? '')}:${node.position?.start?.line ?? '?'}`;
  const attr = node.attributes?.find(a => a.type === 'mdxJsxAttribute' && a.name === 'path');
  if (typeof attr?.value !== 'string')
    throw new Error(`${where}: <RepoFile> needs a literal path, relative to the repository's root, e.g. path="charts/qaboard/kind.yaml"`);
  const repoPath = path.posix.normalize(attr.value);
  if (repoPath.startsWith('../') || path.isAbsolute(repoPath))
    throw new Error(`${where}: <RepoFile path="${attr.value}">: the path must be inside the repository, relative to its root`);
  if (UNSUPPORTED.test(repoPath))
    throw new Error(`${where}: <RepoFile path="${attr.value}">: webpack has its own loader for this kind of file, so it can't be shown raw`);
  if (!fs.statSync(path.join(REPO_ROOT, repoPath), {throwIfNoEntry: false})?.isFile())
    // The website's docker image only has the files website/Dockerfile.dockerignore lets in
    throw new Error(`${where}: <RepoFile path="${attr.value}">: no such file in the repository (when building the website's image, check website/Dockerfile.dockerignore)`);
  return repoPath;
}

function remarkRepoFile() {
  return (tree, file) => {
    const imports = [];
    const visit = node => {
      if (isRepoFile(node)) {
        const repoPath = resolveRepoPath(node, file);
        const name = `__repoFile${imports.length}`;
        imports.push(importNode(name, `@site/../${repoPath}?raw`));
        node.attributes = node.attributes.filter(a => a.name !== 'source');
        node.attributes.push(expressionAttribute('source', name));
      }
      (node.children ?? []).forEach(visit);
    };
    visit(tree);
    tree.children.unshift(...imports);
  };
}

module.exports = remarkRepoFile;
module.exports.REPO_ROOT = REPO_ROOT;
