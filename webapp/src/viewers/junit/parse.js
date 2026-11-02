// Reads JUnit XML test reports, the format most test runners write: pytest (--junitxml), GoogleTest
// (--gtest_output=xml), CTest (--output-junit), Maven Surefire and Gradle, Jest (jest-junit), go-junit-report,
// cargo nextest... Each <testcase> becomes a test: its id, its path in the hierarchy (its classname split on dots,
// then its name), its status, its time, and why it didn't pass.
//
// A small XML scanner reads the file: it's linear, doesn't need a DOM (it works in a Web Worker too), and a 10 MB
// report with 50,000 tests takes about 100 ms. It reads what JUnit reports use: elements, attributes, text, CDATA,
// entities, comments; it rejects unbalanced tags.

export const STATUSES = ['failed', 'error', 'flaky', 'skipped', 'passed'];

const number = value => {
  const n = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// The first line of a failure's message, else the last line of its text (pytest puts the assertion there)
const summary = (message, text) => {
  const first = (message || '').trim().split('\n')[0];
  if (first) return first.slice(0, 500);
  const lines = (text || '').trim().split('\n');
  return lines[lines.length - 1].slice(0, 500);
};

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = text => text.indexOf('&') < 0 ? text : text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, code) => {
  if (code[0] === '#') {
    const value = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    try { return String.fromCodePoint(value); } catch { return entity; }
  }
  return ENTITIES[code] ?? entity;
});

const TOKENS = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTES = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

class XmlError extends Error {}

// Elements as {tagName, attrs, children, parent, text}: `text` is the text and CDATA directly in the element
function parseXml(xml) {
  const root = { tagName: '#document', attrs: {}, children: [], parent: null, text: '' };
  let node = root;
  let last = 0;
  const addText = text => {
    if (!text) return;
    if (text.indexOf('<') >= 0) throw new XmlError(`unexpected "<" near "${text.slice(text.indexOf('<'), text.indexOf('<') + 30)}"`);
    if (node !== root) node.text += decode(text);
    else if (text.trim()) throw new XmlError('text outside of the root element');
  };
  TOKENS.lastIndex = 0;
  let match;
  while ((match = TOKENS.exec(xml))) {
    addText(xml.slice(last, match.index));
    last = TOKENS.lastIndex;
    const [token, cdata, closing, tag, attributes, self_closing] = match;
    if (cdata !== undefined) {
      if (node === root) throw new XmlError('CDATA outside of the root element');
      node.text += cdata;
    } else if (tag === undefined) {
      continue;   // comments, processing instructions, doctype
    } else if (closing) {
      if (node.tagName !== tag) throw new XmlError(`</${tag}> closes <${node.tagName}>`);
      node = node.parent;
    } else {
      const attrs = {};
      if (attributes) {
        ATTRIBUTES.lastIndex = 0;
        let a;
        while ((a = ATTRIBUTES.exec(attributes))) attrs[a[1]] = decode(a[2] ?? a[3]);
      }
      const element = { tagName: tag, attrs, children: [], parent: node, text: '' };
      if (node === root && root.children.length) throw new XmlError(`a second root element <${tag}>`);
      node.children.push(element);
      if (!self_closing) node = element;
    }
    if (token.length === 0) break;
  }
  addText(xml.slice(last));
  if (node !== root) throw new XmlError(`<${node.tagName}> is never closed`);
  if (!root.children.length) throw new XmlError('no root element');
  return root.children[0];
}

// All the text in an element, its children's included, like the DOM's textContent
const textContent = element => element.children.length
  ? element.text + element.children.map(textContent).join('')
  : element.text;

const childText = (element, tag) => {
  for (const child of element.children)
    if (child.tagName === tag) return textContent(child);
  return '';
};

function readCase(element, suite) {
  const attr = name => element.attrs[name] ?? '';
  const classname = attr('classname') || suite || '';
  const name = attr('name');
  let status = 'passed';
  let message = '';
  let text = '';
  let failure_type = '';
  let flaky = null;
  for (const child of element.children) {
    const tag = child.tagName;
    if (tag === 'failure' || tag === 'error') {
      status = tag === 'failure' ? 'failed' : 'error';
      message = child.attrs.message ?? '';
      failure_type = child.attrs.type ?? '';
      text = textContent(child);
      break;
    }
    if (tag === 'skipped') {
      status = 'skipped';
      message = child.attrs.message || textContent(child);
    }
    // Maven Surefire and Gradle: failed, then passed when run again
    if ((tag === 'flakyFailure' || tag === 'flakyError' || tag === 'rerunFailure') && !flaky)
      flaky = child;
  }
  // GoogleTest: DISABLED_ tests are status="notrun", GTEST_SKIP() is result="skipped"
  if (status === 'passed' && (attr('status') === 'notrun' || attr('result') === 'skipped'))
    status = 'skipped';
  if (status === 'passed' && flaky) {
    status = 'flaky';
    message = flaky.attrs.message ?? '';
    failure_type = flaky.attrs.type ?? '';
    text = childText(flaky, 'stackTrace') || textContent(flaky);
  }
  // GoogleTest's suites are "Suite" or "Prefix/Suite": we don't split them
  const path = classname ? [...classname.split('.').filter(Boolean), name] : [name];
  return {
    id: classname ? `${classname}::${name}` : name,
    path,
    name,
    classname,
    suite: suite || '',
    file: attr('file'),
    line: attr('line'),
    status,
    time: number(attr('time')),
    message: status === 'passed' ? '' : summary(message, text),
    failure_type,
    text: text.trim(),
    stdout: childText(element, 'system-out').trim(),
    stderr: childText(element, 'system-err').trim(),
  };
}

// {tests: [...], error: string | null}. Tests with the same id (a test listed twice) get a suffix: #2, #3...
export function parseJunit(xml) {
  if (typeof xml !== 'string' || !xml.trim())
    return { tests: [], error: 'The report is empty' };
  let root;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    return { tests: [], error: `This is not valid XML: ${e.message}` };
  }
  if (!['testsuites', 'testsuite', 'testcase', 'testrun'].includes(root.tagName))
    return { tests: [], error: `This is not a JUnit XML report: its root is <${root.tagName}>` };
  const tests = [];
  const seen = new Map();
  const add = (element, suite) => {
    const test = readCase(element, suite);
    const count = (seen.get(test.id) || 0) + 1;
    seen.set(test.id, count);
    if (count > 1) {
      test.id = `${test.id} #${count}`;
      test.path = [...test.path.slice(0, -1), `${test.name} #${count}`];
    }
    tests.push(test);
  };
  // test cases are in (nested) test suites
  const walk = (element, suite) => {
    for (const child of element.children) {
      if (child.tagName === 'testcase') add(child, suite);
      else if (child.tagName !== 'properties' && child.children.length)
        walk(child, child.tagName === 'testsuite' ? child.attrs.name || suite : suite);
    }
  };
  if (root.tagName === 'testcase') add(root, '');
  else walk(root, root.tagName === 'testsuite' ? root.attrs.name || '' : '');
  return { tests, error: null };
}
