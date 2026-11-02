import { describe, it, expect } from 'vitest';

import { coin } from '../QaboardImageViewer';


describe('the coin of a blind test', () => {
  it('is the same for a test and a viewer', () => {
    expect(coin(42, '100 out.png')).toBe(coin(42, '100 out.png'));
  });

  it('shuffles about half of the viewers, and other ones in another test', () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `${i} out.png`);
    const heads = seed => keys.filter(key => coin(seed, key));
    for (const seed of [1, 123456, 2 ** 30]) expect(heads(seed).length).toBeGreaterThan(900);
    for (const seed of [1, 123456, 2 ** 30]) expect(heads(seed).length).toBeLessThan(1100);
    expect(heads(1)).not.toEqual(heads(2));
  });
});
