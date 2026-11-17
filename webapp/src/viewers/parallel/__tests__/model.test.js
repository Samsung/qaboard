/**
 * The logic of the parallel coordinates plot: types, scales, how tied rows are spread, brushes, hit testing.
 * Run with: cd webapp && npm test -- parallel
 */
import {
  MISSING, OTHER, analyzeColumn, brushPixels, brushValues, brushedSlots, computeLayout, curveAt, formatNumber, formatTick,
  formatValue, GEOMETRY, layoutAxis, lineStyle, lineY, logTicks, moveKey, nearestRow, niceTicks, numericScale, orderColumns,
  rangeBrush, selectRows, shortLabel, slotRows, toggleSlot,
} from '../model';
import { rowColors, sequential } from '../colors';
import { generate } from '../generate';

const rowsOf = (...columns) => {
  const n = Math.max(...columns.map(([, values]) => values.length));
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, values: Object.fromEntries(columns.map(([key, values]) => [key, values[i]])) }));
};
const analyze = (values, column = {}) => analyzeColumn({ key: 'x', ...column }, rowsOf(['x', values]));
const range = n => Array.from({ length: n }, (_, i) => i);

describe('columns', () => {
  it('infers numbers from numbers and numeric strings', () => {
    expect(analyze([1, 2.5, -3])).toMatchObject({ type: 'number', min: -3, max: 2.5, integer: false, positive: false });
    expect(analyze(['0.5', ' 2 ', '1e-3'])).toMatchObject({ type: 'number', min: 0.001, max: 2, positive: true });
    expect(analyze([1, 2, 3])).toMatchObject({ integer: true, distinct: [1, 2, 3] });
  });

  it('makes categories of strings, booleans and nested values', () => {
    expect(analyze(['b', 'a', 'b']).categories).toEqual([{ name: 'a', count: 1 }, { name: 'b', count: 2 }]);
    expect(analyze([true, false, true])).toMatchObject({ type: 'category', categories: [{ name: 'false', count: 1 }, { name: 'true', count: 2 }] });
    expect(analyze([{ w: 1 }, [1, 2], { w: 1 }]).categories.map(c => c.name)).toEqual(['[1,2]', '{"w":1}']);
    // like a person sorts, and `choices` first
    expect(analyze(['v10', 'v2', 'v1']).categories.map(c => c.name)).toEqual(['v1', 'v2', 'v10']);
    expect(analyze(['low', 'high', 'medium'], { choices: ['low', 'medium', 'high'] }).categories.map(c => c.name)).toEqual(['low', 'medium', 'high']);
  });

  it('keeps a column with a few strings numeric, from 90% of numbers', () => {
    const mostly = analyze([...range(19), 'auto']);
    expect(mostly).toMatchObject({ type: 'number', n_other: 1, others: [{ name: 'auto', count: 1 }], min: 0, max: 18 });
    expect(analyze([...range(8), 'auto', 'off']).type).toBe('category');
    // missing values don't count
    expect(analyze([...range(9), 'auto', null, undefined, NaN])).toMatchObject({ type: 'number', n_missing: 3 });
    // the type can be forced
    expect(analyze([1, 2, 3], { type: 'category' }).categories).toHaveLength(3);
    expect(analyze([1, 'a', 'b'], { type: 'number' })).toMatchObject({ type: 'number', n_other: 2 });
  });

  it('counts undefined, null and NaN as missing, not as 0', () => {
    const column = analyze([1, undefined, null, NaN, 3]);
    expect(column).toMatchObject({ type: 'number', n_missing: 3, min: 1, max: 3 });
    expect(analyze([undefined, null])).toMatchObject({ constant: true, constant_value: 'missing' });
  });

  it('finds the columns where every row has the same value', () => {
    expect(analyze([10, 10, 10])).toMatchObject({ constant: true, constant_value: '10' });
    expect(analyze(['a', 'a'])).toMatchObject({ constant: true, constant_value: 'a' });
    expect(analyze([10, 10, 11]).constant).toBe(false);
    // a value or nothing: that's information
    expect(analyze([10, 10, undefined]).constant).toBe(false);
  });

  it('formats the true values', () => {
    expect(formatNumber(0.123456)).toBe('0.1235');
    expect(formatNumber(12345.678)).toBe('12346');
    expect(formatNumber(1234567)).toBe('1234567');
    expect(formatNumber(0.00001234)).toBe('1.234e-5');
    expect(formatNumber(1.5e12)).toBe('1.5e12');
    expect(formatNumber(0)).toBe('0');
    const column = analyze([0.5, 1], { suffix: ' dB' });
    expect(formatValue(column, 0.5)).toBe('0.5 dB');
    expect(formatValue(column, '0.50')).toBe('0.5 dB');
    expect(formatValue(column, 'auto')).toBe('auto');
    expect(formatValue(column, NaN)).toBe('missing');
    expect(formatValue({ ...column, format: v => `<${v}>` }, 2)).toBe('<2>');
    expect(formatValue(analyze([true, false]), true)).toBe('true');
    expect(formatValue(analyze([{ a: 1 }, 'b']), { a: 1 })).toBe('{"a":1}');
  });

  it('formats ticks compactly', () => {
    expect(formatTick(1200, 100)).toBe('1.2k');
    expect(formatTick(2500000, 500000)).toBe('2.5M');
    expect(formatTick(0.0003)).toBe('3e-4');
    expect(formatTick(0.25, 0.05)).toBe('0.25');
    expect(formatTick(3, 1)).toBe('3');
    expect(formatTick(0, 1)).toBe('0');
    expect(formatTick(-0.5, 0.5)).toBe('-0.5');
  });

  it('shortens the names of parameters by their start', () => {
    expect(shortLabel('gamma', 12)).toBe('gamma');
    expect(shortLabel('pipeline.blocks.demosaic.interpolation_mode', 20)).toBe('…interpolation_mode');
    expect(shortLabel('pipeline.blocks.demosaic.interpolation_mode', 12).length).toBeLessThanOrEqual(12);
    // prose is cut at the end, by the CSS
    expect(shortLabel('Lens shading error (dB)', 12)).toBe('Lens shading error (dB)');
  });
});

