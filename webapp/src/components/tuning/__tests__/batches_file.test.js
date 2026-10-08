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
