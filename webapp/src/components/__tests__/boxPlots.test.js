import { describe, expect, it } from "vitest";
import { box_stats, linear_ticks, jittered_points } from "../boxPlots";

describe("the Summary's box plots", () => {
  it("have Plotly's quartiles, whiskers and mean", () => {
    // with an outlier: the whiskers stop at the furthest values within 1.5 times the box's height
    expect(box_stats([9, 1, 2, 3, 100, 4, 5, 6, 7, 8])).toEqual({ q1: 3, median: 5.5, q3: 8, lower: 1, upper: 9, mean: 14.5 });
    // quartiles between two values are interpolated
    expect(box_stats([1, 2, 3, 4])).toMatchObject({ q1: 1.5, median: 2.5, q3: 3.5, lower: 1, upper: 4 });
    expect(box_stats([3])).toEqual({ q1: 3, median: 3, q3: 3, lower: 3, upper: 3, mean: 3 });
  });

  it("have a few round ticks on linear scales", () => {
    expect(linear_ticks(0, 100)).toEqual([0, 50, 100]);
    expect(linear_ticks(0.12, 0.47)).toEqual([0.2, 0.4]);
    expect(linear_ticks(-3, 12)).toEqual([0, 5, 10]);
    // all the values are the same
    expect(linear_ticks(4, 4)).toEqual([4]);
  });

  it("draw values at the same place once", () => {
    const y = v => v;
    // spread across the width, the same each time
    const few = jittered_points([10, 20, 30], 50, 20, y);
    expect(few).toHaveLength(3);
    expect(few.every(([x]) => x >= 40 && x <= 60)).toBe(true);
    expect(jittered_points([10, 20, 30], 50, 20, y)).toEqual(few);
    // thousands of runs in a small plot: as many points as fit
    const many = jittered_points(Array.from({ length: 5000 }, (_, i) => i % 60), 50, 20, y);
    expect(many.length).toBeLessThanOrEqual(11 * 31);
    expect(many.length).toBeGreaterThan(200);
  });
});