describe('scales', () => {
  it('picks round ticks, whole for integers', () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0.13, 0.87, 4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(1, 4, 8, true)).toEqual([1, 2, 3, 4]);
    expect(niceTicks(3, 3)).toEqual([3]);
  });

  it('picks powers of ten on log scales', () => {
    expect(logTicks(1e-5, 1e-1, 6)).toEqual([1e-5, 1e-4, 1e-3, 1e-2, 1e-1]);
    expect(logTicks(1, 50)).toEqual([1, 2, 5, 10, 20, 50]);
    expect(logTicks(2e-12, 5e3, 6).length).toBeLessThanOrEqual(9);
  });

  it('puts the highest values at the top, unless flipped', () => {
    const scale = numericScale({ min: 0, max: 10, top: 100, bottom: 300 });
    expect([scale.toY(0), scale.toY(5), scale.toY(10)]).toEqual([300, 200, 100]);
    expect(scale.fromY(150)).toBeCloseTo(7.5);
    const flipped = numericScale({ min: 0, max: 10, top: 100, bottom: 300, flipped: true });
    expect([flipped.toY(0), flipped.toY(10)]).toEqual([100, 300]);
    const log = numericScale({ min: 0.001, max: 10, top: 0, bottom: 400, log: true });
    expect(log.toY(0.1)).toBeCloseTo(200);
    expect(log.fromY(100)).toBeCloseTo(1);
    // one value: in the middle
    expect(numericScale({ min: 3, max: 3, top: 0, bottom: 100 }).toY(3)).toBe(50);
  });
});

const box = { top: 100, bottom: 400, missing_y: 430 };
const axisOf = (values, column, options) => layoutAxis(analyze(values, column), { ...box, ...options });

