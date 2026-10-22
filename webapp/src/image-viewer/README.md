# Image viewer

A React component to compare images: **side by side**, with a **wipe**, **one at a time** in place, or as their
**difference**, with synced deep zoom, the **values of the pixels** (the image's own: raw, 16-bit, float...) written on
them when zoomed in, full screen, regions of interest, histograms, row and column profiles, statistics and display adjustments. It is [QA-Board](https://github.com/Samsung/qaboard)'s image viewer, and
works in any React app.

It depends on React (19.2+) and [OpenSeadragon](https://openseadragon.github.io/) (6.x) only.

```jsx
import { ImageViewer } from '@qaboard/image-viewer';
import '@qaboard/image-viewer/style.css';

<ImageViewer image="/results/new/out.png" reference="/results/ref/out.png" />
```

- [Install](#install)
- [Usage](#usage): images, comparison modes, comparing with other images, pixel values (the image's or the displayed ones), regions of interest, sync
- [Props](#props)
- [The difference](#the-difference)
- [Theming](#theming)
- [How it works](#how-it-works)
- [Development and publishing](#development-and-publishing)


## Install
The package is built from QA-Board's repository:

```bash
cd webapp
npm ci
npm run build:image-viewer      # => build-image-viewer/
cd build-image-viewer
npm pack                        # => qaboard-image-viewer-0.1.0.tgz
```

then, in your app:

```bash
npm install react react-dom openseadragon@^6.1.1 /path/to/qaboard-image-viewer-0.1.0.tgz
```

Once it's on a registry (see [Publishing](#publishing)): `npm install @qaboard/image-viewer openseadragon`.

Import the stylesheet once, e.g. next to your app's entry point: `import '@qaboard/image-viewer/style.css'`.


## Usage

### Images
An image is a URL, or an object:

```jsx
// A plain image (PNG, JPEG, WebP...), loaded at once
<ImageViewer image="/results/out.png" />

// With labels, shown on the images and in the pixel values, maybe in their own colors (else blue and purple)
<ImageViewer
  image={{ url: '/results/new/out.png', label: 'ISP v2' }}
  reference={{ url: '/results/ref/out.png', label: 'ISP v1', color: '#cf0494', textColor: '#fff' }}
/>

// Large images, streamed tile by tile from an IIIF image server (e.g. Cantaloupe or IIPImage):
// the URL of the image's IIIF service, without "/info.json"
<ImageViewer image={{ iiif: 'https://iiif.example.com/iiif/2/runs%2F42%2Fout.tiff', href: '/files/runs/42/out.tiff' }} />
```

`iiifUrl(server, path)` builds the URL of a file on servers whose identifiers are paths:
`iiifUrl('https://iiif.example.com/iiif/2/', 'runs/42/out.tiff')`.

The images don't have to be "new" and "reference": compare an output with the input, two stages of a pipeline, two
algorithms... The labels say which is which.

> **CORS**: the viewer reads the pixels it displays (for the difference, the values and the histograms). Images served
> from another origin need an `Access-Control-Allow-Origin` header.

### Comparison modes
Users pick the mode in the toolbar, or with the keys 1 to 4. To control it, e.g. to apply it to all the viewers of a
page or to save it in the URL:

```jsx
const [mode, setMode] = useState('side-by-side');
<ImageViewer image={a} reference={b} mode={mode} onModeChange={setMode} />
```

The same goes for `diff` / `onDiffChange` (how the difference is computed), `adjustments` / `onAdjustmentsChange`,
`pixelValues` / `onPixelValuesChange` and `analysis` / `onAnalysisChange` (the view of the analysis panel: histogram,
row and column profiles, or statistics; QA-Board saves it in the user's preferences). Without them, the viewer keeps its own state, from
`defaultMode`, `defaultDiff`...

### Comparing with other images
Users often want to compare an image with something else than its reference: its ground truth, the input, another
stage of the pipeline... List those images in `compareWith`: the toolbar then shows **vs reference ▾**, a menu with a
search box, the reference first, then your images by `group`, with thumbnails for IIIF images. The image picked shows
instead of the reference, in every mode, with its name and a file icon on its label, in its own color (teal, or its
`color`). The undo button next to the menu, or <kbd>c</kbd>, goes back to the reference; <kbd>c</kbd> again goes back
to the image picked last.

```jsx
<ImageViewer
  image={{ iiif: '/iiif/2/runs%2F42%2Fout%2F0001.png', label: 'new' }}
  // optional: `detail` says what it is, in the menu
  reference={{ iiif: '/iiif/2/runs%2F41%2Fout%2F0001.png', label: 'reference', detail: 'The same file in the reference run' }}
  compareWith={[
    { id: 'gt/0001.png', image: { iiif: '/iiif/2/runs%2F42%2Fgt%2F0001.png' }, group: 'Suggested', detail: 'Same name, in gt/' },
    { id: 'input.png', image: { iiif: '/iiif/2/runs%2F42%2Finput.png' }, group: 'This run' },
  ]}
/>
```

An item's `label` is its `id` by default; folders are muted in the menu. Without a reference, the menu reads
**Compare with…**: the image shows alone until users pick one. Control what's compared (`compared`, `onComparedChange`:
an id, or `null` for the reference) to pick the same in several viewers: QA-Board compares the image of every run of
a page with that run's file of the same name. When a viewer has no item with the id, it compares with the reference,
and says the image is missing.

Say where a pick applies with `compareScopes` (`[{ value, label, title?, phrase? }]`, the first by default), e.g. every
run of the page or this one only: the menu shows them under **Apply to**, the message after a pick ends with the
`phrase` ("Comparing with gt/0001.png in every run"), and you get the scope back to store the pick where it belongs.
`comparedNote` shows next to the name in the toolbar, e.g. "this run" when a run differs from the others.

The viewer doesn't know where the images come from: QA-Board lists the files of the run, the likeliest first (the same
name in another folder, names that start alike next to it).

### Pixel values: the image's, or the displayed ones
There are two kinds of values, and the viewer always says which one users look at:

- **Image values**: the file's own, e.g. 10-bit RGB, 16-bit gray, float depth, raw. What algorithms compute on.
- **Displayed values**: the 8-bit sRGB colors on the screen. Image servers and browsers convert images to show them
  (16-bit to 8-bit, raw to RGB...), and zoomed out a screen pixel averages many image pixels. They're what users see,
  not the data.

Without more, the viewer only knows the displayed values. Give it `getPixels` to read the image's: they show under the
pointer next to the displayed ones (labelled `image` and `display`; for 8-bit images, whose `mode` is `L`, `LA`, `RGB`,
`RGBA` or `RGBX`, only the image's, unlabelled), and on the pixels when users zoom in, with a badge
("Values: image (I;16)" or "Values: displayed, 8-bit"). Users switch between them in the toolbar's values menu, or hide
them with <kbd>p</kbd>.

```jsx
const getPixels = async (image, { x, y, w, h }, { signal }) => {
  const params = new URLSearchParams({ path: image.path, x, y, w, h });
  const response = await fetch(`/api/pixels?${params}`, { signal });
  if (!response.ok) throw new Error(`Can't read the values: ${response.status}`);
  const [height, width, channels = 1] = response.headers.get('X-Shape').split(',').map(Number);
  return { data: new Uint16Array(await response.arrayBuffer()), width, height, channels, mode: 'I;16' };
};

<ImageViewer image={{ iiif, path: 'runs/42/out.tiff' }} getPixels={getPixels} />
```

It resolves to the region's values as a flat array, row by row, channel by channel (`{ data, width, height, channels?,
mode? }`, a typed array is best), or as rows of pixels, each a number or an array of channels (`{ values, mode? }`, like
numpy's `image[y:y+h, x:x+w].tolist()`). `mode` says what they are. Your fields (here `path`) are passed back.

The viewer asks for **tiles of 64×64 pixels** (aligned on multiples of 64, cut at the image's edges): the tile under the
pointer, and the tiles in view once the values are written on the pixels. It keeps the last 512, sends only the latest
request while users move the pointer, and asks again for a tile that failed after 10 s. Most of the time goes to
decoding the image on the server: cache the decoded images there. A server could be:

```python
@app.route("/api/pixels")
def pixels():
  x, y, w, h = (int(request.args[k]) for k in "xywh")
  image = read_image(request.args["path"])  # a numpy array (height, width[, channels]), cached
  region = np.ascontiguousarray(image[y:y+h, x:x+w], dtype="<u2")
  return Response(region.tobytes(), mimetype="application/octet-stream",
                  headers={"X-Shape": ",".join(map(str, region.shape))})
```

JSON works too, but binary is about 3× smaller and needs no parsing. QA-Board's server is
`GET /api/v1/output/image/pixels?image_url=…&x=…&y=…&w=…&h=…&format=binary` (backend/backend/api/image.py): it
answers with the values' type and shape in `X-Pixels-Dtype` and `X-Pixels-Shape`, and keeps the decoded images on disk.

### Raw images: analysis by channel of the sensor
With `getPixels`, the analysis panel (<kbd>a</kbd>) measures the image's own values too: **Image values**, next to
its views. Its histograms, row and column profiles and statistics are then per channel of the sensor's color filter
array (CFA): R, Gr, Gb and B, R G B, or each sub-pixel of the cells (R1 to R4 in Tetra...), on the values at full
resolution. Views up to 2 million pixels are read whole, larger ones in strips across them, by requests of 256×256.

A card says what the sensor is, with a diagram of the CFA, and where each value comes from:

1. what users set (the **Sensor** button: pattern, cell size, offset, black level), in the `sensor` prop
   (`{ kind, pattern, block, offset, blackLevel, grouping }`): control it to remember it, e.g. per project,
2. the image's metadata: return it from `getPixels` as `sensor`,
3. the pixels: the CFA guessed from a 256×256 patch at the center of the view, the bit depth from the largest value.

```jsx
const getPixels = async (image, region, { signal }) => {
  // ...
  return {
    data, width, height, channels: 1, mode: 'I;16',
    // all optional: what you know
    sensor: {
      cfa: { pattern: 'GRBG', block: 2 },  // Tetra; 1 for Bayer, 3 for Nona... the pattern of the file's first pixel
      bitDepth: 10, blackLevel: 64,        // whiteLevel: 2^bitDepth - 1 by default
      source: "the file's header",         // shown to users
      fields: { pattern: 'GRBG', samplePerPixel: '2x2', pedestal: 64 },  // the metadata used, shown to users
    },
  };
};
```

How the CFA is guessed (`cfa.js`): the mean over a period of the CFA (2 × the cell size, in both directions) has all
the colors in equal parts. Each pixel minus that mean leaves its color's difference, and noise and the scene's
details. For each cell size from 1×1 to 9×9, we measure how much the position in the period explains it (R², with an F
test for significance), and keep the smallest size that explains about as much as the best (multiples explain it too).
The cells start where they're most uniform, the greens are the diagonal whose cells are most alike period by period,
and red is assumed on the top row: one channel can't tell red from blue, the card says so. The guess is checked on the
4 quarters of the patch for its confidence. Images whose pixels each have one of R, G or B set are read exactly.
Sub-pixels with consistently different levels (e.g. long and short exposures) are reported.

### Regions of interest
Users step through regions (with thumbnails for IIIF images), or copy the region in view:

```jsx
<ImageViewer
  image={image}
  regionSets={[
    // in the pixels of the image, or of an image of another size: they're scaled
    { id: 'charts', label: 'Charts', regions: [{ x: 120, y: 80, w: 400, h: 300, label: 'ColorChecker', imageWidth: 4000, imageHeight: 3000 }] },
    // found on demand, when users pick the set
    { id: 'auto', label: 'Where they differ', regions: found, loading, error, load: () => findRegions() },
  ]}
  defaultRegionSet="charts"
/>
```

Control the set shown (`regionSet`, `onRegionSetChange`) to show the same in several viewers, and add your own actions
to the regions menu with `regionActions`: QA-Board's finds where the images differ for all the runs of a page, then
ranks the runs.

### Blind test
**Blind test** (next to Swap, or <kbd>h</kbd>) shows the images in a random order, called A and B in the labels, the
values under the pointer, the histograms and the menus. **Reveal** then shows which was which, and **Done** goes back
to the image first. To run one test over several viewers, control it: QA-Board shuffles each viewer of the page with
its own coin, from the test's seed.

```jsx
const [swapped, setSwapped] = useState(false);
const [test, setTest] = useState(null); // { seed, swapped: when it started, revealed }
// heads or tails for this viewer and this test, e.g. a hash of the seed and an id of the viewer
const shuffled = !!test && coin(test.seed, id);
<ImageViewer
  image={a}
  reference={b}
  swapped={swapped !== shuffled}
  onSwappedChange={() => setSwapped(s => !s)}
  // what showed first when the test started is A
  blindTest={test && { a: test.swapped !== shuffled ? 'B' : 'A', revealed: test.revealed }}
  onBlindTestChange={action => {
    if (action === 'start') setTest({ seed: Math.random(), swapped, revealed: false });
    else if (action === 'reveal') setTest(t => ({ ...t, revealed: true }));
    else { setTest(null); setSwapped(false); }
  }}
/>
```

Toggling (<kbd>t</kbd>) flips `swapped`, and never changes the mode: control `swapped` and `mode` so that all the viewers
stay in step.

### Synced viewers
Viewers with the same `syncKey` zoom and pan together, when their images have the same aspect ratio (whatever their
resolution), and show a cross where the pointer is on the others. Viewers off-screen catch up when they show.

```jsx
<ImageViewer image={rgb} syncKey="scene-12" />
<ImageViewer image={depth} syncKey="scene-12" />
```


## Props
| Prop | Type | Default | |
|---|---|---|---|
| `image` | URL or `{ url \| iiif, label?, color?, textColor?, href?, ... }` | required | The image. `color`: of its label (blue by default, purple for `reference`), `textColor`: of the label's text (white) |
| `reference` | same, or `null` | `null` | What it's compared with. `detail`: what it is, in the **vs** menu |
| `compareWith` | `[{ id, image, label?, group?, detail?, title? }]` | `[]` | [Other images](#comparing-with-other-images) users can compare with instead of the reference |
| `compared`, `defaultCompared`, `onComparedChange` | `string \| null` | `null` | The id of the image of `compareWith` compared with, `null`: the reference |
| `compareScopes`, `compareScope`, `onCompareScopeChange` | `[{ value, label, title?, phrase? }]`, `string` | `[]` | Where a pick applies, e.g. `'all'` the runs or this `'run'` |
| `comparedNote` | `string` | | Next to what's compared with, in the toolbar |
| `mode`, `defaultMode`, `onModeChange` | `'side-by-side' \| 'wipe' \| 'single' \| 'difference'` | `'side-by-side'` | How they're compared |
| `diff`, `defaultDiff`, `onDiffChange` | `{ method, gain?, max?, layout? }` | `{ method: 'perceptual' }` | [The difference](#the-difference), and whether the images show on its sides (`layout: 'between'`, the default) or not (`'alone'`) |
| `adjustments`, `defaultAdjustments`, `onAdjustmentsChange` | `{ brightness, contrast, gamma, sharpen, channel, falseColor, invert }` | none | How images look. Only the display changes. |
| `pixelValues`, `defaultPixelValues`, `onPixelValuesChange` | `'image' \| 'display' \| 'off'` | `'image'` | [Values](#pixel-values-the-images-or-the-displayed-ones) written on the pixels when zoomed in. `'image'` needs `getPixels`, else they're the displayed ones. |
| `getPixels` | `(image, { x, y, w, h }, { signal }) => Promise<{ data, width, height, channels?, mode? } \| { values, mode? }>` | | The image's own values, by tiles of 64×64 |
| `imageValuesUnavailable` | `string` | | Without `getPixels`, why the image's own values aren't available, e.g. "Log in to read the images' own values" |
| `analysis`, `defaultAnalysis`, `onAnalysisChange` | `'histogram' \| 'profiles' \| 'stats'` | the one picked last on the page | The view of the analysis panel under the images (<kbd>a</kbd> shows it) |
| `analysisValues`, `defaultAnalysisValues`, `onAnalysisValuesChange` | `'display' \| 'image'` | `'display'` | What the analysis measures: the displayed values, or the [image's own](#raw-images-analysis-by-channel-of-the-sensor) (needs `getPixels`) |
| `sensor`, `defaultSensor`, `onSensorChange` | `{ kind?, pattern?, block?, offset?, blackLevel?, grouping? }` | automatic | What users set about the sensor of raw images |
| `sensorRemembered` | `string` | | Where it's remembered, shown to users, e.g. "for the project" |
| `syncKey` | `string` | | Viewers with the same key are synced |
| `regionSets` | `[{ id, label, regions?, loading?, error?, load?, empty? }]` | `[]` | Regions of interest |
| `regionSet`, `defaultRegionSet`, `onRegionSetChange` | `string \| null` | | The set shown (`null`: the full image) |
| `regionActions` | `[{ id, label, icon?, title?, onClick }]` | `[]` | Your actions in the regions menu |
| `swapped`, `defaultSwapped`, `onSwappedChange` | `boolean` | `false` | The reference shows first. Control it to swap several viewers at once |
| `blindTest`, `onBlindTestChange` | `{ a: 'A' \| 'B', revealed? } \| null` | | [A blind test](#blind-test), controlled, e.g. for every viewer of a page |
| `maxHeight` | `number \| (windowHeight) => number` | `h => h - 160` | The highest images can be |
| `theme` | `'light' \| 'dark'` | the system's | Or use the [CSS variables](#theming) |
| `notice`, `toolbarExtra` | React nodes | | Your own things in the toolbar |
| `className`, `style` | | | On the viewer's root |

The types are in `index.d.ts`. The package also exports helpers: `iiifUrl`, `thumbnailUrl`, `openImage`,
`DIFF_METHODS`, `normalizeDiff`, `diffAt`, `regionAsYaml`, `scaleRegion`, `clipRegion`, `MODES`.

### Keyboard
Anywhere on the page: for the viewer in full screen, else under the mouse, else that has the focus, else the one used
last if it's in view, else the first in view. <kbd>1</kbd>–<kbd>4</kbd> the mode, <kbd>t</kbd> toggle: in single mode
the other image (like a click on the image), else swap the sides (or the order of the difference alone), <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> zoom, <kbd>p</kbd> pixel values, <kbd>a</kbd> analysis panel,
<kbd>h</kbd> blind test (then reveal, then end), <kbd>c</kbd> compare with the reference, or the image of `compareWith` picked last, <kbd>f</kbd> full screen (<kbd>Esc</kbd> leaves), <kbd>[</kbd> <kbd>]</kbd> previous / next region. The wheel or a pinch zooms, a drag pans, a
double-click zooms in.


## The difference
| `method` | Setting | What it shows |
|---|---|---|
| `absolute` | `gain` (×1 to ×64) | Each channel of \|new − reference\|, amplified. Black where identical. |
| `signed` | `gain` | Luma of new − reference: red where new is brighter, blue where darker. |
| `perceptual` | `max` (1% to 30%) | Perceived color difference in the YIQ space (Kotsarenko and Ramos, as in pixelmatch), as a fraction of the largest possible. |
| `deltaE` | `max` (ΔE 1 to 20) | CIEDE2000 color difference. Under 1 it is imperceptible, about 2.3 just noticeable. |
| `exact` | | In red, the pixels that differ at all. |

By default the difference shows between the two images (new | difference | reference), all synced: zoom or pan any of
them. Click **Difference** again (or press <kbd>4</kbd> again) to see it alone, larger.

Heatmaps show small differences in yellow and large ones (up to `max`) in black, over a faded copy of the image that
tells where you are. A legend says what the colors mean. Hovering shows the difference per channel, and the method's
measure, e.g. ΔE.

It is computed on what the viewer **displays**: 8-bit sRGB at the screen's resolution. Zoomed out, a screen pixel is a
downscaled version of many image pixels, and small differences can average out: zoom to 1:1 or more to compare every
pixel. For the full images, compare them on a server (QA-Board's "Where they differ" regions do).


## Theming
The viewer follows the system's light or dark theme, or `theme`. To match your app, override its CSS variables:

```css
.qiv {
  --qiv-text: #1c2127;            --qiv-text-muted: #5f6b7c;
  --qiv-surface: #fff;            --qiv-surface-alt: #f6f7f9;
  --qiv-border: rgba(17, 20, 24, 0.15);
  --qiv-hover: rgba(143, 153, 168, 0.18);
  --qiv-pressed: rgba(45, 114, 210, 0.16);
  --qiv-accent: #2d72d2;          /* active buttons, links */
  --qiv-primary: #2d72d2;         /* the image's label */
  --qiv-warning: #c87619;         /* the reference's label, changed adjustments */
  --qiv-danger: #cd4246;
  --qiv-stage: #1c2127;           /* behind the images */
  --qiv-pane: #111418;
  --qiv-shadow: 0 2px 10px rgba(17, 20, 24, 0.2);
  --qiv-mono: ui-monospace, monospace;
}
```

The defaults have no specificity (`:where`): any rule wins. QA-Board's are in `webapp/src/viewers/images/image-viewer-theme.css`.
The viewer inherits the font of the page.


## How it works
| File | |
|---|---|
| `ImageViewer.jsx` | The component: layout per mode, toolbar, keyboard, regions |
| `comparison.js` | The OpenSeadragon viewers of the two images, loading, sync, reading the displayed pixels. React subscribes to it. |
| `sync.js` | Groups of viewers that zoom and pan together (`syncKey`) |
| `sources.js` | Images (URLs, IIIF) to OpenSeadragon tile sources. PNG tiles when the server has them: JPEG would change the values. |
| `metrics.js` | The difference methods (YIQ, CIEDE2000...), used without WebGL, for the values under the pointer, and by the tests |
| `diffRenderer.js` | The difference on the GPU: one WebGL context shared by all the viewers (browsers keep ~16 per page) |
| `overlays.jsx` | Drawn over the images: the difference, the highlighted values, pixel values, crosshairs, minimap |
| `panels.jsx` | Values under the pointer, histograms, adjustments, regions |
| `histogram.js`, `highlightRenderer.js` | Histograms, and the range of values highlighted from them, on the GPU (one more WebGL context shared by all the viewers) |
| `analysis.js`, `analysisPanel.jsx`, `profilePlot.jsx` | The analysis panel: histogram, row and column profiles, statistics of the view (displayed values) |
| `cfa.js`, `imageAnalysis.js`, `regionValues.js`, `sensorPanel.jsx` | The analysis of the image's own values: CFAs and their guess, reading the view with `getPixels`, the sensor's card |
| `adjustments.js` | Display adjustments, as an SVG filter: they don't touch the pixels we read |
| `regions.js`, `pixels.js`, `colormaps.js` | Helpers |
| `ui.jsx`, `icons.js`, `image-viewer.css` | Buttons, menus, icons (from Blueprint): the viewer doesn't need a UI kit |

Notes on OpenSeadragon 6: the viewer uses its canvas drawer, not the default WebGL one, to read the pixels it draws
(and so that many viewers don't use up the page's WebGL contexts). It doesn't use OpenSeadragon's controls or plugins.


## Development and publishing

```bash
cd webapp
npm start                       # then open http://localhost:3000/image-viewer.html: the viewer alone, with generated images
npm test -- --run src/image-viewer
npm run e2e -- e2e/images.spec.js   # after npm run build: the viewer in QA-Board, with a mocked IIIF server
```

The viewer must not import anything from QA-Board: QA-Board adapts it in `webapp/src/viewers/images/`
(`QaboardImageViewer.jsx`: runs, image servers, pixel values, regions of interest).

### Publishing
1. Bump `version` in `src/image-viewer/package.json` ([semver](https://semver.org/): a new major for any breaking
   change of the props), and note the changes in QA-Board's release notes.
2. `npm run build:image-viewer`, then in `build-image-viewer/`: `npm publish --access public` (or
   `--registry https://your-registry/` for a private registry).
3. Check it in a fresh app: `npm install @qaboard/image-viewer openseadragon`, then render a viewer.
