// Build checks for the stack picker's tab groups (src/components/stack.ts, docs-media/README.md#stackpicker).
// In every page, <Tabs groupId="<a stack group>"> must:
// - have `queryString`, so links like ?server=k8s select it;
// - only have <TabItem>s with the group's values and labels;
// - put `default` on the group's default value, if on any.
// <StackPicker groups={[...]}> must list known groups. Problems fail `docusaurus build`, and are warnings with `yarn start`.
const fs = require('fs');
const path = require('path');
const logger = require('@docusaurus/logger').default;
const {loadFreshModule} = require('@docusaurus/utils');
const {getParser, walk, CONTENT_DIRS} = require('../media/scan');
const {isBuildCommand} = require('../media/config');

const STACK_FILE = path.join('src', 'components', 'stack.ts');

const literal = attr => (attr && (typeof attr.value === 'string' ? attr.value : null));
const attribute = (node, name) => node.attributes?.find(a => a.type === 'mdxJsxAttribute' && a.name === name);
const isElement = (node, name) => (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === name;

function checkTree(tree, groups) {
  const problems = [];
  const report = (node, message) => problems.push({line: node.position?.start?.line, message});
  const visit = node => {
    if (isElement(node, 'Tabs')) {
      const groupId = literal(attribute(node, 'groupId'));
      const group = groups.find(g => g.id === groupId);
      if (group) {
        if (!attribute(node, 'queryString'))
          report(node, `<Tabs groupId="${groupId}">: add queryString, so that links like ?${groupId}=${group.options[1]?.value ?? group.options[0].value} select the tab`);
        const items = [];
        const findItems = child => (isElement(child, 'TabItem') ? items.push(child) : (child.children ?? []).forEach(findItems));
        (node.children ?? []).forEach(findItems);
        for (const item of items) {
          const value = literal(attribute(item, 'value'));
          const option = group.options.find(o => o.value === value);
          if (!option) {
            report(item, `<TabItem value="${value}"> in <Tabs groupId="${groupId}">: use one of ${group.options.map(o => o.value).join(', ')} (src/components/stack.ts)`);
            continue;
          }
          const label = literal(attribute(item, 'label'));
          if (label !== option.label)
            report(item, `<TabItem value="${value}">: its label must be "${option.label}", like everywhere else (src/components/stack.ts)`);
          if (attribute(item, 'default') && value !== group.options[0].value)
            report(item, `<TabItem value="${value}" default>: the default of the "${groupId}" group is ${group.options[0].value}`);
        }
      }
    }
    if (isElement(node, 'StackPicker')) {
      const elements = attribute(node, 'groups')?.value?.data?.estree?.body?.[0]?.expression?.elements;
      for (const element of elements ?? []) {
        if (element?.type !== 'Literal' || !groups.some(g => g.id === element.value))
          report(node, `<StackPicker groups>: ${element?.value ?? 'a non-literal'} isn't a stack group; use ${groups.map(g => g.id).join(', ')}`);
      }
    }
    (node.children ?? []).forEach(visit);
  };
  visit(tree);
  return problems;
}

module.exports = function qaboardStackPlugin(context) {
  const {siteDir} = context;
  return {
    name: 'qaboard-stack',

    getPathsToWatch() {
      return [path.join(siteDir, STACK_FILE)];
    },

    async loadContent() {
      const loaded = await loadFreshModule(path.join(siteDir, STACK_FILE));
      const groups = Array.isArray(loaded) ? loaded : loaded.STACK_GROUPS ?? loaded.default;
      const parse = await getParser();
      const errors = [];
      for (const dir of CONTENT_DIRS) {
        for (const file of walk(path.join(siteDir, dir), ['.md', '.mdx'])) {
          const content = fs.readFileSync(file, 'utf8');
          if (!/<(Tabs|StackPicker)\b/.test(content))
            continue;
          let tree;
          try {
            tree = parse(content);
          } catch {
            continue; // the MDX loader reports it, with more context
          }
          const relative = path.relative(siteDir, file);
          checkTree(tree, groups).forEach(({line, message}) => errors.push(`${relative}:${line}: ${message}`));
        }
      }
      if (errors.length) {
        const message = `[qaboard-stack] ${errors.length} problem(s) with the stack tabs:\n${errors.map(e => `  ${e}`).join('\n')}`;
        if (isBuildCommand())
          throw new Error(message);
        logger.warn(message);
      }
    },
  };
};

module.exports.checkTree = checkTree;