describe('axes', () => {
  it('gives a slot to each category, with a band that grows with its rows', () => {
    const axis = axisOf([...Array(30).fill('a'), ...Array(3).fill('b'), 'c']);
    expect(axis.slots.map(s => [s.name, s.y, s.count])).toEqual([['a', 100, 30], ['b', 250, 3], ['c', 400, 1]]);
    const [a, b, c] = axis.slots.map(s => s.band);
    expect(a).toBeGreaterThan(b);
    expect(a).toBeLessThanOrEqual(GEOMETRY.max_category_band);
    expect(b).toBe(2 * GEOMETRY.line_step);
    expect(c).toBe(0);
    expect(axis.ticks.map(t => [t.label, t.count])).toEqual([['a', 30], ['b', 3], ['c', 1]]);
  });

  it('never lets the bands of two categories touch', () => {
    const axis = axisOf(range(400).map(i => `c${i % 20}`));
    const spacing = axis.slots[1].y - axis.slots[0].y;
    for (const slot of axis.slots) expect(slot.band).toBeLessThan(spacing);
    // not every category is labeled when they are too close
    const dense = axisOf(range(400).map(i => `c${i % 80}`));
    const labeled = dense.ticks.filter(t => !t.hidden);
    expect(labeled.length).toBeLessThan(80);
    expect(labeled[1].y - labeled[0].y).toBeGreaterThanOrEqual(GEOMETRY.label_gap);
  });

  it('groups tied numbers in slots, and labels the few values of a grid', () => {
    const axis = axisOf(range(27).map(i => [0.1, 0.5, 0.9][i % 3]));
    expect(axis.slots.map(s => [s.value, s.count, s.y])).toEqual([[0.9, 9, 100], [0.5, 9, 250], [0.1, 9, 400]]);
    for (const slot of axis.slots) expect(slot.band).toBe(8 * GEOMETRY.line_step);
    expect(axis.ticks.map(t => t.label).sort()).toEqual(['0.1', '0.5', '0.9']);
    expect(axis.ticks.every(t => t.slot !== undefined)).toBe(true);
  });

  it('bounds the band of tied numbers by the distance to the next value', () => {
    // integers 6 pixels apart
    const axis = axisOf(range(510).map(i => i % 51));
    for (const slot of axis.slots) {
      expect(slot.count).toBe(10);
      expect(slot.band).toBeCloseTo(GEOMETRY.value_band_share * 6);
    }
    // too close to spread at all
    const dense = axisOf(range(2000).map(i => i % 200));
    expect(dense.slots.every(s => s.band === 0)).toBe(true);
    // numbers that differ stay where they are
    const continuous = axisOf(range(50).map(i => i * 1.37));
    expect(continuous.slots.every(s => s.count === 1 && s.band === 0)).toBe(true);
  });

  it('labels the ends of the range and round values in between', () => {
    const axis = axisOf(range(101).map(i => 0.13 + i * 0.0074));
    const ends = axis.ticks.filter(t => t.end);
    expect(ends.map(t => t.y).sort((a, b) => a - b)).toEqual([100, 400]);
    const inner = axis.ticks.filter(t => !t.end);
    expect(inner.length).toBeGreaterThan(2);
    for (const tick of inner) for (const end of ends) expect(Math.abs(tick.y - end.y)).toBeGreaterThanOrEqual(GEOMETRY.label_gap);
    const integers = axisOf(range(40));
    expect(integers.ticks.every(t => /^\d+$/.test(t.label))).toBe(true);
  });

  it('sends missing values to a slot under the axis, never to 0', () => {
    const axis = axisOf([0, 1, NaN, undefined, null, 2]);
    const missing = axis.slots.find(s => s.name === MISSING);
    expect(missing).toMatchObject({ type: 'missing', count: 3, y: 430 });
    expect(missing.y).toBeGreaterThan(axis.bottom);
    expect([...axis.center]).toEqual([400, 250, 430, 430, 430, 100]);
    expect(axis.extent[1]).toBeGreaterThan(430);
    // on category axes too
    const categories = axisOf(['a', null, 'b']);
    expect(categories.center[1]).toBe(430);
    expect(categories.slots.map(s => s.name)).toEqual(['a', 'b', MISSING]);
  });

  it('puts what is not a number on its own band, under the numbers', () => {
    const axis = axisOf([...range(19), 'auto']);
    const other = axis.slots.find(s => s.name === OTHER);
    expect(other.count).toBe(1);
    expect(axis.line_bottom).toBeLessThan(other.y);
    expect(axis.center[0]).toBe(axis.line_bottom);
    expect(axis.center[19]).toBe(other.y);
    expect(axis.ticks.find(t => t.label === 'auto')).toBeTruthy();
  });

  it('handles log scales, only for positive values', () => {
    const axis = axisOf([0.001, 0.01, 0.1, 1, 10].flatMap(v => [v, v * 3]), {}, { log: true });
    expect(axis.log).toBe(true);
    expect(axis.center[2] - axis.center[4]).toBeCloseTo(axis.center[0] - axis.center[2]);
    expect(axisOf([0, 1, 2], {}, { log: true }).log).toBe(false);
  });
});

