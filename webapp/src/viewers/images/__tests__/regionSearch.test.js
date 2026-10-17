import { describe, it, expect } from 'vitest';

import { createLimiter, regionsKey, runPairs } from '../regionSearch';


const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the limiter of searches', () => {
  it('runs a few at a time, the ones users asked for first', async () => {
    const limiter = createLimiter(2);
    const started = [];
    const gates = {};
    const task = name => () => {
      started.push(name);
      gates[name] = deferred();
      return gates[name].promise.then(() => name);
    };
    const results = ['a', 'b', 'c', 'd'].map(name => limiter.run(task(name)));
    const urgent = limiter.run(task('viewer'), { priority: 'high' });
    await flush();
    expect(started).toEqual(['a', 'b']);
    gates.a.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'viewer']);
    for (const name of ['b', 'viewer']) gates[name].resolve();
    await flush();
    for (const name of ['c', 'd']) gates[name]?.resolve();
    await flush();
    gates.d?.resolve();
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd']);
    expect(await urgent).toBe('viewer');
    expect(limiter.pending()).toBe(0);
  });

  it('drops the searches cancelled while they wait', async () => {
    const limiter = createLimiter(1);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const abort = new AbortController();
    let ran = false;
    const second = limiter.run(() => { ran = true; }, { signal: abort.signal });
    abort.abort();
    await expect(second).rejects.toBeTruthy();
    gate.resolve('done');
    expect(await first).toBe('done');
    await flush();
    expect(ran).toBe(false);
  });

  it('says which searches started, not the ones waiting for their turn', async () => {
    const limiter = createLimiter(1);
    let changes = 0;
    limiter.subscribe(() => changes++);
    const gates = { a: deferred(), b: deferred() };
    const a = limiter.run(() => gates.a.promise, { id: 'a' });
    const b = limiter.run(() => gates.b.promise, { id: 'b' });
    await flush();
    const before = limiter.started();
    expect(Object.keys(before)).toEqual(['a']);
    expect(before.a).toBeLessThanOrEqual(Date.now());
    gates.a.resolve();
    await a;
    await flush();
    expect(Object.keys(limiter.started())).toEqual(['b']);
    // a new object when it changes
    expect(limiter.started()).not.toBe(before);
    gates.b.resolve();
    await b;
    await flush();
    expect(limiter.started()).toEqual({});
    expect(changes).toBe(4);
  });
});

describe('the runs of the page', () => {
  const output = (id, more = {}) => ({ id, output_dir_url: `/s/${id}`, test_input_path: `${id}.png`, ...more });
  it('pairs the runs shown with their reference', () => {
    const new_batch = {
      filtered: { outputs: [1, 2, 3, 4, 5] },
      outputs: {
        1: output(1, { reference_id: 11 }),
        2: output(2, { reference_id: 12 }),
        3: output(3, { reference_id: 13, is_running: true }),
        4: output(4, { reference_id: null }),
        5: output(5, { reference_id: 15, output_type: 'optim_iteration' }),
      },
    };
    const ref_batch = { outputs: { 11: output(11), 12: output(12, { deleted: true }), 13: output(13), 15: output(15) } };
    expect(runPairs({ new_batch, ref_batch }).map(pair => [pair.output_new.id, pair.output_ref.id])).toEqual([[1, 11]]);
    expect(runPairs({})).toEqual([]);
  });

  it('keys the results by the files compared', () => {
    const context = { output_new: output(1), output_ref: output(11), path: 'out.png' };
    expect(regionsKey('auto-yiq', context)).toEqual(['image-regions', 'auto-yiq', '/s/1', '/s/11', 'out.png', 'out.png']);
  });
});
