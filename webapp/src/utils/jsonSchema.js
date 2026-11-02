// Checks values against our JSON schemas (qaboard/schemas/), with messages written for people editing YAML.
// It supports the keywords our schemas use (SUPPORTED_KEYWORDS, a test checks it), not all of JSON Schema.
// We don't use a generic validator: their messages for anyOf are hard to read, and some compile schemas with eval.

export const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "$comment", "title", "description", "default", "examples", "deprecated",
  "type", "enum", "const", "properties", "patternProperties", "additionalProperties", "minProperties",
  "items", "prefixItems", "minItems", "anyOf",
]);


const typeOf = value => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value; // string, boolean, object
};
const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

const TYPE_NAMES = {
  object: "a mapping", array: "a list", string: "text", number: "a number", integer: "an integer",
  boolean: "true or false", null: "empty", date: "a date",
};
const describeValue = value => typeOf(value) === "string" ? `"${value}"` : TYPE_NAMES[typeOf(value)];
const orList = items => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

// my-batch.inputs[2]
export const formatPath = path => path.reduce((text, part) => typeof part === "number"
  ? `${text}[${part}]`
  : text ? `${text}.${part}` : String(part), "");

// Edits to go from a to b, a swap of neighbor letters counting as one (optimal string alignment)
const distance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i || j));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
};
export const didYouMean = (word, candidates) => {
  const lower = String(word).toLowerCase();
  const best = candidates
    .map(c => ({ c, d: distance(lower, c.toLowerCase()) }))
    .filter(({ c, d }) => d <= Math.max(1, Math.floor(c.length / 3)))
    .sort((a, b) => a.d - b.d)[0];
  return best ? ` Did you mean "${best.c}"?` : "";
};
const hint = (word, candidates) => {
  const suggestion = didYouMean(word, candidates);
  return suggestion && `.${suggestion}`;
};


/**
 * Makes a validator for schemas that can reference each other by $id (e.g. "batches.schema.json#/$defs/database").
 * validate(value, schema) => [{path, message, kind, key?}]
 * - kind: "type" | "enum" | "unknown-key" | "deprecated" | "empty"
 * - key: true when the problem is about a mapping's key (the last part of path), e.g. an unknown key
 */
export function makeValidator(schemas) {
  const byName = {};
  for (const schema of schemas)
    if (schema.$id) byName[schema.$id.split("/").pop()] = schema;

  const resolve = (schema, root) => {
    let seen = 0;
    while (schema.$ref) {
      if (seen++ > 20) throw new Error(`Circular $ref: ${schema.$ref}`);
      const [file, pointer = ""] = schema.$ref.split("#");
      const base = file ? byName[file.split("/").pop()] : root;
      if (!base) throw new Error(`Unknown schema: ${file}`);
      let target = base;
      for (const part of pointer.split("/").filter(Boolean)) target = target?.[part];
      if (!target) throw new Error(`Unknown $ref: ${schema.$ref}`);
      // keywords next to $ref (e.g. a description) refine the target
      const { $ref: _ref, ...rest } = schema;
      schema = { ...target, ...rest };
      root = base;
    }
    return { schema, root };
  };

  // Does the value pass, ignoring deprecations?
  const passes = (value, schema, root) => check(value, schema, root, []).every(p => p.kind === "deprecated");

  function check(value, schema, root, path) {
    if (schema === true || schema === undefined) return [];
    if (schema === false) return [{ path, message: `"${formatPath(path)}" is not allowed here`, kind: "unknown-key", key: true }];
    ({ schema, root } = resolve(schema, root));
    const problems = [];
    const name = formatPath(path);

    if (schema.deprecated && value !== undefined)
      problems.push({ path, kind: "deprecated", key: true, message: `"${name}" is deprecated${schema.description ? `: ${schema.description}` : "."}` });

    if (schema.anyOf) {
      const branches = schema.anyOf.map(branch => resolve(branch, root));
      if (!branches.some(b => passes(value, b.schema, b.root))) {
        // Explain why the branch of the right type fails, else which types are expected
        const sameType = branches.filter(b => !b.schema.type || [b.schema.type].flat().some(t => matchesType(value, t)));
        if (sameType.length > 0) {
          const explained = sameType
            .map(b => check(value, b.schema, b.root, path).filter(p => p.kind !== "deprecated"))
            .sort((a, b) => a.length - b.length)[0];
          problems.push(...explained);
        } else {
          const expected = [...new Set(branches.flatMap(b => [b.schema.type ?? []].flat()).map(t => TYPE_NAMES[t]))];
          problems.push({ path, kind: "type", message: `"${name}" should be ${orList(expected)}, not ${describeValue(value)}` });
        }
      }
    }

    if (schema.type) {
      const types = [schema.type].flat();
      if (!types.some(t => matchesType(value, t))) {
        problems.push({ path, kind: "type", message: `"${name}" should be ${orList(types.map(t => TYPE_NAMES[t]))}, not ${describeValue(value)}` });
        return problems;
      }
    }
    if (schema.const !== undefined && value !== schema.const)
      problems.push({ path, kind: "enum", message: `"${name}" should be ${JSON.stringify(schema.const)}, not ${describeValue(value)}` });
    if (schema.enum && !schema.enum.includes(value)) {
      const options = schema.enum.map(v => JSON.stringify(v));
      const suggestion = typeof value === "string" ? hint(value, schema.enum.filter(v => typeof v === "string")) : "";
      problems.push({ path, kind: "enum", message: `"${name}" should be ${orList(options)}, not ${describeValue(value)}${suggestion}` });
    }

    const type = typeOf(value);
    if (type === "object") {
      const keys = Object.keys(value);
      if (schema.minProperties && keys.length < schema.minProperties)
        problems.push({ path, kind: "empty", message: `"${name}" should not be empty` });
      const known = Object.keys(schema.properties ?? {});
      for (const key of keys) {
        const keyPath = [...path, key];
        if (schema.properties && Object.hasOwn(schema.properties, key)) {
          problems.push(...check(value[key], schema.properties[key], root, keyPath));
          continue;
        }
        const pattern = Object.keys(schema.patternProperties ?? {}).find(p => new RegExp(p, "u").test(key));
        if (pattern !== undefined) {
          problems.push(...check(value[key], schema.patternProperties[pattern], root, keyPath));
          continue;
        }
        if (schema.additionalProperties === false) {
          problems.push({
            path: keyPath, kind: "unknown-key", key: true,
            message: `Unknown key "${key}"${path.length ? ` in "${name}"` : ""}${hint(key, known)}`,
          });
        } else if (schema.additionalProperties !== undefined) {
          problems.push(...check(value[key], schema.additionalProperties, root, keyPath));
        }
      }
    }

    if (type === "array") {
      if (schema.minItems && value.length < schema.minItems)
        problems.push({ path, kind: "empty", message: `"${name}" should not be empty` });
      value.forEach((item, idx) => {
        const itemSchema = schema.prefixItems?.[idx] ?? schema.items;
        if (itemSchema !== undefined) problems.push(...check(item, itemSchema, root, [...path, idx]));
      });
    }
    return problems;
  }

  return (value, schema) => check(value, schema, schema, []);
}
