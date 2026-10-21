// The colors of what we compare: by default the new results are blue, the references purple, then magenta, teal, violet.
// They keep their color wherever they go, even when they are swapped with the top results: those added get the first
// free color (see side_colors in src/selection.js). Past 5, they are gray: their number and name tell them apart.
//
// Checked with the dataviz skill's validator (scripts/validate_palette.js, all pairs: new is next to every reference
// in viewers, references are next to each other in the tabs): no pair is closer than ΔE 16 for full color vision,
// and 6.5 for protanopia and deuteranopia: blue and purple are the closest, they always come with their names.
// In the app, use the CSS variables (App.css), they follow the theme. Viewers draw labels on images: they get the
// light theme's colors, whatever the theme, with the text color that reads on them. Plots can't use CSS variables:
// they pick the hex of the theme with plot_color.
const light = ['#2d72d2', '#9752fe', '#cf0494', '#0ea2ac', '#5e17cd'];
const other = '#738091';
// the same as App.css's .bp6-dark
const dark = ['#4c90f0', '#9c4bf5', '#f438a6', '#12e0d8', '#dc96fe'];
const other_dark = '#8f99a8';
// on the colors above: teal is too light for white text
const text = ['#ffffff', '#ffffff', '#ffffff', '#111418', '#ffffff'];

// how many colors, the others are gray
export const side_color_count = light.length;

// slot n is the color number n, 0 (blue) for the new results by default, undefined: gray
export const side_color = slot => ({
  slot,
  // for the app's UI
  css: slot !== undefined && slot < light.length ? `var(--qa-side-${slot})` : 'var(--qa-side-other)',
  // for labels on images
  hex: light[slot] ?? other,
  // for plots in the dark theme
  hex_dark: dark[slot] ?? other_dark,
  text: text[slot] ?? '#ffffff',
});

// For plots (Plotly, canvases): the side's color in the theme, e.g. plot_color(labels.colors.new, useIsDark())
export const plot_color = (color, is_dark) => is_dark ? color.hex_dark ?? color.hex : color.hex;

// What viewers call the two sides they compare, and their colors. The commit page gives them useComparison().labels:
// milestones' names, what users called them... Elsewhere (history, bit accuracy of artifacts...) they are new and reference.
const default_colors = { new: side_color(0), reference: side_color(1) };
export const with_default_labels = labels => ({
  new: labels?.new ?? 'new',
  reference: labels?.reference ?? 'reference',
  colors: {
    new: labels?.colors?.new ?? default_colors.new,
    reference: labels?.colors?.reference ?? default_colors.reference,
  },
});
