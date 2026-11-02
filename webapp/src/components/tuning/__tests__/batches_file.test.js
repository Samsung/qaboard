import { analyzeBatches, newBatchSnippet, unusedBatchName } from '../batches_file';


describe('analyzeBatches', () => {
  it('lists batches, aliases and settings with their lines', () => {
    const { problems, items } = analyzeBatches([
      'database: /mnt/data',      // 1
      'my-batch:',                // 2
      '  inputs:',                // 3
      '  - a.jpg',                // 4
      '  - b.jpg',                // 5
      '.template: &tpl',          // 6
      '  inputs: [c.jpg]',        // 7
      'from-anchor: *tpl',        // 8
      'pipe:',                    // 9
      '  type: pipeline',         // 10
      'aliases:',                 // 11
      '  nightly: [my-batch, pipe]', // 12
      '  single: my-batch',       // 13
    ].join('\n'));
    expect(problems).toEqual([]);
    expect(items).toEqual([
      { name: 'database', kind: 'setting', line: 1 },
      { name: 'my-batch', kind: 'batch', inputs: 2, line: 2 },
      { name: 'from-anchor', kind: 'batch', inputs: 1, line: 8 },
      { name: 'pipe', kind: 'pipeline', inputs: undefined, line: 9 },
      { name: 'nightly', kind: 'alias', targets: ['my-batch', 'pipe'], line: 12 },
      { name: 'single', kind: 'alias', targets: ['my-batch'], line: 13 },
    ]);
  });

  it('keeps keys as written, like PyYAML', () => {
    // YAML 1.1 parsers may read `y` or `on` as booleans
    expect(analyzeBatches('y:\n  inputs: [a]\n007: {}\n').items.map(i => i.name)).toEqual(['y', '007']);
  });

  it('accepts empty files and comments', () => {
    expect(analyzeBatches('')).toEqual({ problems: [], items: [] });
    expect(analyzeBatches('# Docs: https://...\n')).toEqual({ problems: [], items: [] });
  });

  it('reports syntax errors with their position', () => {
    const { problems } = analyzeBatches('a:\n  inputs:\n\t- x\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', line: 3, column: 1 });
    expect(problems[0].message).toMatch(/tab/i);
    expect(problems[0].message).not.toMatch(/at line/);
  });

  it('requires a mapping', () => {
    const { problems } = analyzeBatches('- a.jpg\n- b.jpg\n');
    expect(problems).toMatchObject([{ severity: 'error', line: 1 }]);
  });

  it('warns about batches defined twice', () => {
    const { problems, items } = analyzeBatches('a:\n  inputs: [x]\nb: {}\na:\n  inputs: [y]\n');
    expect(items).toMatchObject([{ name: 'a', overridden_by: 4 }, { name: 'b' }, { name: 'a', line: 4 }]);
    expect(items[2].overridden_by).toBeUndefined();
    expect(problems).toMatchObject([{ severity: 'warning', line: 4, message: expect.stringContaining('line 1') }]);
  });

  it('checks aliases are a mapping', () => {
    expect(analyzeBatches('aliases: [a, b]\n').problems).toMatchObject([{ severity: 'error', line: 1 }]);
    expect(analyzeBatches('aliases:\n').problems).toEqual([]);
  });

  it('flags inputs that qa batch can not use', () => {
    const { problems } = analyzeBatches([
      'nightly:',                     // 1
      '  inputs:',                    // 2
      '  - a',                        // 3
      '  - [b, {threshold: 2}]',      // 4
      '  - c: {threshold: 3}',        // 5
      '  -',                          // 6
      '  - 20260223',                 // 7
      '  - yes',                      // 8
      '  - 2026-02-23',               // 9
      '  - "20260223"',               // 10
      '  - y',                        // 11: text for PyYAML
      '  - 08',                       // 12: text for PyYAML
    ].join('\n'));
    expect(problems).toEqual([
      expect.objectContaining({ severity: 'error', line: 6, column: 3, message: expect.stringContaining('Empty input in "nightly"') }),
      expect.objectContaining({ severity: 'error', line: 7, message: 'YAML reads 20260223 as a number, not a path: write it in quotes' }),
      expect.objectContaining({ severity: 'error', line: 8, message: 'YAML reads yes as true or false, not a path: write it in quotes' }),
      expect.objectContaining({ severity: 'error', line: 9, message: 'YAML reads 2026-02-23 as a date, not a path: write it in quotes' }),
    ]);
    expect(analyzeBatches('listed: [a, b]\n').problems).toMatchObject([{ severity: 'warning', line: 1, message: expect.stringContaining('is a list, not a batch') }]);
  });
});


