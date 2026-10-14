// Understands the YAML files that define batches of tests, to give feedback while they are edited.
// It mirrors how `qa batch` reads them (qaboard/iterators.py:iter_inputs), with PyYAML's YAML 1.1.
import { parseDocument, LineCounter, isMap, isSeq, isScalar, isAlias } from "yaml";

// Top-level keys that are settings for the whole file, not batches
export const SETTINGS_KEYS = ["database", "configs", "configurations", "platform", "matrix"];
const ALIASES_KEYS = ["aliases", "groups"]; // "groups" is the legacy name


const key_name = key => isScalar(key) ? (key.source ?? String(key.value)) : String(key);

const resolve = (node, doc) => isAlias(node) ? node.resolve(doc) : node;

// Returns {line, column, endLine, endColumn} (1-based) for a [start, end] offset range
const position = (range, lineCounter) => {
  const start = lineCounter.linePos(range[0]);
  const end = lineCounter.linePos(Math.max(range[0], range[1] ?? range[0]));
  // empty ranges (e.g. at the end of the file) would be invisible in the editor
  const same = end.line === start.line && end.col <= start.col;
  return { line: start.line, column: start.col, endLine: end.line, endColumn: same ? start.col + 1 : end.col };
};

// What PyYAML (`qa batch`) reads unquoted scalars as, when they are not text.
// Its YAML 1.1 differs from the yaml package's: y/n, 08 or 1e3 are text for PyYAML (see yaml/resolver.py).
const PYYAML_SCALARS = [
  ["empty", /^(?:~|null|Null|NULL|)$/],
  ["true or false", /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/],
  ["a number", /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/],
  ["a number", /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/],
  ["a date", /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/],
];
const pyyamlScalar = scalar => scalar.type === "PLAIN" ? PYYAML_SCALARS.find(([, pattern]) => pattern.test(scalar.source ?? ""))?.[0] : undefined;

// "Bad indentation of a sequence entry at line 3, column 5:\n\n<snippet>" -> "Bad indentation of a sequence entry"
const short_message = message => message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "").replace(/:$/, "");


/**
 * Analyzes the content of a batches file.
 * @returns {{
 *   problems: {severity: 'error'|'warning', message: string, line: number, column: number, endLine: number, endColumn: number}[],
 *   items: {name: string, kind: 'batch'|'pipeline'|'alias'|'setting', line: number, inputs?: number, targets?: string[], overridden_by?: number}[],
 * }}
 */
export function analyzeBatches(text) {
  const lineCounter = new LineCounter();
  // Duplicate keys are allowed by PyYAML (the last one wins): we only warn about them
  const doc = parseDocument(text ?? "", { version: "1.1", uniqueKeys: false, lineCounter });
  const problems = [];
  const items = [];

  // Errors often cascade from the first one, which is also the only one PyYAML reports
  for (const error of doc.errors.slice(0, 1))
    problems.push({ severity: "error", message: short_message(error.message), ...position(error.pos, lineCounter) });
  for (const warning of doc.warnings)
    problems.push({ severity: "warning", message: short_message(warning.message), ...position(warning.pos, lineCounter) });

  const contents = doc.contents;
  if (contents === null || contents === undefined) // empty, or only comments
    return { problems, items };
  if (!isMap(contents)) {
    problems.push({
      severity: "error",
      message: "The file must be a mapping of batch names to their definitions, like `my-batch: {inputs: [a.jpg]}`",
      ...position(contents.range ?? [0, 0], lineCounter),
    });
    return { problems, items };
  }

  const seen = {};
  const add = (item, key) => {
    const where = position(key.range ?? [0, 0], lineCounter);
    const id = `${item.kind === 'alias' ? 'alias' : 'key'}:${item.name}`;
    if (seen[id] !== undefined)
      problems.push({
        severity: "warning",
        message: `"${item.name}" is defined twice (also line ${seen[id]}). Only the last definition is used.`,
        ...where,
      });
    if (seen[id] !== undefined)
      items.find(i => i.line === seen[id]).overridden_by = where.line;
    seen[id] = where.line;
    items.push({ ...item, line: where.line });
  };

  for (const pair of contents.items) {
    if (!pair.key) continue;
    const name = key_name(pair.key);
    const value = resolve(pair.value, doc);
    if (name.startsWith(".")) continue; // hidden, e.g. used to define YAML anchors
    if (SETTINGS_KEYS.includes(name)) {
      add({ name, kind: "setting" }, pair.key);
      continue;
    }
    if (ALIASES_KEYS.includes(name)) {
      if (isMap(value)) {
        for (const alias of value.items) {
          if (!alias.key) continue;
          const targets = resolve(alias.value, doc);
          add({
            name: key_name(alias.key),
            kind: "alias",
            targets: isSeq(targets) ? targets.items.map(t => key_name(resolve(t, doc))) : isScalar(targets) ? [key_name(targets)] : [],
          }, alias.key);
        }
      } else if (value !== null && value !== undefined && !(isScalar(value) && value.value === null)) {
        problems.push({
          severity: "error",
          message: `"${name}" must be a mapping of alias names to lists of batches`,
          ...position(pair.key.range, lineCounter),
        });
      }
      continue;
    }
    const inputs = isMap(value) ? resolve(value.get("inputs", true), doc) : value;
    const kind = isMap(value) && value.get("type") === "pipeline" ? "pipeline" : "batch";
    if (isSeq(value))
      problems.push({
        severity: "warning",
        message: `"${name}" is a list, not a batch: running it fails. Write its inputs under "inputs:", or group batches under "aliases:"`,
        ...position(pair.key.range, lineCounter),
      });
    // `qa batch` only understands inputs that are text, lists or mappings
    else if (isSeq(inputs))
      for (const node of inputs.items) {
        const item = resolve(node, doc);
        const read_as = isScalar(item) && pyyamlScalar(item);
        if (!read_as) continue;
        const [start] = item.range ?? [0];
        problems.push(read_as === "empty"
          ? { severity: "error", message: `Empty input in "${name}": remove this "-", or write the input after it`, ...position(item.source ? item.range : [Math.max(0, start - 1), start], lineCounter) }
          : { severity: "error", message: `YAML reads ${item.source} as ${read_as}, not a path: write it in quotes`, ...position(item.range, lineCounter) });
      }
    add({
      name,
      kind,
      inputs: isSeq(inputs) ? inputs.items.length : isMap(inputs) ? inputs.items.length : undefined,
    }, pair.key);
  }
  return { problems, items };
}


// The YAML we insert when users click "New batch"
export const newBatchSnippet = (text, name = "my-new-batch") => {
  const prefix = text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${name}:\n  inputs:\n  - path/to/an/input\n`;
};

// A batch name that is not used yet in the file
export const unusedBatchName = (items, base = "my-new-batch") => {
  const names = new Set(items.map(i => i.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
};