describe('spreading ties', () => {
  const layoutOf = (columns, options) => computeLayout(
    columns.map(([key, , column]) => analyzeColumn({ key, ...column }, rowsOf(...columns))),
    { width: 1000, height: 420, ...options },
  );

  it('fans tied rows out over the band, around their value', () => {
    const layout = layoutOf([['a', range(27).map(i => i % 3)], ['b', range(27).map(i => i * 1.1)]]);
    const [a, b] = layout.axes;
    for (const [k, slot] of a.slots.entries()) {
      const rows = slotRows(a, k);
      const ys = rows.map(i => a.pos[i]).sort((p, q) => p - q);
      expect(ys[0]).toBeCloseTo(slot.y - slot.band / 2);
      expect(ys[ys.length - 1]).toBeCloseTo(slot.y + slot.band / 2);
      // evenly, each row at its own place
      for (let r = 1; r < ys.length; r++) expect(ys[r] - ys[r - 1]).toBeCloseTo(slot.band / (rows.length - 1));
    }
    // rows that aren't tied are where their value is
    expect([...b.pos]).toEqual([...b.center]);
  });

  it('orders tied rows like on the next axis, so that their lines do not cross', () => {
    const layout = layoutOf([['a', range(40).map(i => i % 2)], ['b', range(40).map(i => (i * 7) % 40)]]);
    const [a, b] = layout.axes;
    for (const k of [0, 1]) {
      const rows = slotRows(a, k).sort((p, q) => a.pos[p] - a.pos[q]);
      for (let r = 1; r < rows.length; r++) expect(b.pos[rows[r]]).toBeGreaterThan(b.pos[rows[r - 1]]);
    }
  });

  it('keeps bundles together between two axes with few values', () => {
    // a grid: between two parameters, the lines that leave a value are sorted by where they go, and those that
    // reach a value by where they come from: they make bundles, that don't cross more than they have to
    const grid = range(81);
    const layout = layoutOf([['metric', grid.map(i => (i * 37) % 81)], ['a', grid.map(i => i % 3)], ['b', grid.map(i => Math.floor(i / 3) % 3)]]);
    const [, a, b] = layout.axes;
    let crossings = 0;
    for (let p = 0; p < 81; p++) for (let q = p + 1; q < 81; q++) {
      // lines from different values to different values cross, or not, whatever the order within the bands
      if (a.slot[p] !== a.slot[q] && b.slot[p] !== b.slot[q]) continue;
      if ((a.pos[p] - a.pos[q]) * (b.pos[p] - b.pos[q]) < 0) crossings++;
    }
    expect(crossings).toBe(0);
    for (const k of [0, 1, 2]) {
      const targets = slotRows(a, k).sort((p, q) => a.pos[p] - a.pos[q]).map(i => b.slots[b.slot[i]].y);
      expect(targets).toEqual([...targets].sort((p, q) => p - q));
    }
  });

  it('never moves a row beyond its band', () => {
    const { columns, rows } = generate({ kind: 'mixed', rows: 400 });
    const analyzed = columns.map(c => analyzeColumn(c, rows)).filter(c => !c.constant);
    const layout = computeLayout(analyzed, { width: 1200, height: 420 });
    for (const axis of layout.axes) {
      for (let i = 0; i < rows.length; i++) {
        const slot = axis.slots[axis.slot[i]];
        expect(Math.abs(axis.pos[i] - slot.y)).toBeLessThanOrEqual(slot.band / 2 + GEOMETRY.tie_tolerance + 1e-3);
      }
      expect(axis.slots.reduce((sum, s) => sum + s.count, 0)).toBe(rows.length);
    }
  });

  it('lays out the axes over the width, or wider with a minimum distance', () => {
    const columns = range(5).map(k => [`c${k}`, range(10).map(i => i * (k + 1))]);
    const fits = layoutOf(columns);
    expect(fits.width).toBe(1000);
    expect(fits.axes[0].x).toBe(GEOMETRY.pad_left);
    expect(fits.axes[4].x).toBeCloseTo(1000 - GEOMETRY.pad_right);
    const many = layoutOf(range(40).map(k => [`c${k}`, range(10).map(i => i * (k + 1))]));
    expect(many.spacing).toBe(GEOMETRY.min_axis);
    expect(many.width).toBeGreaterThan(39 * GEOMETRY.min_axis);
    // groups are apart, and named
    const grouped = layoutOf(columns.map(([key, values], k) => [key, values, { group: k < 2 ? 'Metrics' : 'Parameters' }]));
    expect(grouped.groups.map(g => [g.name, g.from, g.to])).toEqual([['Metrics', 0, 1], ['Parameters', 2, 4]]);
    expect(grouped.axes[2].x - grouped.axes[1].x).toBeCloseTo(grouped.spacing + GEOMETRY.group_gap);
  });

  it('is fast enough for 5,000 rows and 40 columns', () => {
    const { columns, rows } = generate({ kind: 'mixed', rows: 5000, columns: 40 });
    const t0 = performance.now();
    const analyzed = columns.map(c => analyzeColumn(c, rows)).filter(c => !c.constant);
    const layout = computeLayout(analyzed, { width: 1200, height: 420 });
    const t1 = performance.now();
    for (let k = 0; k < 20; k++) nearestRow(layout.axes, 300 + k * 50, 200 + k * 5);
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(3000);
    expect((t2 - t1) / 20).toBeLessThan(20);
  });
});

