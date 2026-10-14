import { describe, expect, it } from "vitest";
import { yAxisSuffix, hasAllMetrics, queryFlag } from "../evolutionAxis";

describe("the y axis of a metric over commits", () => {
  it("shows the metric's unit", () => {
    expect(yAxisSuffix({ suffix: " ms" }, false)).toBe(" ms");
    expect(yAxisSuffix({}, false)).toBe("");
    expect(yAxisSuffix(undefined, false)).toBe("");
  });

  it("has no unit relative to the first commit (@100)", () => {
    expect(yAxisSuffix({ suffix: " ms" }, true)).toBe("");
  });
});

describe("the commits a branch chart shows", () => {
  const commit = aggregated => ({ batches: { default: { aggregated_metrics: aggregated } } });

  it("keeps the commits whose batch has every metric", () => {
    expect(hasAllMetrics(commit({ p99_median: 3, cpu_median: 0 }), "default", ["p99", "cpu"], "median")).toBe(true);
  });

  it("leaves out the commits without a metric, or without the batch", () => {
    expect(hasAllMetrics(commit({ p99_median: 3 }), "default", ["p99", "cpu"], "median")).toBe(false);
    expect(hasAllMetrics(commit({ p99_median: null }), "default", ["p99"], "median")).toBe(false);
    expect(hasAllMetrics(commit({ p99_average: 3 }), "default", ["p99"], "median")).toBe(false);
    expect(hasAllMetrics(commit({ p99_median: 3 }), "nightly", ["p99"], "median")).toBe(false);
  });
});

describe("the chart's options in the URL", () => {
  const params = query => new URLSearchParams(query);

  it("follow the URL", () => {
    expect(queryFlag(params("breakdown_per_test=false"), "breakdown_per_test", true)).toBe(false);
    expect(queryFlag(params("breakdown_per_test=true"), "breakdown_per_test", false)).toBe(true);
    expect(queryFlag(params("relative=False"), "relative", true)).toBe(false);
  });

  it("have their default when the URL doesn't say", () => {
    expect(queryFlag(params(""), "breakdown_per_test", true)).toBe(true);
    expect(queryFlag(params("relative=true"), "breakdown_per_test", undefined)).toBe(false);
  });
});
