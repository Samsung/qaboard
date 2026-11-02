import { describe, expect, it } from "vitest";
import { forEachInTree, selfDelta, selfValue } from "../viewers/flameDeltas";

const tree = (lock, model) => ({
  name: "all", value: 100 + lock + model, children: [
    { name: "worker", value: 100 + lock + model, children: [
      { name: "respond", value: 20 + lock, children: lock ? [{ name: "lock", value: lock }] : [] },
      { name: "model", value: model },
    ]},
  ],
});

// what d3-flame-graph's computeDelta does with the deltas we give it: each node's plus its children's
const inclusive = node => (node.delta ?? 0) + (node.children ?? []).reduce((sum, c) => sum + inclusive(c), 0);

describe("differential flame graphs", () => {
  it("has self values", () => {
    const t = tree(30, 50);
    expect(selfValue(t)).toBe(0);
    expect(selfValue(t.children[0])).toBe(80);
    expect(selfValue(t.children[0].children[0])).toBe(20);
    expect(selfValue(undefined)).toBe(0);
  });

  it("gives each node its self delta, so that the sums are the inclusive deltas", () => {
    const ref = tree(0, 80);
    const now = tree(30, 50);
    const map = {};
    forEachInTree(ref, (node, id) => map[id] = node);
    forEachInTree(now, (node, id) => node.delta = selfDelta(node, map[id]));
    const respond = now.children[0].children[0];
    expect(inclusive(respond)).toBe(30);          // the new lock frame and its callers: more time
    expect(inclusive(respond.children[0])).toBe(30);
    expect(inclusive(now.children[0].children[1])).toBe(-30);   // the model: less
    expect(inclusive(now)).toBe(0);               // the same total
  });
});