describe('brushes', () => {
  const columns = [['a', range(30).map(i => i % 3)], ['b', range(30).map(i => ['x', 'y', 'z'][i % 3 === 0 ? 0 : i % 2 + 1])], ['c', range(30).map(i => i === 29 ? undefined : i)]];
  const rows = rowsOf(...columns);
  const layout = computeLayout(columns.map(([key]) => analyzeColumn({ key }, rows)), { width: 900, height: 420 });
  const [a, b, c] = layout.axes;

  it('keeps the rows within a range, tied rows together', () => {
    expect(selectRows(layout.axes, {}, 30)).toBeNull();
    // around the middle value of a, through half of its band only
    const slot = a.slots.find(s => s.value === 1);
    const selected = selectRows(layout.axes, { a: rangeBrush(a, slot.y - 2, slot.y + 60) }, 30);
    expect(selected.count).toBe(10);
    expect(range(30).filter(i => selected.mask[i])).toEqual(range(30).filter(i => i % 3 === 1));
  });

  it('combines the axes: rows must pass every brush', () => {
    const brushes = { a: toggleSlot(a, null, '0'), c: rangeBrush(c, c.scale.toY(20), c.scale.toY(10)) };
    const selected = selectRows(layout.axes, brushes, 30);
    expect(range(30).filter(i => selected.mask[i])).toEqual([12, 15, 18]);
    expect(brushValues(c, brushes.c).map(v => Math.round(v))).toEqual([10, 20]);
  });

  it('toggles categories', () => {
    let brush = toggleSlot(b, null, 'x');
    expect(brush).toEqual({ type: 'set', names: ['x'] });
    brush = toggleSlot(b, brush, 'z');
    expect(brush.names).toEqual(['x', 'z']);
    expect(selectRows(layout.axes, { b: brush }, 30).count).toBe(rows.filter(r => r.values.b !== 'y').length);
    expect(toggleSlot(b, toggleSlot(b, brush, 'x'), 'z')).toBeNull();
    // from a range: the slots it covers
    const from_range = rangeBrush(b, b.slots[0].y - 5, b.slots[1].y + 5);
    expect([...brushedSlots(b, from_range)]).toEqual(['x', 'y']);
    expect(toggleSlot(b, from_range, 'y').names).toEqual(['x']);
  });

  it('can keep the rows without a value', () => {
    const missing = selectRows(layout.axes, { c: toggleSlot(c, null, MISSING) }, 30);
    expect(range(30).filter(i => missing.mask[i])).toEqual([29]);
    const all = selectRows(layout.axes, { c: rangeBrush(c, -1e4, 1e4) }, 30);
    expect(all.count).toBe(30);
    const only_values = selectRows(layout.axes, { c: rangeBrush(c, c.top, c.bottom) }, 30);
    expect(only_values.count).toBe(29);
  });

  it('survives a resize', () => {
    const brush = rangeBrush(c, c.scale.toY(20.5), c.scale.toY(9.5));
    const taller = computeLayout(columns.map(([key]) => analyzeColumn({ key }, rows)), { width: 600, height: 700 });
    const selected = selectRows(taller.axes, { c: brush }, 30);
    expect(range(30).filter(i => selected.mask[i])).toEqual(range(11).map(i => i + 10));
    const [y0, y1] = brushPixels(taller.axes[2], brush);
    expect(y1 - y0).toBeGreaterThan(brushPixels(c, brush)[1] - brushPixels(c, brush)[0]);
  });
});

