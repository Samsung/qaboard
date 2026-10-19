// Compares an image with a reference: side by side, with a wipe, one at a time (single), or as their difference.
// See README.md for the props.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Comparison } from './comparison';
import { describeAdjustments, filterPrimitives, normalizeAdjustments, changedAdjustments } from './adjustments';
import { DEFAULT_DIFF, normalizeDiff } from './metrics';
import { regionAsYaml } from './regions';
import { DEFAULT_MODE, MODES } from './modes';
import { normalizeImage } from './sources';
import { PixelTiles } from './pixelTiles';
import { ALL_CHANNELS } from './histogram';
import { Crosshair, DiffLayer, HighlightLayer, Minimap, PixelValues } from './overlays';
import { AdjustmentsPanel, DiffLegend, DiffSettings, Histogram, Readout, RegionsMenu, RegionsStrip, Shortcuts, ValuesBadge, ValuesPanel } from './panels';
import { Button, FilterPrimitive, Icon, MenuDivider, MenuItem, Popover, Segmented, Spinner } from './ui';
import './image-viewer.css';

const GAP = 4;
const ZOOM_STEP = 1.5;
// The keyboard shortcuts work all over the page: they go to the viewer in full screen, else the one under the mouse, else
// the one with the focus, else the one used last if it's in view, else the first in view
const viewers = new Set();
let hovered_viewer = null;
let last_viewer = null;
const in_view = element => {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
};
const keyboardViewer = () => {
  if (viewers.has(document.fullscreenElement)) return document.fullscreenElement;
  if (hovered_viewer) return hovered_viewer;
  const focused = [...viewers].find(viewer => viewer.contains(document.activeElement));
  if (focused) return focused;
  if (viewers.has(last_viewer) && in_view(last_viewer)) return last_viewer;
  return [...viewers].filter(in_view).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)[0] ?? null;
};
// each viewer listens to the keys: they agree on the one that handles a key
const keyboard_viewers = new WeakMap();
const keyboardViewerOf = event => {
  if (!keyboard_viewers.has(event)) keyboard_viewers.set(event, keyboardViewer());
  return keyboard_viewers.get(event);
};

// A prop users can control, or leave to the viewer
const useControllable = (value, initial, onChange) => {
  const [state, setState] = useState(initial);
  const current = value !== undefined ? value : state;
  const set = next => {
    if (value === undefined) setState(next);
    onChange?.(next);
  };
  return [current, set];
};

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// the toolbars of the page stay in view
const DEFAULT_MAX_HEIGHT = window_height => window_height - 160;

const copyCanvas = async (canvas, filter) => {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error("your browser can't copy images here (it needs https)");
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(canvas, filter) })]);
};
const canvasBlob = (source, filter) => new Promise((resolve, reject) => {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (filter) context.filter = filter;
  context.drawImage(source, 0, 0);
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('nothing to copy')), 'image/png');
});
// What to tell users once something was copied, or not
const copied = (copy, what) => copy().then(() => `Copied the ${what}`, error => `Can't copy the ${what}: ${error.message}`);
const saveCanvas = async (canvas, filter, filename) => {
  const url = URL.createObjectURL(await canvasBlob(canvas, filter));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};


