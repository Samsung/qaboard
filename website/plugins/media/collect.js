// Finds the media components in MDX trees and in JS/TS sources, with their literal props.
// An element: {component, props: {id?, before?, after?}, anchors: [names used in callouts], line, problems: []}

// The components and their shot id props
const COMPONENTS = {Shot: ['id'], Clip: ['id'], Compare: ['before', 'after']};
const ID_PROPS = new Set(Object.values(COMPONENTS).flat());

// A string literal in an MDX expression, e.g. id={"commit/flame-diff"} or id={`commit/flame-diff`}
function literalOfExpression(program) {
  const statement = program?.body?.length === 1 ? program.body[0] : null;
  const expr = statement?.type === 'ExpressionStatement' ? statement.expression : null;
  if (expr?.type === 'Literal' && typeof expr.value === 'string')
    return expr.value;
  if (expr?.type === 'TemplateLiteral' && expr.expressions.length === 0)
    return expr.quasis.map(q => q.value.cooked).join('');
  return null;
}

// The `anchor: '...'` values of a callouts={[...]} expression
function anchorsOfExpression(node, anchors = []) {
  if (!node || typeof node !== 'object')
    return anchors;
  if (Array.isArray(node)) {
    node.forEach(child => anchorsOfExpression(child, anchors));
    return anchors;
  }
  if (node.type === 'Property') {
    const key = node.key?.type === 'Identifier' ? node.key.name : node.key?.value;
    if (key === 'anchor' && node.value?.type === 'Literal' && typeof node.value.value === 'string')
      anchors.push(node.value.value);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'range' && key !== 'position' && child && typeof child === 'object')
      anchorsOfExpression(child, anchors);
  }
  return anchors;
}

function collectFromTree(tree) {
  const elements = [];
  const walk = node => {
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && COMPONENTS[node.name]) {
      const element = {component: node.name, props: {}, anchors: [], line: node.position?.start?.line, problems: []};
      for (const attr of node.attributes ?? []) {
        if (attr.type === 'mdxJsxExpressionAttribute') {
          element.problems.push(`<${node.name} {...}>: spread props can't be checked, write each prop as a literal`);
          continue;
        }
        const {name, value} = attr;
        if (ID_PROPS.has(name)) {
          const literal = typeof value === 'string' ? value : literalOfExpression(value?.data?.estree);
          if (literal === null)
            element.problems.push(`<${node.name} ${name}=...>: must be a literal string, e.g. ${name}="commit/image-diff"`);
          else
            element.props[name] = literal;
        } else if (name === 'callouts' && value?.data?.estree) {
          element.anchors.push(...anchorsOfExpression(value.data.estree.body));
        }
      }
      elements.push(element);
    }
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
  return elements;
}

/**
 * A remark plugin: collects the media components of a document in file.data.qaboardMedia,
 * and calls options.onElements(elements, file) when given.
 */
function remarkCollectMedia(options = {}) {
  return (tree, file) => {
    const elements = collectFromTree(tree);
    file.data.qaboardMedia = elements;
    options.onElements?.(elements, file);
  };
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// Comments are blanked (keeping line numbers), so that examples in comments don't count
function stripJsComments(text) {
  const blank = match => match.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\])\/\/[^\n]*/g, (match, before) => before + blank(match.slice(before.length)));
}

/**
 * The media components in JS/TS sources (e.g. the landing page), found with regular expressions since
 * their props are literals. The string literals that look like shot ids are returned in `strings` ({value, line}):
 * an id kept in an array counts as used.
 */
function collectFromJs(source) {
  const text = stripJsComments(source);
  const elements = [];
  const tagRe = /<(Shot|Clip|Compare)\b((?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*)>/g;
  for (const tag of text.matchAll(tagRe)) {
    const [, component, attrs] = tag;
    const element = {component, props: {}, anchors: [], line: lineAt(text, tag.index), problems: []};
    const propRe = /(?:^|\s)(id|before|after)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}|(\{))/g;
    for (const prop of attrs.matchAll(propRe)) {
      // A variable (e.g. clips.map(c => <Clip id={c.id} />)) is fine: the ids are string literals elsewhere
      const value = prop.slice(2, 7).find(v => v !== undefined);
      if (value !== undefined)
        element.props[prop[1]] = value;
      else
        element.dynamic = true;
    }
    for (const anchor of attrs.matchAll(/\banchor\s*:\s*["']([^"']+)["']/g))
      element.anchors.push(anchor[1]);
    elements.push(element);
  }
  const strings = [...text.matchAll(/(["'`])([a-z0-9-]+\/[a-z0-9-]+)\1/g)].map(m => ({value: m[2], line: lineAt(text, m.index)}));
  return {elements, strings};
}

module.exports = {COMPONENTS, collectFromTree, remarkCollectMedia, collectFromJs};
