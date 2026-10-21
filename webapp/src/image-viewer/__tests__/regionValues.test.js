import { describe, it, expect } from 'vitest';

import { readPlan, readAll, REQUEST_PIXELS } from '../regionValues';
import { normalizeSensorSetting } from '../imageAnalysis';

describe('reading the values of the view', () => {
  it('reads small views whole, by squares the server accepts', () => {
    const plan = readPlan({ x: 10.4, y: 20, w: 600, h: 300 });
    expect(plan.sampled).toBe(false);
    expect(plan.region).toEqual({ x: 10, y: 20, w: 601, h: 300 });
    const pixels = plan.requests.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(pixels).toBe(601 * 300);
    expect(plan.requests.every(r => r.w * r.h <= REQUEST_PIXELS)).toBe(true);
  });

  it('reads strips across large views, for all the columns and rows', () => {
    const plan = readPlan({ x: 0, y: 0, w: 16000, h: 12000 });
    expect(plan.sampled).toBe(true);
    expect(plan.requests.every(r => r.w * r.h <= REQUEST_PIXELS)).toBe(true);
    const pixels = plan.requests.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(pixels).toBeLessThanOrEqual(2_100_000);
    // every column is in the row strips, every row in the column strips
    const columns = new Set();
    const rows = new Set();
    for (const r of plan.requests) {
      if (r.use.columns) for (let x = r.x; x < r.x + r.w; x++) columns.add(x);
      if (r.use.rows) for (let y = r.y; y < r.y + r.h; y++) rows.add(y);
    }
    expect(columns.size).toBe(16000);
    expect(rows.size).toBe(12000);
  });

  it('reads a few at a time, and stops when aborted', async () => {
    let calls = 0;
    const getPixels = async (image, { w, h }) => {
      calls++;
      return { data: new Uint16Array(w * h), width: w, height: h, channels: 1, sensor: { bitDepth: 10 } };
    };
    const image = { url: `test-${Math.random()}` };
    const plan = readPlan({ x: 0, y: 0, w: 512, h: 512 });
    const chunks = await readAll(getPixels, image, plan.requests);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].sensor.bitDepth).toBe(10);
    // cached
    await readAll(getPixels, image, plan.requests);
    expect(calls).toBe(4);
    const abort = new AbortController();
    abort.abort();
    await expect(readAll(getPixels, { url: 'other' }, plan.requests, { signal: abort.signal })).rejects.toThrow('Aborted');
  });

  it('normalizes what users set of the sensor', () => {
    expect(normalizeSensorSetting(undefined)).toEqual({ kind: 'auto', pattern: null, block: null, offset: null, blackLevel: null, grouping: 'cfa' });
    expect(normalizeSensorSetting({ kind: 'mono', blackLevel: 64, grouping: 'sub' })).toMatchObject({ kind: 'mono', blackLevel: 64, grouping: 'sub' });
    expect(normalizeSensorSetting({ kind: 'what', grouping: 'no' })).toMatchObject({ kind: 'auto', grouping: 'cfa' });
  });
});
