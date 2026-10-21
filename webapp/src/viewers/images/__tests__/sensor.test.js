import { describe, it, expect } from 'vitest';

import { sensorOf } from '../QaboardImageViewer';

describe("the server's sensor information", () => {
  it('maps it to the image viewer', () => {
    const header = JSON.stringify({
      cfa: { pattern: 'GBRG', block: 4 }, bit_depth: 10, white_level: 1023, black_level: 64,
      crop: { x: 600, y: 3264, full_width: 7296, full_height: 5472 }, fields: { pattern: 'GBRG' },
    });
    expect(sensorOf(header)).toEqual({
      cfa: { pattern: 'GBRG', block: 4 }, bitDepth: 10, whiteLevel: 1023, blackLevel: 64, mono: undefined,
      crop: { x: 600, y: 3264, fullWidth: 7296, fullHeight: 5472 },
      source: "the file's metadata, from the server's image reader", fields: { pattern: 'GBRG' },
    });
  });

  it('is optional', () => {
    expect(sensorOf(null)).toBe(undefined);
    expect(sensorOf('not json')).toBe(undefined);
  });
});