describe('checks against the schema', () => {
  it('warns about unknown keys and wrong types, where they are', () => {
    const { problems } = analyzeBatches([
      'a:',                      // 1
      '  inpts: [x.jpg]',        // 2
      '  matrix:',               // 3
      '    size: 320',           // 4
      '  runner: lfs',           // 5
      'b:',                      // 6
      '  inputs: [y]',           // 7: text for PyYAML
      '  lsf:',                  // 8
      '    queue: long',         // 9
      '    max_memmory: 3000',   // 10
    ].join('\n'));
    expect(problems).toEqual([
      { severity: 'warning', line: 2, column: 3, endLine: 2, endColumn: 8, message: 'Unknown key "inpts" in "a". Did you mean "inputs"?' },
      expect.objectContaining({ severity: 'warning', line: 4, column: 11, message: '"a.matrix.size" should be a list, not an integer' }),
      expect.objectContaining({ severity: 'warning', line: 5, column: 11, message: expect.stringContaining('Did you mean "lsf"?') }),
      expect.objectContaining({ severity: 'warning', line: 10, column: 5, message: 'Unknown key "max_memmory" in "b.lsf". Did you mean "max_memory"?' }),
    ]);
  });

  it('reads the YAML like PyYAML: the last duplicate key wins, anchors and merges work', () => {
    const { problems } = analyzeBatches([
      '.base: &base',            // 1
      '  configs: [base]',       // 2
      '  inputs: [a]',           // 3
      'a:',                      // 4
      '  <<: *base',             // 5
      '  platform: x',           // 6
      'a:',                      // 7
      '  inputs: [b]',           // 8
      '  confgs: [c]',           // 9
    ].join('\n'));
    expect(problems.map(p => [p.line, p.message])).toEqual([
      [7, expect.stringContaining('defined twice')],
      [9, 'Unknown key "confgs" in "a". Did you mean "configs"?'],
    ]);
  });

  it("doesn't repeat the problems it explains better", () => {
    const { problems } = analyzeBatches('a:\n  inputs:\n  - yes\n  -\nlisted: [a, b]\nlisted2:\n  inpts: [x]\n');
    expect(problems.map(p => p.line)).toEqual([3, 4, 5, 7]);
  });

  it("doesn't check top-level values reused in batches as batches", () => {
    const { problems, items } = analyzeBatches([
      'db-lab: &lab',                 // 1
      '  linux: /mnt/lab',            // 2
      '  windows: //lab/data',        // 3
      'db-path: &db-path /mnt/other', // 4
      'common-inputs: &common [a.jpg, b.jpg]', // 5
      'unused: &unused',              // 6: an anchor nobody uses: maybe a batch with typos
      '  linux: /mnt/x',              // 7
      'base: &base',                  // 8: a batch reused as a template is still a batch
      '  inputs: [x.jpg]',            // 9
      '  confgs: [c]',                // 10
      'a:',                           // 11
      '  database: *lab',             // 12
      '  inputs: *common',            // 13
      'b:',                           // 14
      '  <<: *base',                  // 15
      '  database: *db-path',         // 16
    ].join('\n'));
    expect(problems.map(p => [p.line, p.message])).toEqual([
      [7, 'Unknown key "linux" in "unused"'],
      [10, 'Unknown key "confgs" in "base". Did you mean "configs"?'],
    ]);
    expect(items.map(i => [i.name, i.kind, i.anchor])).toEqual([
      ['db-lab', 'reused', 'lab'],
      ['db-path', 'reused', 'db-path'],
      ['common-inputs', 'reused', 'common'],
      ['unused', 'batch', undefined],
      ['base', 'batch', undefined],
      ['a', 'batch', undefined],
      ['b', 'batch', undefined],
    ]);
  });

  it("checks the YAML's syntax first", () => {
    const { problems } = analyzeBatches('a:\n  inpts: [x\n');
    expect(problems.every(p => p.severity === 'error')).toBe(true);
  });

  it("uses qaboard.yaml's input types and settings", () => {
    const config = { inputs: { globs: '*.jpg', my_setting: 1, types: { default: 'image', image: {}, movie: { frames: 10 } } } };
    const text = 'a:\n  type: movi\n  my_setting: 2\n  frames: 3\nb:\n  type: movie\nc:\n  type: pipeline\n';
    expect(analyzeBatches(text, { config }).problems).toEqual([
      expect.objectContaining({ line: 2, column: 9, message: 'Unknown input type "movi": qaboard.yaml defines "image", "movie". Did you mean "movie"? `qa batch` will fail' }),
    ]);
    // without qaboard.yaml we can't know
    expect(analyzeBatches(text).problems.map(p => p.message)).toEqual([
      'Unknown key "my_setting" in "a"',
      'Unknown key "frames" in "a"',
    ]);
  });
});


describe('new batches', () => {
  it('appends a valid batch', () => {
    for (const text of ['', 'a: {}', 'a: {}\n', 'a: {}\n\n']) {
      const result = text + newBatchSnippet(text, 'new');
      expect(analyzeBatches(result).problems).toEqual([]);
      expect(result).toMatch(/(^|\n\n)new:\n {2}inputs:\n {2}- path\/to\/an\/input\n$/);
    }
  });

  it('picks an unused name', () => {
    expect(unusedBatchName([])).toBe('my-new-batch');
    expect(unusedBatchName([{ name: 'my-new-batch' }, { name: 'my-new-batch-2' }])).toBe('my-new-batch-3');
  });
});
