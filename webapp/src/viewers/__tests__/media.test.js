/**
 * The logged media's model (viewers/media/media.js): what runs logged at their steps besides numbers, from media.jsonl.
 * The fixtures are shared with the Python package's tests (qaboard/media.py read_media()): both must give
 * expected.json. Run with: cd webapp && npm test -- media
 */
import fs from 'node:fs';
import path from 'node:path';

import { boxInPixels, boxLabel, boxRegions, evolution, filterBoxes, groupKeys, itemAt, labelColor, matchItem, nextStep, parseMedia, sampleKey, snap, summary, unionSteps } from '../media/media';
import { distribution, histogramRange, quantiles, resample } from '../media/histogram';
import { columnHistogram, diffTables, keyColumn, numericColumns, parseTable, tableRows } from '../media/table';
import { columnsX } from '../media/HistogramView';

const FIXTURES = path.join(import.meta.dirname, '../../../../tests/fixtures/media');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

describe('parseMedia', () => {
  const model = parseMedia(read('run/media.jsonl'));

  it('reads a media.jsonl like Python does', () => {
    expect(model.items).toEqual(JSON.parse(read('expected.json')));
  });

  it('gives each key its kind, steps and items by step, by index', () => {
    expect(Object.keys(model.keys)).toEqual(['answers', 'predictions', 'report', 'tts/sample', 'val/samples', 'weights/fc1', 'without a time']);
    expect(model.keys['val/samples'].kind).toBe('image');
    expect(model.keys['val/samples'].steps).toEqual([0, 10, 20]);
    expect(model.keys['val/samples'].by_step.get(10).map(item => item.index)).toEqual([0, 1]);
    // the last line wins
    expect(model.keys.answers.by_step.get(20)[0]._time).toBe(1731500021);
    expect(model.steps).toEqual([0, 10, 20, 30]);
  });

  it('skips what it cannot read', () => {
    const text = [
      '{"_step": 1, "key": "a", "kind": "image", "path": "a.png"}',
      'not json',
      '{"_step": "2", "key": "a", "kind": "image"}',
      '{"_step": 3, "key": 4, "kind": "image"}',
      '{"_step": 4, "key": "a", "kind": "image", "index": "x"}',
      '[1, 2]',
      '{"_step": 5, "key": "a", "kind": "mesh"}',
      '{"_step": 6, "key": "a", "ki',
    ].join('\n');
    expect(parseMedia(text).items).toEqual([{ _step: 1, key: 'a', kind: 'image', path: 'a.png' }]);
    expect(parseMedia('').items).toEqual([]);
    expect(parseMedia(undefined).steps).toEqual([]);
  });
});

describe('steps', () => {
  const model = parseMedia(read('run/media.jsonl'));

  it('snaps to the greatest step <= the one asked', () => {
    expect(snap([0, 10, 20], 15)).toBe(10);
    expect(snap([0, 10, 20], 20)).toBe(20);
    expect(snap([0, 10, 20], 1000)).toBe(20);
    expect(snap([5, 10], 4)).toBe(null);
    expect(snap([], 4)).toBe(null);
  });

  it('gives the items of a key at a step', () => {
    expect(itemAt(model, 'val/samples', 15)).toMatchObject({ step: 10 });
    expect(itemAt(model, 'val/samples', 15).items.map(item => item.path)).toEqual(['media/val/samples/10_0.png', 'media/val/samples/10_1.png']);
    // before its first step: not logged yet
    expect(itemAt(model, 'tts/sample', 5)).toEqual({ step: null, items: [] });
    expect(itemAt(model, 'unknown', 5)).toEqual({ step: null, items: [] });
    // no step: the last
    expect(itemAt(model, 'tts/sample', undefined).step).toBe(10);
  });

  it('unites the steps of runs, and moves between them', () => {
    expect(unionSteps(parseMedia('{"_step": 3, "key": "a", "kind": "text"}'), model, null)).toEqual([0, 3, 10, 20, 30]);
    const steps = [0, 10, 20];
    expect(nextStep(steps, 10, 1)).toBe(20);
    expect(nextStep(steps, 15, 1)).toBe(20);
    expect(nextStep(steps, 20, 1)).toBe(20);
    expect(nextStep(steps, 10, -1)).toBe(0);
    expect(nextStep(steps, 15, -1)).toBe(10);
    expect(nextStep(steps, 0, -1)).toBe(0);
    expect(nextStep([], 7, 1)).toBe(7);
  });

  it('groups the keys by their prefix', () => {
    expect(groupKeys(['val/samples', 'loss_curve', 'train/x', 'val/masks'])).toEqual([
      { group: '', keys: ['loss_curve'] },
      { group: 'train', keys: ['train/x'] },
      { group: 'val', keys: ['val/masks', 'val/samples'] },
    ]);
  });
});

