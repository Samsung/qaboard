// The colors of what we compare: the new results are blue, the references purple, then magenta, teal, violet.
// A reference's color follows its place in the list of references, like its number: 1 is purple.
// Past 4 references, they are gray: their number and name tell them apart.
//
// Checked with the dataviz skill's validator (scripts/validate_palette.js, all pairs: new is next to every reference
// in viewers, references are next to each other in the tabs): no pair is closer than ΔE 16 for full color vision,
// and 6.5 for protanopia and deuteranopia: blue and purple are the closest, they always come with their names.
// In the app, use the CSS variables (App.css), they follow the theme. Viewers draw labels on images: they get the
// light theme's colors, whatever the theme, with the text color that reads on them.
const light = ['#2d72d2', '#9752fe', '#cf0494', '#0ea2ac', '#5e17cd'];
const other = '#738091';
// on the colors above: teal is too light for white text
const text = ['#ffffff', '#ffffff', '#ffffff', '#111418', '#ffffff'];

// slot 0 is the new results, slot n the reference number n
export const side_slot = (key, number) => key === 'new' ? 0 : number;

export const side_color = slot => ({
  // for the app's UI
  css: slot < light.length ? `var(--qa-side-${slot})` : 'var(--qa-side-other)',
  // for labels on images
  hex: light[slot] ?? other,
  text: text[slot] ?? '#ffffff',
});
