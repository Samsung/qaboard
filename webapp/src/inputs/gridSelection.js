// Selecting inputs in a grid, like in file managers:
// - a click selects one input (and only it)
// - ctrl/cmd+click adds or removes one
// - shift+click selects the range from the last input clicked, ctrl/cmd+shift+click adds the range
// The selection is {selected: Map(id => input), anchor: index of the last input clicked, or null}.
// `item_at(index)`: the input at an index of the grid, undefined while its page isn't loaded (ranges skip them).

export const empty_selection = { selected: new Map(), anchor: null };

const range = (from, to) => {
  const [start, end] = from <= to ? [from, to] : [to, from];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
};

export const click_selection = (state, index, item_at, { shift = false, toggle = false } = {}) => {
  const item = item_at(index);
  if (!item) return state;
  if (shift && state.anchor !== null) {
    const selected = toggle ? new Map(state.selected) : new Map();
    for (const i of range(state.anchor, index)) {
      const it = item_at(i);
      if (it) selected.set(it.id, it);
    }
    // the anchor stays: shift+clicks change the end of the range
    return { selected, anchor: state.anchor };
  }
  if (toggle) {
    const selected = new Map(state.selected);
    if (selected.has(item.id)) selected.delete(item.id);
    else selected.set(item.id, item);
    return { selected, anchor: index };
  }
  return { selected: new Map([[item.id, item]]), anchor: index };
};

// The checkbox on a tile: adds or removes it, like ctrl+click
export const toggle_selection = (state, index, item_at) => click_selection(state, index, item_at, { toggle: true });

export const select_all = (count, item_at) => {
  const selected = new Map();
  for (let i = 0; i < count; i++) {
    const it = item_at(i);
    if (it) selected.set(it.id, it);
  }
  return { selected, anchor: null };
};

// Where the arrow keys move the focus in a grid of `columns`
export const move_focus = (index, key, { count, columns }) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, Home: -Infinity, End: Infinity, PageUp: -columns * 4, PageDown: columns * 4 }[key];
  if (step === undefined) return null;
  return Math.min(Math.max(0, (index ?? 0) + step), Math.max(0, count - 1));
};
