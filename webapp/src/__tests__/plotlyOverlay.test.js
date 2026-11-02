import { describe, expect, it } from "vitest";
import { overlay } from "../viewers/plotlyOverlay";

// what the page calls the sides it compares, and their colors
const sides = { names: { new: "new", ref: "ref" }, colors: { new: "#2d72d2dd", ref: "#9752fedd" } };

const figure = () => [
  { type: "scatter", name: "p99", x: [1, 2], y: [3, 4], line: { color: "#c87619" } },
  { type: "scatter", name: "SLO", x: [1, 2], y: [12, 12], line: { color: "#cd4246", dash: "dot" } },
];

describe("plots overlaid on their reference (side_by_side: false)", () => {
  it("draws every trace of both figures", () => {
    const traces = overlay({ new: figure(), ref: figure() }, true, sides);
    expect(traces).toHaveLength(4);
    expect(traces.map(t => t.name)).toEqual(["ref | p99", "ref | SLO", "new | p99", "new | SLO"]);
    expect(traces.every(t => t.x.length === 2)).toBe(true);
  });

  it("dashes and fades the reference's traces that set their colors, keeping the traces' own dashes", () => {
    const [ref_p99, ref_slo, new_p99, new_slo] = overlay({ new: figure(), ref: figure() }, true, sides);
    expect(ref_p99.line).toMatchObject({ color: "#c87619", dash: "dashdot" });
    expect(ref_p99.opacity).toBe(0.4);
    expect(new_p99.line.dash).toBeUndefined();
    expect(ref_slo.line.dash).toBe("dot");
    expect(new_slo.line.dash).toBe("dot");
  });

  it("names and colors the traces like the sides compared, keeping the traces' own colors", () => {
    const plain = () => [{ type: "scatter", name: "p99", x: [1], y: [2] }];
    const [ref, new_] = overlay({ new: plain(), ref: plain() }, true, {
      names: { new: "ISP v2", ref: "v1.4" },
      colors: { new: "#2d72d2dd", ref: "#9752fedd" },
    });
    expect([ref.name, new_.name]).toEqual(["v1.4 | p99", "ISP v2 | p99"]);
    expect(new_.line.color).toBe("#2d72d2dd");
    expect(ref.marker.color).toBe("#9752fedd");
    const [, , own] = overlay({ new: figure(), ref: figure() }, true, { ...sides, names: { new: "ISP v2", ref: "v1.4" } });
    expect(own).toMatchObject({ name: "ISP v2 | p99", line: { color: "#c87619" } });
  });

  it("colors the ground truth green", () => {
    const plain = () => [{ type: "scatter", x: [1], y: [2] }];
    const [groundtruth, ref, new_] = overlay({ groundtruth: plain(), new: plain(), ref: plain() }, true, sides);
    expect([groundtruth.name, ref.name, new_.name]).toEqual(["groundtruth", "ref", "new"]);
    expect(groundtruth.line.color).toMatch(/^#\w{6}dd$/);
    expect(new_.line.color).toBe("#2d72d2dd");
  });

  it("leaves the traces alone without a reference", () => {
    const data = { new: figure() };
    expect(overlay(data, false)).toEqual(figure());
  });
});
