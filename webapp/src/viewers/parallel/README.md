# Parallel coordinates

One vertical axis per column, one curved line per row: how the rows of a table (tuning experiments, with their
metrics and parameters) relate across columns. A standalone React component: it imports only `react`,
`@blueprintjs/core` and its own files (`viewers/__tests__/isolation.test.js` checks it). The app loads it lazily
through `components/tuning/ParallelCoordinatesPlot.jsx`.

`npm start`, then `/parallel-coordinates.html` shows it alone with generated data: `?kind=grid|optuna|mixed`,
`?rows=5000&columns=45`, `?dark`, `?height=600`, `?empty` (see `generate.js`).

```jsx
import { ParallelCoordinates } from './ParallelCoordinates';

<ParallelCoordinates
  columns={[
    { key: 'psnr', label: 'PSNR', suffix: ' dB', better: 'higher', group: 'Metrics' },
    { key: 'denoise.strength', label: 'denoise.strength', log: true, group: 'Parameters' },
    { key: 'mode', label: 'mode', choices: ['off', 'fast', 'accurate'], group: 'Parameters' },
  ]}
  rows={[{ id: 12, label: 'Iteration 12', values: { psnr: 38.2, 'denoise.strength': 0.01, mode: 'fast' } }, ...]}
  colorBy="psnr"
  marks={{ 12: { label: 'Best' } }}
  onSelectionChange={ids => ...}
/>
```

Memoize `columns` and `rows`: the plot analyzes them again when they change.

## Props

| Prop | |
|---|---|
| `columns` | `[{ key, label, type, log, better, group, suffix, format, choices }]`, see below |
| `rows` | `[{ id, values: { [key]: any }, label }]`. `label` is the first line of the tooltip ("Iteration 12") |
| `colorBy` | The key of the column that colors the lines, or `null` for one color. Numbers get a sequential scale (viridis, whose end that stands out on the theme's background is the highest value, or the good one with `better`), categories a palette |
| `onColorByChange(key \| null)` | Called by "Color by this" in an axis' menu, and by the "Color" button. With it `colorBy` is controlled; without it, `colorBy` is where the plot starts from |
| `marks` | `{ [id]: { label, color } }`: rows drawn thicker, on top, whatever is hovered or filtered, with their label at the right end (no text with an empty label). `color` defaults to the text's color |
| `onSelectionChange(ids \| null)` | The ids of the rows that pass every filter, when the filters change; `null` without filter |
| `selection` | Ids (array or Set) to show as selected while the user has no filter of their own, e.g. rows picked in a table. The others are drawn in gray |
| `onHover(row \| null)` | The row whose line is hovered |
| `onRowClick(row)` | A click on a line |
| `height` | Of the plot, in pixels (default 420). The toolbar above and the scrollbar are extra |
| `dark` | The theme. By default: whether the plot is inside a `.bp6-dark` element |
| `tooltipExtra(row)` | More content for the bottom of the tooltip |
| `empty` | What to show without rows or with less than 2 columns that vary, instead of "Nothing to compare yet" |
| `className` | Added to the root element |
| `onTiming({ what, ms })` | For the playground: how long `layout`, `lines`, `overlay` and `hover` take |

### Columns

- `key`, `label`: long labels are cut (dotted paths keep their end) and shown whole on hover.
- `type`: `'number'` or `'category'`. By default it's inferred: numbers and numeric strings make a number column;
  booleans, strings, arrays and objects (as JSON) a category column. A column with at least 90% of numbers stays a
  number column, and its other values go to a separate band under the numbers.
- `log`: starts with a log scale (numbers above 0). Users toggle it in the axis' menu.
- `better`: `'lower'` or `'higher'`: marks the good end of the axis, and of the color scale.
- `group`: e.g. `'Metrics'`, `'Parameters'`: consecutive columns of a group are named, apart from the next group.
- `suffix`, `format(value) => string`: for the values in the tooltip.
- `choices`: the order of the categories.

`undefined`, `null` and `NaN` are missing values: their lines go through a "missing" strip under the axes.
Columns where every row has the same value are hidden by default: "+ N hidden" lists them, with that value.

## What users can do

- **Follow lines through shared values.** Rows that share a place on an axis (a category, a value of a grid search,
  integers) fan out over a small band around it, ordered like on the neighbouring axes, so that bundles don't mix.
  Bands are bounded (`GEOMETRY` in `model.js`): they never reach the next value. Tooltips show the true values.
- **Hover** a line anywhere: it's drawn on top with its value on every axis, and a tooltip lists the row.
  Hover a category or a value of a grid to see all its rows.
- **Filter**: drag along an axis to keep a range (drag the range or its ends to change it, double-click or ✕ to clear),
  click categories or grid values to toggle them. Axes combine: rows must pass every filter.
- **Arrange**: drag an axis' title to move it; click it (or Enter) for its menu: color by this, flip, log scale,
  move left/right, hide.

## Files

- `model.js`: the logic, without React or canvas: types, scales and ticks, layout, spreading ties, brushes, hit testing.
- `colors.js`: the color scales. `draw.js`: the canvases. `ParallelCoordinates.jsx`: the component. `parallel.css`:
  every selector starts with `.qa-parallel`.
- `generate.js`, `playground.jsx`: the playground's data and page.

How it stays fast (5,000 rows x 45 columns): positions are typed arrays computed once per layout; the lines are
drawn on canvas tiles, only those in view, and only when the data, layout or filters change (a sample of the rows
while a filter is dragged); hovering only redraws a small overlay canvas and fades the tiles with CSS.

## Limits

- An axis has one order for its tied rows: with three axes of few values in a row, the middle one is ordered for its
  right neighbour first, so bundles are clean on its right and can mix within its bands on its left.
- Categories can't be reordered by hand (`choices` sets their order), and with more than a few dozen categories on
  an axis not all are labeled.
- Filtering by category isn't reachable with the keyboard (the axis menus are).
