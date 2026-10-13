import { describe, expect, it } from "vitest";
import { overlay } from "../viewers/plotlyOverlay";

const figure = () => [
  { type: "scatter", name: "p99", x: [1, 2], y: [3, 4], line: { color: "#c87619" } },
  { type: "scatter", name: "SLO", x: [1, 2], y: [12, 12], line: { color: "#cd4246", dash: "dot" } },
];

describe("plots overlaid on their reference (side_by_side: false)", () => {
  it("draws every trace of both figures", () => {
    const traces = overlay({ new: figure(), ref: figure() }, true);
    expect(traces).toHaveLength(4);
    expect(traces.map(t => t.name)).toEqual(["ref | p99", "ref | SLO", "new | p99", "new | SLO"]);
    expect(traces.every(t => t.x.length === 2)).toBe(true);
  });

  it("dashes and fades the reference's traces that set their colors, keeping the traces' own dashes", () => {
    const [ref_p99, ref_slo, new_p99, new_slo] = overlay({ new: figure(), ref: figure() }, true);
    expect(ref_p99.line).toMatchObject({ color: "#c87619", dash: "dashdot" });
    expect(ref_p99.opacity).toBe(0.4);
    expect(new_p99.line.dash).toBeUndefined();
    expect(ref_slo.line.dash).toBe("dot");
    expect(new_slo.line.dash).toBe("dot");
  });

  it("leaves the traces alone without a reference", () => {
    const data = { new: figure() };
    expect(overlay(data, false)).toEqual(figure());
  });
});