describe('boxes', () => {
  it('are in pixels, or in fractions of the image', () => {
    expect(boxInPixels({ x: 0.5, y: 0.25, w: 0.1, h: 0.5, units: 'fraction' }, 200, 100)).toEqual({ x: 100, y: 25, w: 20, h: 50, units: undefined });
    expect(boxInPixels({ x: 1, y: 2, w: 3, h: 4 }, 200, 100)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(boxLabel({ label: 'cat', score: 0.912 })).toBe('cat 0.91');
    expect(boxLabel({})).toBe('');
  });

  it("are the image viewer's regions, scaled by the viewer", () => {
    const regions = boxRegions({
      width: 64, height: 48,
      boxes: [{ x: 1, y: 2, w: 3, h: 4, label: 'cat', score: 0.5, group: 'predictions' }, { x: 0.1, y: 0.1, w: 0.5, h: 0.5, units: 'fraction', group: 'ground_truth' }, { x: 'bad' }],
    });
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ x: 1, y: 2, w: 3, h: 4, label: 'cat 0.50', imageWidth: 64, imageHeight: 48, detail: 'predictions' });
    expect(regions[1]).toMatchObject({ imageWidth: 1, imageHeight: 1 });
    expect(regions[0].color).not.toBe(regions[1].color);
  });
});

describe('histograms', () => {
  it('are resampled on a common grid, keeping their counts', () => {
    const range = { min: 0, max: 4 };
    expect([...resample({ bins: [0, 2, 4], counts: [4, 8] }, range, 4)]).toEqual([2, 2, 4, 4]);
    // other bins, partly outside of the grid's rows
    expect([...resample({ bins: [1, 3], counts: [10] }, range, 2)]).toEqual([5, 5]);
    const values = resample({ bins: [0.3, 1.7, 3.9], counts: [7, 11] }, range, 5);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(18);
  });

  it('give the distribution over the steps', () => {
    const items = [[0, { bins: [-1, 0, 1], counts: [1, 3] }], [10, { bins: [0, 2, 4], counts: [2, 2] }]];
    expect(histogramRange(items.map(([, item]) => item))).toEqual({ min: -1, max: 4 });
    const heat = distribution(items, 5);
    expect(heat.columns.map(c => c.step)).toEqual([0, 10]);
    expect(heat.columns[0].values.reduce((a, b) => a + b, 0)).toBeCloseTo(4);
    expect(heat.max).toBeCloseTo(3);
    expect(distribution([[0, { bins: [1], counts: [] }]])).toBe(null);
    expect(histogramRange([{ bins: [2, 2], counts: [5] }])).toEqual({ min: 1.5, max: 2.5 });
  });

  it('put each step in its column, by step', () => {
    // the last one as wide as the average
    expect(columnsX([0, 10, 20], 120)).toEqual([{ x0: 0, x1: 40 }, { x0: 40, x1: 80 }, { x0: 80, x1: 120 }]);
    expect(columnsX([5], 100)).toEqual([{ x0: 0, x1: 100 }]);
  });
});

describe('tables', () => {
  const table = parseTable(read('run/media/predictions/20_0.table.json'));

  it('reads the .table.json', () => {
    expect(table.columns).toEqual(['image', 'label', 'score']);
    expect(table.rows).toHaveLength(2);
    expect(numericColumns(table)).toEqual([false, false, true]);
    expect(() => parseTable('{"columns": 1}')).toThrow(/not a table/);
  });

  it('sorts and filters rows', () => {
    const t = { columns: ['name', 'value'], rows: [['b', 2], ['a', null], ['c', 10], ['A2', 1]] };
    expect(tableRows(t)).toEqual([0, 1, 2, 3]);
    expect(tableRows(t, { sort: { column: 1, order: 1 } })).toEqual([3, 0, 2, 1]);
    // empty cells last, whatever the order
    expect(tableRows(t, { sort: { column: 1, order: -1 } })).toEqual([2, 0, 3, 1]);
    expect(tableRows(t, { sort: { column: 0, order: 1 } })).toEqual([1, 3, 0, 2]);
    expect(tableRows(t, { filter: 'a' })).toEqual([1, 3]);
    expect(tableRows(t, { filter: ' 10 ' })).toEqual([2]);
    // media cells are filtered by their path
    expect(tableRows(table, { filter: '0_0.png' })).toEqual([0]);
  });
});

