import { describe, expect, it } from "vitest";
import { logTickValues } from "../logTicks";

describe("the ticks of the Summary's box plots on a log scale", () => {
  it("are round values within the range, spread out", () => {
    // mAP of the detector's slices: Plotly labeled 0.1, 0.15, 0.2, 0.25, 0.3 in 70 px
    expect(logTickValues([0.08, 0.12, 0.16, 0.32])).toEqual([0.1, 0.2]);
    // the model sizes: 3.86 and 13.8 MB
    expect(logTickValues([3.86, 3.86, 13.8])).toEqual([5, 10]);
    // over several decades: one per decade
    expect(logTickValues([0.001, 0.5, 1])).toEqual([0.001, 0.01, 0.1, 1]);
  });

  it("are at most maxTicks, and the ends when no round value is in range", () => {
    expect(logTickValues([1e-6, 1e6], 3).length).toBe(3);
    expect(logTickValues([0.052, 0.066, 0.09])).toEqual([0.052, 0.09]);
    expect(logTickValues([0.15, 0.3])).toEqual([0.15, 0.2, 0.3]);
  });

  it("ignore what a log axis can't show", () => {
    expect(logTickValues([0, -1, NaN, null, 2])).toEqual([2]);
    // too close for two labels: one
    expect(logTickValues([6.2, 7.32])).toEqual([6.7]);
    expect(logTickValues([0, null])).toBeUndefined();
  });
});
