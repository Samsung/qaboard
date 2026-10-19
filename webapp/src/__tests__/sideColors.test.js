import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { plot_color, side_color, with_default_labels } from "../sideColors";

const css = fs.readFileSync(path.join(import.meta.dirname, "../App.css"), "utf-8");

// --qa-side-0: #2d72d2; in the light theme (:root), then the dark one (.bp6-dark)
const css_colors = block => Object.fromEntries([...css.split(block)[1].split('}')[0].matchAll(/--qa-side-(\d+|other): (#\w+)/g)].map(m => [m[1], m[2]]));

describe("the colors of what we compare", () => {
  it("are those of App.css, for plots in both themes", () => {
    const light = css_colors(':root {');
    const dark = css_colors('.bp6-dark {');
    for (const slot of [0, 1, 2, 3, 4]) {
      expect(side_color(slot).css).toBe(`var(--qa-side-${slot})`);
      expect(plot_color(side_color(slot), false)).toBe(light[slot]);
      expect(plot_color(side_color(slot), true)).toBe(dark[slot]);
    }
    expect(plot_color(side_color(7), true)).toBe(dark.other);
  });

  it("are new and reference, blue and purple, without names", () => {
    expect(with_default_labels(undefined)).toEqual({ new: 'new', reference: 'reference', colors: { new: side_color(0), reference: side_color(1) } });
    const labels = { new: 'ISP v2', reference: 'v1.4', colors: { new: side_color(0), reference: side_color(2) } };
    expect(with_default_labels(labels)).toEqual(labels);
  });
});