export const ImageViewer = ({
  image,
  reference = null,
  mode: mode_prop,
  defaultMode = DEFAULT_MODE,
  onModeChange,
  diff: diff_prop,
  defaultDiff = DEFAULT_DIFF,
  onDiffChange,
  adjustments: adjustments_prop,
  defaultAdjustments,
  onAdjustmentsChange,
  pixelValues: pixel_values_prop,
  defaultPixelValues = 'image',
  onPixelValuesChange,
  syncKey = null,
  regionSets = [],
  regionSet: region_set_prop,
  defaultRegionSet = null,
  onRegionSetChange,
  regionActions = [],
  swapped: swapped_prop,
  defaultSwapped = false,
  onSwappedChange,
  blindTest: blind_prop,
  onBlindTestChange,
  getPixels,
  imageValuesUnavailable,
  maxHeight = DEFAULT_MAX_HEIGHT,
  theme,
  notice,
  toolbarExtra,
  className = '',
  style,
}) => {
  const images = { a: normalizeImage(image), b: normalizeImage(reference) };
  const comparing = !!images.b;
  const labels = { a: images.a?.label ?? 'new', b: images.b?.label ?? 'reference' };

  const [controller] = useState(() => new Comparison({ syncKey }));
  useEffect(() => () => controller.dispose(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const [stored_mode, setMode] = useControllable(mode_prop, defaultMode, onModeChange);
  const mode = comparing ? (MODES.some(m => m.value === stored_mode) ? stored_mode : 'side-by-side') : 'no-reference';
  const [diff_setting, setDiff] = useControllable(diff_prop, defaultDiff, onDiffChange);
  const diff = normalizeDiff(diff_setting);
  // In difference mode, the images show on each side of the difference ('between', new | difference | reference), or not
  const diff_layout = diff_setting?.layout === 'alone' ? 'alone' : 'between';
  const toggleDiffLayout = () => setDiff({ ...diff, layout: diff_layout === 'alone' ? 'between' : 'alone' });
  const [adjustments_setting, setAdjustments] = useControllable(adjustments_prop, defaultAdjustments, onAdjustmentsChange);
  const adjustments = normalizeAdjustments(adjustments_setting);
  // Which values are written on the pixels: the images' own ('image', with getPixels), the displayed ones, or 'off'
  const [values_setting, setValuesSetting] = useControllable(pixel_values_prop, defaultPixelValues, onPixelValuesChange);
  const pixel_source = values_setting === 'off' ? 'off' : (values_setting === 'display' || !getPixels) ? 'display' : 'image';
  const last_values = useRef('image');
  const [values_drawn, setValuesDrawn] = useState(null);
  const [tiles] = useState(() => new PixelTiles());
  useLayoutEffect(() => tiles.setGetPixels(getPixels));
  useEffect(() => () => tiles.dispose(), [tiles]);
  // The reference first (on the left, or shown in single mode): controlled with onSwappedChange, e.g. for all the viewers
  // of a page, or not
  const [swapped, setSwapped] = useControllable(swapped_prop, defaultSwapped, onSwappedChange);
  // A blind test: the images are called A and B ({ a: 'A' | 'B', revealed }), in a random order. Controlled with
  // blindTest and onBlindTestChange('start' | 'reveal' | 'end'), e.g. for all the viewers of a page, or not.
  const [own_blind, setOwnBlind] = useState(null);
  const blind = blind_prop !== undefined ? blind_prop : own_blind;
  const blindTest = action => {
    if (blind_prop !== undefined) return onBlindTestChange?.(action);
    if (action === 'start') {
      const coin = Math.random() < 0.5;
      setSwapped(coin);
      setOwnBlind({ a: coin ? 'B' : 'A', revealed: false });
    } else if (action === 'reveal') {
      setOwnBlind(b => b && { ...b, revealed: true });
    } else {
      setOwnBlind(null);
      setSwapped(false);
    }
  };
  const nextBlindStep = () => blindTest(!blind ? 'start' : blind.revealed ? 'end' : 'reveal');
  // What the images are called: new and reference, A and B during a blind test, both once revealed
  const hidden = !!blind && !blind.revealed;
  const other_letter = letter => letter === 'A' ? 'B' : 'A';
  const names = !blind ? labels
    : blind.revealed ? { a: `${labels.a} · ${blind.a}`, b: `${labels.b} · ${other_letter(blind.a)}` }
    : { a: blind.a, b: other_letter(blind.a) };
  const [wipe, setWipe] = useState(0.5);
  const [base, setBase] = useState(10);
  const [show_histogram, setShowHistogram] = useState(false);
  // The channels the histogram shows, and the range of values it highlights on the images (with the channels shown)
  const [histogram_channels, setHistogramChannels] = useState(ALL_CHANNELS);
  const [highlight_range, setHighlightRange] = useState(null);
  const highlight = show_histogram && highlight_range ? { ...highlight_range, channels: histogram_channels } : null;
  const [diff_error, setDiffError] = useState(null);
  const [message, setMessage] = useState(null);
  const diff_canvas = useRef(null);

  // Layout: as wide as we can, as high as the window allows. The header (toolbar, regions, values) is as wide as we can be.
  const root = useRef(null);
  const header = useRef(null);
  const [available, setAvailable] = useState(0);
  const [header_height, setHeaderHeight] = useState(0);
  const [window_height, setWindowHeight] = useState(() => window.innerHeight);
  useLayoutEffect(() => {
    const element = header.current;
    const measure = () => {
      setAvailable(element.clientWidth);
      setHeaderHeight(element.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const size_a = snapshot.a.width ? snapshot.a : null;
  const size_b = snapshot.b.width ? snapshot.b : null;
  const main_size = size_a ?? size_b;
  const aspect = main_size ? main_size.height / main_size.width : 3 / 4;
  const side_by_side = mode === 'side-by-side';
  const diff_between = mode === 'difference' && diff_layout === 'between';
  // The images show apart: side by side, or on each side of their difference
  const apart = side_by_side || diff_between;
  const columns = side_by_side ? 2 : diff_between ? 3 : 1;
  // Full screen: the images take all the room below the header
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(!!root.current && document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const can_fullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  const max_height = Math.max(120, fullscreen
    ? window_height - header_height - 24
    : typeof maxHeight === 'function' ? maxHeight(window_height) : maxHeight);
  const fit = (columns, rows) => Math.floor(Math.max(0, Math.min(
    (available - (columns - 1) * GAP) / columns,
    (max_height - (rows - 1) * GAP) / rows / aspect,
  )));
  // The difference between the images: in a row, or in full screen, under them when the images are larger so
  const stacked = diff_between && fullscreen && fit(2, 2) > fit(3, 1);
  const pane_width = stacked ? fit(2, 2) : fit(columns, 1);
  const pane_height = Math.floor(pane_width * aspect);
  const stage_width = stacked ? 2 * pane_width + GAP : columns * pane_width + (columns - 1) * GAP;
  const stage_height = stacked ? 2 * pane_height + GAP : pane_height;
  // where the difference is
  const diff_position = !diff_between ? { left: 0, top: 0 }
    : stacked ? { left: Math.round((pane_width + GAP) / 2), top: pane_height + GAP }
    : { left: pane_width + GAP, top: 0 };

  // The images
  useEffect(() => {
    controller.setImage('a', images.a);
  });
  useEffect(() => {
    controller.setImage('b', comparing ? images.b : null);
  });
  useEffect(() => controller.setSyncKey(syncKey), [controller, syncKey]);

  // Only viewers near the screen follow the others and compute the difference
  const stage = useRef(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      controller.setVisible(entry.isIntersecting);
      setVisible(entry.isIntersecting);
    }, { rootMargin: '20% 0px' });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [controller]);

  const first = swapped ? 'b' : 'a';
  const second = swapped ? 'a' : 'b';
  const swap = () => setSwapped(!swapped);
  // The toggle (t, the swap button, a click on the image shown alone): when both images show, they swap sides (around
  // their difference). When one shows, or their difference alone: the first image, the other, their difference, and
  // again. The first is new, or A during a blind test: with swapped shared by the viewers of a page, they all stay in step.
  const single = mode === 'single' || (mode === 'difference' && diff_layout === 'alone');
  const lead = blind?.a === 'B' ? 'b' : 'a';
  const other = lead === 'a' ? 'b' : 'a';
  const flip = () => {
    if (!single || (mode === 'single' && first === lead)) return swap();
    if (mode === 'single') {
      // their difference: the first image minus the other
      swap();
      setDiff({ ...diff, layout: 'alone' });
      setMode('difference');
      return;
    }
    if (first !== lead) swap();
    setMode('single');
  };
  const flip_title = !single ? `Swap the sides: ${names[second]} | ${names[first]}`
    : mode === 'single' && first === lead ? `Show the ${names[other]} image`
    : mode === 'single' ? `Show the difference: ${names[lead]} − ${names[other]}`
    : `Show the ${names[lead]} image`;
  // Picking the mode shown again: Single flips the images, Difference shows or hides the images on its sides
  const pickMode = value => {
    if (value === mode && value === 'single') swap();
    else if (value === mode && value === 'difference') toggleDiffLayout();
    else setMode(value);
  };

  // Gestures on the difference between the images move them
  const diff_pane = useRef(null);
  useEffect(() => {
    if (!diff_between || !diff_pane.current) return;
    return controller.trackGestures(diff_pane.current);
  }, [controller, diff_between]);

  // Regions of interest: the set shown (controlled with onRegionSetChange, e.g. the same for several viewers, or not),
  // and the region of the set
  const [selected_set, setSelectedSet] = useControllable(region_set_prop, defaultRegionSet, onRegionSetChange);
  const [region_index, setRegionIndex] = useState({ set: selected_set, index: 0 });
  const index = region_index.set === selected_set ? region_index.index : 0;
  const active_set = selected_set ? regionSets.find(set => set.id === selected_set) ?? null : null;
  const active_region = active_set?.regions?.[index] ?? null;
  const region_key = active_region ? JSON.stringify([active_set.id, index, active_region]) : null;
  useEffect(() => {
    controller.setRegion(active_region);
    if (active_region) controller.fitRegion(active_region);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [controller, region_key]);
  // the whole image again, also when another viewer picked it
  const had_set = useRef(!!selected_set);
  useEffect(() => {
    if (!selected_set && had_set.current) controller.fit();
    had_set.current = !!selected_set;
  }, [controller, selected_set]);
  useEffect(() => {
    if (active_set && !active_set.regions && !active_set.loading && !active_set.error) active_set.load?.();
  }, [active_set]);
  // Picking the region shown again shows it again, e.g. after zooming elsewhere
  const selectSet = id => {
    setSelectedSet(id);
    setRegionIndex({ set: id, index: 0 });
    const first_region = regionSets.find(set => set.id === id)?.regions?.[0];
    if (first_region) controller.fitRegion(first_region);
  };
  const selectRegion = next => {
    setRegionIndex({ set: selected_set, index: next });
    const region = active_set?.regions?.[next];
    if (region) controller.fitRegion(region);
  };
  const stepRegion = step => {
    const count = active_set?.regions?.length ?? 0;
    if (count > 0) selectRegion((index + step + count) % count);
  };

  const notify = text => {
    setMessage(text);
    setTimeout(() => setMessage(m => m === text ? null : m), 2500);
  };
  const copyRegion = () => {
    const region = controller.visibleRegion();
    if (!region || !size_a) return;
    copied(() => navigator.clipboard.writeText(regionAsYaml(region, size_a)), 'region in view').then(notify);
  };

  // Clicking the image shown alone, or their difference, shows the next one
  useLayoutEffect(() => {
    controller.setOnClick(() => {
      if (single) flip();
    });
  });

  // Display adjustments: an SVG filter on the images
  const filter_id = `qiv-filter-${useId().replace(/:/g, '')}`;
  const primitives = filterPrimitives(adjustments);
  const filter = primitives.length > 0 ? `url(#${filter_id})` : undefined;

  const toggleFullscreen = () => {
    if (document.fullscreenElement === root.current) document.exitFullscreen?.();
    else root.current?.requestFullscreen?.().catch(error => notify(`Can't go full screen: ${error.message}`));
  };
  // The values on the pixels: p hides them, and shows those shown before
  const setValues = value => {
    if (value !== 'off') last_values.current = value;
    setValuesSetting(value);
  };
  const toggleValues = () => setValues(values_setting === 'off' ? last_values.current : 'off');

  // Keyboard shortcuts, for the viewer under the mouse, else the one that has the focus
  const on_key = useRef(null);
  useLayoutEffect(() => {
    on_key.current = event => {
      switch (event.key) {
        case '1': case '2': case '3': case '4':
          if (!comparing) return false;
          pickMode(MODES[Number(event.key) - 1].value);
          return true;
        case 't':
          if (!comparing) return false;
          flip();
          return true;
        case 'h':
          if (!comparing) return false;
          nextBlindStep();
          return true;
        case 'p':
          toggleValues();
          return true;
        case 'f':
          if (!can_fullscreen) return false;
          toggleFullscreen();
          return true;
        case '+': case '=':
          controller.zoomBy(ZOOM_STEP);
          return true;
        case '-':
          controller.zoomBy(1 / ZOOM_STEP);
          return true;
        case '0':
          controller.fit();
          return true;
        case '[': case ']':
          if (!active_set?.regions?.length) return false;
          stepRegion(event.key === '[' ? -1 : 1);
          return true;
        default:
          return false;
      }
    };
  });
  useEffect(() => {
    const onKeyDown = event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
      if (keyboardViewerOf(event) !== root.current || !on_key.current(event)) return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    const element = root.current;
    viewers.add(element);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      viewers.delete(element);
      if (hovered_viewer === element) hovered_viewer = null;
      if (last_viewer === element) last_viewer = null;
    };
  }, []);

  // The wipe's divider
  const wiping = useRef(false);
  const onWipeMove = event => {
    if (!wiping.current) return;
    const rect = stage.current.getBoundingClientRect();
    setWipe(clamp((event.clientX - rect.left) / pane_width, 0, 1));
  };

  // Where each image shows
  const paneStyle = name => {
    const style = { width: pane_width, height: pane_height, left: 0 };
    if (name === 'b' && !comparing) return { ...style, visibility: 'hidden', pointerEvents: 'none' };
    if (side_by_side) return { ...style, left: name === first ? 0 : pane_width + GAP };
    if (diff_between) return { ...style, left: name === first ? 0 : (stacked ? 1 : 2) * (pane_width + GAP) };
    if (mode === 'wipe') return name === second ? { ...style, zIndex: 2, clipPath: `inset(0 0 0 ${wipe * pane_width}px)` } : { ...style, zIndex: 1 };
    if (mode === 'single') return name === first ? { ...style, zIndex: 2 } : { ...style, visibility: 'hidden' };
    // difference: the image receives the gestures, under the difference
    if (mode === 'difference') return name === 'a' ? { ...style, zIndex: 1 } : { ...style, visibility: 'hidden' };
    return style;
  };

  const resolution = name => snapshot[name].width ? <span className="qiv-label-detail">{snapshot[name].width}×{snapshot[name].height}</span> : null;
  const label = (name, position) => !comparing ? null : <button
    key={`label-${name}-${position}`}
    type="button"
    className={`qiv-label qiv-label-${position} ${hidden ? 'qiv-neutral' : name === 'a' ? 'qiv-primary' : 'qiv-warning'}`}
    title={`${flip_title} (t). ${hidden ? 'Blind test: which is new? Reveal with h' : 'Blind test: h'}`}
    onClick={flip}
    onPointerDown={event => event.stopPropagation()}
  >
    {names[name]}{resolution(name)}
  </button>;

  const pane_error = name => {
    const error = snapshot[name].error;
    if (!error) return null;
    return <div className="qiv-message qiv-pane-message">
      <strong>Can't show {comparing ? `the ${names[name]} image` : 'the image'}</strong>
      <span>{error.message}</span>
      {error.url && <a href={error.url} target="_blank" rel="noopener noreferrer">See why</a>}
    </div>;
  };

  // the pane whose values say what the values on the pixels are
  const values_pane = mode === 'difference' ? 'diff' : side_by_side ? 'a' : first;
  const pixelValues = pane => <PixelValues
    controller={controller}
    pane={pane}
    order={[first, second]}
    source={visible ? pixel_source : 'off'}
    width={pane_width}
    height={pane_height}
    tiles={tiles}
    images={images}
    base={base}
    diffCanvas={pane === 'diff' ? diff_canvas : undefined}
    onDrawn={pane === values_pane ? setValuesDrawn : undefined}
  />;

  // Whether a pane's image shows
  const shown = name => !comparing ? name === 'a'
    : mode === 'single' ? name === first
    : mode === 'difference' ? diff_between
    : true;
  const pane = name => <div
    key={name}
    className="qiv-pane"
    style={paneStyle(name)}
    onPointerMove={event => controller.hover(name, event.clientX, event.clientY)}
    onPointerLeave={() => controller.unhover()}
  >
    <div className="qiv-osd" ref={element => { if (element) controller.attach(name, element); }} style={{ filter }} />
    <HighlightLayer controller={controller} pane={name} highlight={highlight} active={visible && shown(name)} width={pane_width} height={pane_height} />
    {pixelValues(name)}
    <Crosshair controller={controller} pane={name} />
    {apart && label(name, 'left')}
    {pane_error(name)}
  </div>;

  const loading = snapshot.a.status === 'loading' || (comparing && snapshot.b.status === 'loading')
    || (snapshot.a.status === 'ready' && !snapshot.a.fullyLoaded) || (comparing && snapshot.b.status === 'ready' && !snapshot.b.fullyLoaded);
  const tile_errors = snapshot.a.tileErrors + (comparing ? snapshot.b.tileErrors : 0);
  const different_aspect = comparing && size_a && size_b && Math.abs(size_a.height / size_a.width - size_b.height / size_b.width) > 1e-3;

  const can_copy = name => snapshot[name].status === 'ready';
  const copy = (source, what, adjusted = true) => copied(() => copyCanvas(source, adjusted ? filter : undefined), what).then(notify);
  const base_name = (images.a?.href ?? images.a?.url ?? images.a?.iiif ?? 'image').split('/').pop().split(/[?#]/)[0].replace(/(%2F)/gi, '_').replace(/\.[^.]*$/, '');
  const export_menu = ({ close }) => <div className="qiv-menu" role="menu">
    <MenuItem icon="duplicate" text={`Copy the ${names.a} image`} disabled={!can_copy('a')} onClick={() => { copy(controller.canvas('a'), `${names.a} image`); close(); }} />
    {comparing && <MenuItem icon="duplicate" text={`Copy the ${names.b} image`} disabled={!can_copy('b')} onClick={() => { copy(controller.canvas('b'), `${names.b} image`); close(); }} />}
    {mode === 'difference' && <MenuItem icon="duplicate" text="Copy the difference" onClick={() => { copy(diff_canvas.current, 'difference', false); close(); }} />}
    <MenuDivider />
    <MenuItem icon="download" text={`Save the ${names.a} view (PNG)`} disabled={!can_copy('a')} onClick={() => { saveCanvas(controller.canvas('a'), filter, `${base_name}.${names.a}.png`); close(); }} />
    {comparing && <MenuItem icon="download" text={`Save the ${names.b} view (PNG)`} disabled={!can_copy('b')} onClick={() => { saveCanvas(controller.canvas('b'), filter, `${base_name}.${names.b}.png`); close(); }} />}
    {mode === 'difference' && <MenuItem icon="download" text="Save the difference (PNG)" onClick={() => { saveCanvas(diff_canvas.current, undefined, `${base_name}.difference.png`); close(); }} />}
    {/* their URLs would tell which is which during a blind test */}
    {!hidden && (images.a?.href || images.b?.href) && <MenuDivider />}
    {!hidden && images.a?.href && <MenuItem icon="media" text={`Open the ${names.a} file`} href={images.a.href} onClick={close} />}
    {!hidden && comparing && images.b?.href && <MenuItem icon="media" text={`Open the ${names.b} file`} href={images.b.href} onClick={close} />}
    {changedAdjustments(adjustments).length > 0 && <div className="qiv-hint">Copied with the adjustments: {describeAdjustments(adjustments).join(', ')}</div>}
  </div>;

  const zoom = useZoom(controller);
  const adjusted = changedAdjustments(adjustments).length > 0;

  return <div
    ref={root}
    className={`qiv ${fullscreen ? 'qiv-fullscreen' : ''} ${className}`}
    data-theme={theme}
    style={style}
    onPointerEnter={() => { hovered_viewer = last_viewer = root.current; }}
    onPointerLeave={() => { if (hovered_viewer === root.current) hovered_viewer = null; }}
    onFocus={() => { last_viewer = root.current; }}
  >
    <svg className="qiv-filters" aria-hidden="true" width="0" height="0">
      <filter id={filter_id} colorInterpolationFilters="sRGB">
        {primitives.map((primitive, i) => <FilterPrimitive key={i} primitive={primitive} />)}
      </filter>
    </svg>
    <div className="qiv-header" ref={header}>
    <div className="qiv-toolbar">
      {comparing && <Segmented label="Compare" options={MODES} value={mode} onChange={pickMode} />}
      {mode === 'difference' && <Button
        icon="three-columns"
        title={diff_between ? 'Show the difference alone (4)' : `Show the images on each side of the difference: ${names[first]} | difference | ${names[second]} (4)`}
        active={diff_between}
        aria-pressed={diff_between}
        onClick={toggleDiffLayout}
      />}
      {comparing && <Button icon="exchange" title={`${flip_title} (t)`} onClick={flip} active={swapped && !hidden} aria-pressed={swapped && !hidden} />}
      {comparing && <Button
        icon={!blind ? 'eye-off' : blind.revealed ? 'tick' : 'eye-open'}
        text={!blind ? 'Blind test' : blind.revealed ? 'Done' : 'Reveal'}
        title={!blind ? 'Blind test: the images in a random order, called A and B (h)'
          : blind.revealed ? 'End the blind test: new and reference again, new first (h)'
          : 'Blind test: reveal which image is which (h)'}
        className={blind ? 'qiv-intent' : ''}
        active={!!blind}
        aria-pressed={!!blind}
        onClick={nextBlindStep}
      />}
      {mode === 'difference' && <DiffSettings diff={diff} onChange={value => setDiff({ ...value, layout: diff_layout })} />}
      {notice}
      <span className="qiv-spacer" />
      <span className="qiv-tools">
      {message && <output className="qiv-toast">{message}</output>}
      {loading && <Spinner label="Loading the images" />}
      {tile_errors > 0 && <span className="qiv-warning-text" title={controller.images.a?.tileError ?? controller.images.b?.tileError}>
        <Icon icon="warning-sign" size={12} /> {tile_errors} tile{tile_errors > 1 ? 's' : ''} failed
      </span>}
      {different_aspect && <span className="qiv-warning-text" title="The images are compared at the same width: their bottoms don't match.">
        <Icon icon="warning-sign" size={12} /> different aspect ratios
      </span>}
      {toolbarExtra}
      <Popover align="end" button={props => <Button
        {...props}
        icon="detection"
        text={active_set ? active_set.label : undefined}
        label="Regions of interest"
        title="Regions of interest"
        className={active_set ? 'qiv-intent' : ''}
      />}>
        {({ close }) => <RegionsMenu sets={regionSets} selected={active_set?.id ?? null} actions={regionActions} onSelect={selectSet} onCopy={copyRegion} close={close} />}
      </Popover>
      <Popover align="end" button={props => <Button {...props} icon="flash" title="Adjust the display: brightness, contrast, gamma, channels…" className={adjusted ? 'qiv-intent qiv-dot' : ''} />}>
        <AdjustmentsPanel adjustments={adjustments} onChange={setAdjustments} />
      </Popover>
      <Popover align="end" button={props => <Button
        {...props}
        icon="numerical"
        label="Pixel values"
        title={`Values written on the pixels when zoomed in: ${pixel_source === 'image' ? "the image's own" : pixel_source === 'display' ? 'the displayed ones' : 'off'} (p)`}
        className={pixel_source !== 'off' ? 'qiv-intent' : ''}
      />}>
        <ValuesPanel source={pixel_source} available={!!getPixels} unavailable={imageValuesUnavailable} onChange={setValues} />
      </Popover>
      <Button icon="timeline-area-chart" title="Histogram of the view: drag on it to highlight a range of values" active={show_histogram} aria-pressed={show_histogram} onClick={() => setShowHistogram(!show_histogram)} />
      <span className="qiv-group">
        <Button icon="zoom-out" title="Zoom out (−)" onClick={() => controller.zoomBy(1 / ZOOM_STEP)} />
        <Button className="qiv-zoom" text={zoom ? `${zoom < 0.1 ? (100 * zoom).toFixed(1) : Math.round(100 * zoom)}%` : '–'} title="Fit (0). Scroll or pinch to zoom, drag to pan. 100%: one image pixel per screen pixel" onClick={() => controller.fit()} />
        <Button icon="zoom-in" title="Zoom in (+)" onClick={() => controller.zoomBy(ZOOM_STEP)} />
        <Button text="1:1" title="Actual pixels: one image pixel per screen pixel" onClick={() => controller.actualSize()} />
      </span>
      <Popover align="end" button={props => <Button {...props} icon="duplicate" title="Copy or save the images" />}>
        {export_menu}
      </Popover>
      <Popover align="end" button={props => <Button {...props} icon="key-command" title="Keyboard shortcuts" />}>
        <Shortcuts />
      </Popover>
      {can_fullscreen && <Button
        icon={fullscreen ? 'minimize' : 'fullscreen'}
        title={fullscreen ? 'Exit full screen (f or Esc)' : 'Full screen (f)'}
        onClick={toggleFullscreen}
      />}
      </span>
    </div>
    {active_set && <RegionsStrip
      set={active_set}
      index={index}
      image={hidden ? images[first] : images.a}
      size={size_a}
      onSelect={selectRegion}
      onRetry={() => active_set.load?.()}
    />}
    <Readout
      controller={controller}
      tiles={tiles}
      images={images}
      comparing={comparing}
      names={names}
      order={[first, second]}
      neutral={hidden}
      diff={diff}
      base={base}
      onToggleBase={() => setBase(b => b === 10 ? 16 : 10)}
      sizes={{ a: size_a, b: size_b }}
      unavailable={getPixels ? null : imageValuesUnavailable}
    />
    </div>
    <div
      ref={stage}
      className={`qiv-stage qiv-mode-${mode}`}
      style={{ width: stage_width, height: stage_height }}
    >
      {pane('a')}
      {pane('b')}
      {mode === 'difference' && <div
        ref={diff_pane}
        className={`qiv-pane qiv-diff-pane ${diff_between ? 'qiv-diff-between' : ''}`}
        style={{ width: pane_width, height: pane_height, ...diff_position, zIndex: 3 }}
        onPointerMove={diff_between ? event => controller.hover('diff', event.clientX, event.clientY, event.currentTarget) : undefined}
        onPointerLeave={diff_between ? () => controller.unhover() : undefined}
      >
        <DiffLayer controller={controller} order={[first, second]} diff={diff} active={visible} width={pane_width} height={pane_height} canvasRef={diff_canvas} onError={setDiffError} />
        {pixelValues('diff')}
        <Crosshair controller={controller} pane="diff" />
        {diff_between && <>
          <span className="qiv-label qiv-label-left qiv-label-diff" title={`${names[first]} − ${names[second]}`}>difference</span>
          <div className="qiv-stage-notes"><DiffLegend diff={diff} names={[names[first], names[second]]} /></div>
        </>}
        {diff_error && <div className="qiv-message qiv-pane-message">{diff_error}</div>}
      </div>}
      <div className="qiv-stage-notes">
        {mode === 'difference' && !diff_between && <DiffLegend diff={diff} names={[names[first], names[second]]} />}
        <ValuesBadge drawn={pixel_source !== 'off' ? values_drawn : null} />
      </div>
      {mode === 'wipe' && <>
        {label(first, 'left')}
        {label(second, 'right')}
        <div
          className="qiv-wipe"
          style={{ left: wipe * pane_width }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Wipe"
          aria-valuenow={Math.round(100 * wipe)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          onKeyDown={event => {
            const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key];
            if (!step) return;
            event.preventDefault();
            setWipe(w => clamp(w + step, 0, 1));
          }}
          onPointerDown={event => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            wiping.current = true;
          }}
          onPointerMove={onWipeMove}
          onPointerUp={() => { wiping.current = false; }}
          onPointerCancel={() => { wiping.current = false; }}
        >
          <div className="qiv-wipe-handle"><Icon icon="arrows-horizontal" size={14} /></div>
        </div>
      </>}
      {mode === 'single' && label(first, 'left')}
      <Minimap controller={controller} image={hidden ? images[first] : images.a} size={size_a} />
    </div>
    {show_histogram && <Histogram
      controller={controller}
      comparing={comparing}
      names={names}
      channels={histogram_channels}
      onChannelsChange={setHistogramChannels}
      range={highlight_range}
      onRangeChange={setHighlightRange}
    />}
  </div>;
};

// Screen pixels per image pixel, updated as users zoom
const useZoom = controller => {
  const [zoom, setZoom] = useState(null);
  useEffect(() => controller.onDraw(() => {
    const value = controller.imageZoom();
    setZoom(previous => previous !== null && value !== null && Math.abs(previous - value) / value < 0.005 ? previous : value);
  }), [controller]);
  return zoom;
};

export default ImageViewer;
