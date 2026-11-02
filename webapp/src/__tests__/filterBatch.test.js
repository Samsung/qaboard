/**
 * The filter box keeps the same runs as qaboard.runs(url) and the server (qaboard/filters.py):
 * both are tested against tests/fixtures/filters.json.
 * Run with: cd webapp && npm test -- filterBatch
 */
import { filter_batch } from '../utils';
import { normalize_output } from '../api/normalize';
import fixture from '../../../tests/fixtures/filters.json';

describe('filter_batch', () => {
  const batch = { outputs: Object.fromEntries(Object.entries(fixture.outputs).map(([id, o]) => [id, normalize_output(o)])) };

  it('keeps the same runs as qaboard.filters', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
    for (const { filter, matches } of fixture.cases) {
      expect(filter_batch(batch, filter).outputs, `filter: ${JSON.stringify(filter)}`).toEqual(matches);
    }
  });
});
