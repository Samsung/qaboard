import batchesSchema from 'qaboard-schemas/batches.schema.json';
import qaboardSchema from 'qaboard-schemas/qaboard.schema.json';
import { makeValidator, SUPPORTED_KEYWORDS, formatPath, didYouMean } from '../jsonSchema';

const validate = makeValidator([batchesSchema, qaboardSchema]);
const messages = (value, schema = batchesSchema) => validate(value, schema).map(p => p.message);


describe('our schemas', () => {
  it('only use the keywords the validator supports', () => {
    const unsupported = new Set();
    const walk = (schema, inValues = false) => {
      if (!schema || typeof schema !== 'object') return;
      if (Array.isArray(schema)) return schema.forEach(s => walk(s));
      for (const [key, value] of Object.entries(schema)) {
        if (!inValues && !SUPPORTED_KEYWORDS.has(key)) unsupported.add(key);
        if (['properties', 'patternProperties', '$defs'].includes(key)) Object.values(value).forEach(s => walk(s));
        else if (!['enum', 'const', 'default', 'examples', 'type', 'description', 'title'].includes(key)) walk(value);
      }
    };
    walk(batchesSchema);
    walk(qaboardSchema);
    expect([...unsupported]).toEqual([]);
  });

  it('resolve every $ref', () => {
    expect(() => validate({ a: { inputs: [], lsf: {}, database: '/' } }, batchesSchema)).not.toThrow();
    expect(() => validate({ inputs: { database: '/', types: { a: { runners: { lsf: {} } } } }, storage: '/', lsf: {} }, qaboardSchema)).not.toThrow();
  });
});


describe('makeValidator', () => {
  it('accepts valid batches', () => {
    expect(messages({
      database: { linux: '/mnt', windows: '//mnt' },
      '.anchors': { whatever: 1 },
      a: { inputs: ['a.jpg', ['b.jpg', 'base'], { 'c.jpg': { threshold: 2 } }], matrix: { size: [1, 2] }, lsf: { queue: 'q' } },
      b: { inputs: { 'x.jpg': null } },
      aliases: { all: ['a', 'b'], one: 'a' },
    })).toEqual([]);
    expect(messages(null)).toEqual([]);
  });

  it('reports unknown keys, with suggestions', () => {
    expect(validate({ a: { inpts: ['a.jpg'] } }, batchesSchema)).toEqual([
      { path: ['a', 'inpts'], kind: 'unknown-key', key: true, message: 'Unknown key "inpts" in "a". Did you mean "inputs"?' },
    ]);
    expect(messages({ a: { lsf: { max_memmory: 1 } } })).toEqual(['Unknown key "max_memmory" in "a.lsf". Did you mean "max_memory"?']);
    expect(messages({ projet: {} }, qaboardSchema)).toEqual(['Unknown key "projet". Did you mean "project"?']);
  });

  it('reports wrong types, explaining the alternative of the same type', () => {
    expect(messages({ a: { matrix: { size: 320 } } })).toEqual(['"a.matrix.size" should be a list, not an integer']);
    expect(messages({ a: { inputs: [true] } })).toEqual(['"a.inputs[0]" should be text, a list or a mapping, not true or false']);
    expect(messages({ a: { inputs: [[]] } })).toEqual(['"a.inputs[0]" should not be empty']);
    expect(messages({ a: ['a.jpg'] })).toEqual(['"a" should be a mapping, not a list']);
  });

  it('reports enums and deprecations', () => {
    expect(messages({ a: { runner: 'lfs' } })).toEqual(['"a.runner" should be "local", "lsf", "celery", "dask" or "windows", not "lfs". Did you mean "lsf"?']);
    expect(messages({ a: { tests: ['x'] } })).toEqual(['"a.tests" is deprecated: Old name of `inputs`.']);
  });

  it('follows $ref between schemas', () => {
    expect(messages({ runners: { lsf: { queue: 1 } } }, qaboardSchema)).toEqual(['"runners.lsf.queue" should be text, not an integer']);
  });
});


describe('helpers', () => {
  it('formats paths', () => {
    expect(formatPath(['a', 'inputs', 2, 'x'])).toBe('a.inputs[2].x');
    expect(formatPath([])).toBe('');
  });
  it('suggests close words only', () => {
    expect(didYouMean('confgs', ['configs', 'inputs'])).toBe(' Did you mean "configs"?');
    expect(didYouMean('foo', ['configs', 'inputs'])).toBe('');
  });
});