describe('hit testing', () => {
  const rows = rowsOf(['a', [0, 5, 10]], ['b', [10, 5, 0]], ['c', [0, 10, 5]]);
  const layout = computeLayout(['a', 'b', 'c'].map(key => analyzeColumn({ key }, rows)), { width: 800, height: 420 });
  const { axes } = layout;

  it('follows the curve between the axes', () => {
    // the curve of the Bézier with control points at the given fraction of the way
    for (const c of [0.5, 0.35]) {
      for (const t of [0.1, 0.3, 0.5, 0.8]) {
        const u = 3 * c * t * (1 - t) ** 2 + 3 * (1 - c) * t * t * (1 - t) + t ** 3;
        expect(curveAt(u, c).s).toBeCloseTo(3 * t * t - 2 * t ** 3, 6);
      }
    }
    expect(curveAt(0)).toEqual({ s: 0, slope: 0 });
    expect(curveAt(1)).toEqual({ s: 1, slope: 0 });
    expect(curveAt(0.5).s).toBeCloseTo(0.5);
    expect(lineY(axes, 0, axes[0].x)).toBe(axes[0].pos[0]);
    expect(lineY(axes, 0, (axes[0].x + axes[1].x) / 2)).toBeCloseTo((axes[0].pos[0] + axes[1].pos[0]) / 2);
  });

  it('finds the nearest line anywhere along it', () => {
    for (const row of [0, 1, 2]) {
      for (const x of [axes[0].x, axes[0].x + 60, (axes[0].x + axes[1].x) / 2 + 31, axes[1].x + 100, axes[2].x]) {
        const y = lineY(axes, row, x);
        // where two lines cross, either is right
        const others = [0, 1, 2].filter(r => r !== row).map(r => Math.abs(lineY(axes, r, x) - y));
        if (Math.min(...others) < 12) continue;
        expect(nearestRow(axes, x, y + 3)).toMatchObject({ row });
      }
    }
  });

  it('finds nothing away from the lines', () => {
    const x = axes[0].x + 20;
    const ys = [0, 1, 2].map(row => lineY(axes, row, x));
    expect(nearestRow(axes, x, (ys[0] + ys[1]) / 2)).toBeNull();
    expect(nearestRow(axes, axes[0].x - 40, axes[0].pos[0])).toBeNull();
    expect(nearestRow(axes, x, ys[0] + 10, { tolerance: 12 })).toMatchObject({ row: 0 });
  });

  it('measures the distance to the curve, not the vertical distance', () => {
    // where row 0's line is steep, 10 pixels above it is closer than that to the curve
    const x = axes[0].x + 0.35 * (axes[1].x - axes[0].x);
    const hit = nearestRow(axes, x, lineY(axes, 0, x) - 10, { tolerance: 8 });
    expect(hit?.row).toBe(0);
    expect(hit.distance).toBeLessThan(8);
    expect(hit.distance).toBeGreaterThan(3);
  });

  it('only finds rows the brushes kept', () => {
    const x = axes[0].x + 20;
    const y = lineY(axes, 0, x);
    expect(nearestRow(axes, x, y, { mask: Uint8Array.of(0, 1, 1) })).toBeNull();
    expect(nearestRow(axes, x, y, { mask: Uint8Array.of(1, 0, 0) })).toMatchObject({ row: 0 });
  });
});