describe('samples', () => {
  const model = parseMedia(read('run/media.jsonl'));

  it('match by id, else caption, else position', () => {
    const at_10 = itemAt(model, 'val/samples', 10).items;
    // the loader shuffled: img_0 is second at step 10
    const img_0 = itemAt(model, 'val/samples', 0).items[0];
    expect(sampleKey(img_0)).toBe('id:img_0');
    expect(matchItem(img_0, at_10)).toEqual({ item: at_10[1], by: 'id' });
    expect(matchItem('id:img_1', at_10).item).toBe(at_10[0]);
    expect(matchItem('id:nope', at_10).item).toBe(null);
    const captioned = [{ caption: 'b', index: 0 }, { caption: 'a', index: 1 }];
    expect(matchItem({ caption: 'a', index: 0 }, captioned)).toEqual({ item: captioned[1], by: 'caption' });
    expect(matchItem({ index: 1 }, [{ index: 0 }, { index: 1 }]).item).toEqual({ index: 1 });
    expect(sampleKey({ index: 2 })).toBe('index:2');
  });

  it('follow a sample across the steps', () => {
    expect(evolution(model, 'val/samples', 'id:img_0').map(({ step, item }) => [step, item.index])).toEqual([[0, 0], [10, 1], [20, 0]]);
    expect(evolution(model, 'nothing', 'id:img_0')).toEqual([]);
  });

  it('are summed up', () => {
    expect(summary(model)).toBe('7 keys · steps 0–30 · images, audio, tables, histograms, texts, HTML');
    expect(summary(parseMedia('{"_step": 24000, "key": "a", "kind": "text"}'))).toBe('1 key · step 24\u2009000 · texts');
  });

  it('have boxes users filter, a color per label', () => {
    const boxes = [{ label: 'cat', score: 0.9, group: 'predictions' }, { label: 'cat', score: 0.1, group: 'predictions' }, { label: 'dog', group: 'ground_truth' }];
    expect(filterBoxes(boxes, { min_score: 0.5 })).toEqual([boxes[0], boxes[2]]);
    expect(filterBoxes(boxes, { hidden: new Set(['ground_truth']) })).toEqual([boxes[0], boxes[1]]);
    expect(labelColor('cat')).toBe(labelColor('cat'));
    expect(labelColor('cat')).not.toBe(labelColor('dog'));
  });
});

describe('quantiles and table diffs', () => {
  it('give the median and the 5-95% band of a histogram', () => {
    expect(quantiles({ bins: [0, 1, 2], counts: [1, 1] }, [0.05, 0.5, 0.95])).toEqual([0.1, 1, 1.9]);
    expect(quantiles({ bins: [0, 1], counts: [0] }, [0.5])).toBe(null);
  });

  it('join rows by a key column, and mark what changed', () => {
    const table = { columns: ['score', 'name'], rows: [[1, 'a'], [2, 'b'], [3, 'c']] };
    const ref = { columns: ['name', 'score'], rows: [['b', 2], ['a', 5], ['d', 1]] };
    expect(keyColumn(table)).toBe(1);
    expect(keyColumn({ columns: ['x', 'ID'], rows: [] })).toBe(1);
    expect(keyColumn({ columns: ['x', 'y'], rows: [[1, 2]] })).toBe(0);
    const diff = diffTables(table, ref, 1);
    expect(diff.map(d => d.status)).toEqual(['changed', 'same', 'added', 'removed']);
    expect([...diff[0].changed]).toEqual([0]);
    expect(diff[3].row).toEqual([1, 'd']);
    expect(columnHistogram([[0], [1], [1], ['x']], 0, 2)).toEqual({ min: 0, max: 1, counts: [1, 2] });
  });
});
