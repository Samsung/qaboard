import { describe, expect, it } from "vitest";
import { yAxisSuffix } from "../evolutionAxis";

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