describe('columns order, colors', () => {
  it('keeps the order the user chose, new columns where they come', () => {
    const columns = ['a', 'b', 'c', 'd'].map(key => ({ key }));
    expect(orderColumns(columns, null)).toBe(columns);
    expect(orderColumns(columns, ['c', 'a', 'b']).map(c => c.key)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderColumns(columns, ['d', 'gone', 'a']).map(c => c.key)).toEqual(['d', 'b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c', 'd'], 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveKey(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveKey(['a', 'b', 'c', 'd'], 'b', 4)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('makes lines lighter when there are more', () => {
    expect(lineStyle(10).alpha).toBeGreaterThan(lineStyle(300).alpha);
    expect(lineStyle(300).alpha).toBeGreaterThan(lineStyle(5000).alpha);
    expect(lineStyle(5000).alpha).toBeGreaterThan(0.02);
  });

  it('colors numbers with a sequential scale whose salient end is the good one', () => {
    const lower = rowColors(analyze([1, 2, 3, NaN], { better: 'lower' }), 4);
    // the best row is drawn last, in the color that stands out; rows without a value are gray, behind
    expect(lower.palette[lower.index[0]]).toBe(sequential(1, false));
    expect(lower.palette[lower.index[2]]).toBe(sequential(0, false));
    expect([...lower.order]).toEqual([3, 2, 1, 0]);
    expect(lower.palette[lower.index[3]]).toBe(lower.neutral);
    expect(lower.legend).toMatchObject({ type: 'number', min: 1, max: 3 });
    const higher = rowColors(analyze([1, 2, 3], { better: 'higher' }), 3, { dark: true });
    expect(higher.palette[higher.index[2]]).toBe(sequential(1, true));
    expect(sequential(1, true)).not.toBe(sequential(1, false));
  });

  it('colors categories with a palette', () => {
    const colors = rowColors(analyze(['a', 'b', 'a', null]), 4);
    expect(colors.index[0]).toBe(colors.index[2]);
    expect(colors.index[0]).not.toBe(colors.index[1]);
    expect(colors.palette[colors.index[3]]).toBe(colors.neutral);
    expect(colors.legend.items.map(i => i.name)).toEqual(['a', 'b']);
    expect(rowColors(null, 3).palette).toHaveLength(1);
  });
});
