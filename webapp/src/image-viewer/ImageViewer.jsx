// Compares an image with a reference: side by side, with a wipe, one at a time (single), or as their difference.
// With more images (`more`), each shows in a tile, compared with the anchor: see tiles.jsx.
// See README.md for the props.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Comparison } from './comparison';
import { ComparePanel, useDistances } from './comparePanel';
import { formatDistance, gridLayout, hasSource, nextShown, tileColor, tileName } from './grid';
import { Tile } from './tiles';
import { candidateLabel, CompareWithMenu } from './compareWith';
import { describeAdjustments, filterPrimitives, normalizeAdjustments, changedAdjustments } from './adjustments';
import { DEFAULT_DIFF, normalizeDiff } from './metrics';
import { regionAsYaml } from './regions';
import { DEFAULT_MODE, MODES } from './modes';
import { imageColors, imageKey, normalizeImage } from './sources';
import { PixelTiles } from './pixelTiles';
import { ALL_CHANNELS } from './histogram';
import { ANALYSES, normalizeAnalysis } from './analysis';
import { AnalysisPanel } from './analysisPanel';
import { normalizeSensorSetting } from './imageAnalysis';
import { Crosshair, DiffLayer, GuideLine, HighlightLayer, ImageHighlightLayer, Minimap, PixelValues, RegionOutlines } from './overlays';
import { AdjustmentsPanel, DiffLegend, DiffSettings, Readout, RegionsMenu, RegionsStrip, Shortcuts, ValuesBadge, ValuesPanel } from './panels';
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

const ANALYSIS_ICONS = Object.fromEntries(ANALYSES.map(a => [a.value, a.icon]));
// What the modes do with more than two images
const N_WAY_TITLES = {
  'side-by-side': 'Every image in its tile (1)',
  wipe: 'Wipe: the anchor against each image, drag a divider (2)',
  single: 'Single: one image at a time, in place. t or a click on the image shows the next, Shift+1 to 9 the image of that number (3)',
  difference: 'Difference: the anchor, and its difference with each image (4)',
};
const N_WAY_MODES = MODES.map(m => ({ ...m, label: m.value === 'side-by-side' ? 'Grid' : m.label, title: N_WAY_TITLES[m.value] }));
// Without `analysis`, the view of the analysis panel users picked last, for the next viewers of the page
let last_analysis;

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
  more = [],
  anchor: anchor_prop,
  defaultAnchor = 0,
  onAnchorChange,
  shown: shown_prop,
  defaultShown = 0,
  onShownChange,
  details: details_prop,
  defaultDetails = true,
  onDetailsChange,
  compact = false,
  compareWith = [],
  compared: compared_prop,
  defaultCompared = null,
  onComparedChange,
  compareScopes = [],
  compareScope: compare_scope_prop,
  onCompareScopeChange,
  comparedNote,
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
  analysis: analysis_prop,
  defaultAnalysis,
  defaultShowAnalysis = false,
  onAnalysisChange,
  analysisValues: analysis_values_prop,
  defaultAnalysisValues = 'display',
  onAnalysisValuesChange,
  sensor: sensor_prop,
  defaultSensor,
  onSensorChange,
  sensorRemembered,
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
  // Told when users use a feature: 'pixel_pin', 'histogram' or 'analysis' (the panel opens). Apps count usage with it.
  onUse,
  maxHeight = DEFAULT_MAX_HEIGHT,
  theme,
  notice,
  toolbarExtra,
  className = '',
  style,
}) => {
  // What the image is compared with: the reference, or one of the app's other images, e.g. another file of the same
  // run (compareWith.jsx). Controlled with onComparedChange, e.g. the same for several viewers, or not.
  const [compared_id, setCompared] = useControllable(compared_prop, defaultCompared, onComparedChange);
  const alternative = compared_id != null ? compareWith.find(candidate => candidate.id === compared_id) ?? null : null;
  // e.g. a file the other viewers' runs have, but not this one's: we show the reference and say it
  const missing = compared_id != null && !alternative ? compared_id : null;
  const reference_name = normalizeImage(reference)?.label ?? 'reference';
  // "the reference", or its own name, e.g. "ISP v1": as everywhere else
  const the_reference = reference_name === 'reference' ? 'the reference' : reference_name;
  // All the images compared, in order: the image, its reference, then `more`. With more than two, one is the anchor:
  // the others are compared with it. The image users picked to compare with instead takes the reference's place, or
  // with more than two images the anchor's: it's what the others are compared with.
  const [anchor_setting, setAnchor] = useControllable(anchor_prop, defaultAnchor, onAnchorChange);
  const sources = [normalizeImage(image), normalizeImage(reference), ...more.map(normalizeImage)];
  const replaced = !alternative ? -1
    : sources.filter(Boolean).length > 2 && Number.isInteger(anchor_setting) && anchor_setting > 0 && sources[anchor_setting] ? anchor_setting : 1;
  const given = sources.map((entry, index) => index === replaced ? { ...normalizeImage(alternative.image), label: candidateLabel(alternative) } : entry).filter(Boolean);
  // more than two: each has its name and its color, also when two of them show alone
  const everything = given.length > 2 ? given.map((entry, index) => ({ ...entry, label: tileName(entry, index), ...tileColor(entry, index) })) : given;
  // Users can look at two of them alone, e.g. from how far apart they are (pair: the images, by their key: they stay
  // the same two when the app reorders the images)
  const [pair, setPair] = useState(null);
  const pair_indexes = pair && everything.length > 2 ? pair.map(key => everything.findIndex(entry => hasSource(entry) && imageKey(entry) === key)) : null;
  const alone = pair_indexes && pair_indexes.every(i => i >= 0) && pair_indexes[0] !== pair_indexes[1] ? pair_indexes : null;
  const list = alone ? alone.map(i => everything[i]) : everything;
  // More than two: each image in its tile, compared with the anchor, by default the first. The viewer's own two panes
  // show the anchor (a) and keep the first of the others (b, hidden: it has its tile like the others), for what
  // compares two images: the values' difference, the analysis.
  const n_way = list.length > 2;
  const anchor_index = n_way && !alone && Number.isInteger(anchor_setting) && hasSource(list[anchor_setting]) ? anchor_setting : 0;
  const others = list.map((other, index) => ({ image: other, index })).filter(other => other.index !== anchor_index);
  const second_index = others.find(other => hasSource(other.image))?.index ?? null;
  const images = {
    a: list[anchor_index] ?? null,
    b: second_index !== null ? list[second_index] : null,
  };
  const comparing = !!images.b;
  const labels = { a: images.a?.label ?? 'new', b: images.b?.label ?? 'reference' };

  const [controller] = useState(() => new Comparison({ syncKey }));
  useEffect(() => () => controller.dispose(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const [stored_mode, setMode] = useControllable(mode_prop, defaultMode, onModeChange);
  const mode = comparing || n_way ? (MODES.some(m => m.value === stored_mode) ? stored_mode : 'side-by-side') : 'no-reference';
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
  const [swapped_setting, setSwapped] = useControllable(swapped_prop, defaultSwapped, onSwappedChange);
  // with more than two images, they keep their order
  const swapped = !n_way && swapped_setting;
  // A blind test: the images are called A and B ({ a: 'A' | 'B', revealed }), in a random order. Controlled with
  // blindTest and onBlindTestChange('start' | 'reveal' | 'end'), e.g. for all the viewers of a page, or not.
  const [own_blind, setOwnBlind] = useState(null);
  const blind = n_way ? null : blind_prop !== undefined ? blind_prop : own_blind;
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
  // The analysis panel, under the images: its view ('histogram', 'profiles' or 'stats') is remembered, by the app or for
  // the page, and whether it shows is for each viewer
  const [show_analysis, setShowAnalysis] = useState(!!defaultShowAnalysis);
  const [analysis_setting, setAnalysisSetting] = useControllable(analysis_prop, defaultAnalysis ?? last_analysis, onAnalysisChange);
  const analysis = normalizeAnalysis(analysis_setting);
  const setAnalysis = value => {
    last_analysis = value;
    setAnalysisSetting(value);
  };
  const toggleAnalysis = () => {
    if (!show_analysis) onUse?.(analysis === 'histogram' ? 'histogram' : 'analysis');
    setShowAnalysis(!show_analysis);
  };
  // The channels the analysis shows, and the range of values the histogram highlights on the images (with the channels shown)
  const [histogram_channels, setHistogramChannels] = useState(ALL_CHANNELS);
  const [highlight_range, setHighlightRange] = useState(null);
  // What it measures: the displayed values, or the image's own ('image', with getPixels), per channel of its sensor,
  // e.g. R, Gr, Gb, B. What users say of the sensor (its CFA, black level...): controlled to remember it, e.g. per project.
  const [analysis_values, setAnalysisValues] = useControllable(analysis_values_prop, defaultAnalysisValues, onAnalysisValuesChange);
  const analysis_image_values = analysis_values === 'image' && !!getPixels;
  const highlight = show_analysis && analysis === 'histogram' && !analysis_image_values && highlight_range ? { ...highlight_range, channels: histogram_channels } : null;
  // On the image's own values: the range picked on their histogram, and the pixels in it, by image (see highlightMask)
  const [image_range, setImageRange] = useState(null);
  const [image_masks, setImageMasks] = useState(null);
  const [sensor_setting, setSensorSetting] = useControllable(sensor_prop, defaultSensor, onSensorChange);
  const sensor = normalizeSensorSetting(sensor_setting);
  // The row or column hovered on its profile, shown on the images: { axis: 'x' | 'y', value }
  const [guide, setGuide] = useState(null);
  const [diff_error, setDiffError] = useState(null);
  const [message, setMessage] = useState(null);
  // compact: the toolbar shows when users ask for it
  const [chrome, setChrome] = useState(false);
  // The values of every image under the pointer, and how far apart the images are: users can hide them. With two
  // images, it hides the values under the pointer.
  const [details_setting, setDetails] = useControllable(details_prop, defaultDetails, onDetailsChange);
  const show_details = details_setting !== false;
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
  const diff_between = !n_way && mode === 'difference' && diff_layout === 'between';
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
  // In full screen, the analysis panel shows under the images, without scrolling (it scrolls when it's taller than half
  // the screen)
  const analysis_panel = useRef(null);
  const analysis_height = useHeight(analysis_panel, fullscreen && show_analysis);
  const max_height = Math.max(120, fullscreen
    ? window_height - header_height - (show_analysis ? analysis_height : 0) - 24
    : typeof maxHeight === 'function' ? maxHeight(window_height) : maxHeight);
  const fit = (columns, rows) => Math.floor(Math.max(0, Math.min(
    (available - (columns - 1) * GAP) / columns,
    (max_height - (rows - 1) * GAP) / rows / aspect,
  )));
  // The difference between the images: in a row, or in full screen, under them when the images are larger so
  const stacked = diff_between && fullscreen && fit(2, 2) > fit(3, 1);
  // More than two images: a grid of tiles, the same in every mode but single, so that switching modes moves nothing.
  // compact: in one row, e.g. for a contact sheet where the rows of the page are runs
  // the values of every image show above them: the images take what's left, so that they stay in view
  const details_height = !fullscreen && show_details && !(compact && !chrome) ? 20 * (list.length + 1) + 32 : 0;
  const grid = n_way ? gridLayout({ count: mode === 'single' ? 1 : list.length, available, maxHeight: Math.max(200, max_height - details_height), aspect, gap: GAP, columns: compact && !fullscreen ? list.length : null }) : null;
  const slot = index => grid.slot(mode === 'single' ? 0 : index);
  const pane_width = grid ? grid.width : stacked ? fit(2, 2) : fit(columns, 1);
  const pane_height = grid ? grid.height : Math.floor(pane_width * aspect);
  const stage_width = grid ? grid.stageWidth : stacked ? 2 * pane_width + GAP : columns * pane_width + (columns - 1) * GAP;
  const stage_height = grid ? grid.stageHeight : stacked ? 2 * pane_height + GAP : pane_height;
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
  // The tiles follow the anchor through its sync group: without a key from the app, they get their own
  const own_key = `qiv-${useId()}`;
  const sync_key = syncKey ?? (n_way ? own_key : null);
  useEffect(() => controller.setSyncKey(sync_key), [controller, sync_key]);

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
  // The toggle (t, the swap button, a click on the image shown alone) never changes the mode: in single mode it shows
  // the other image, else the images swap sides, or the difference its order. With swapped shared by the viewers of a
  // page, they all stay in step.
  const single = mode === 'single';
  const diff_alone = !n_way && mode === 'difference' && diff_layout === 'alone';
  // More than two images: the one that shows alone in single mode, t shows the next one
  const [shown_setting, setShown] = useControllable(shown_prop, defaultShown, onShownChange);
  const shown_index = n_way && Number.isInteger(shown_setting) && hasSource(list[shown_setting]) ? shown_setting : anchor_index;
  const stepShown = step => setShown(nextShown(list, shown_index, step));
  const flip = n_way ? () => { if (single) stepShown(1); } : swap;
  const flip_title = n_way ? 'Show the next image'
    : single ? `Show the ${names[second]} image`
    : diff_alone ? `Swap the difference: ${names[second]} − ${names[first]}`
    : `Swap the sides: ${names[second]} | ${names[first]}`;
  // Picking the mode shown again: Single flips the images, Difference shows or hides the images on its sides
  const pickMode = value => {
    if (value === mode && value === 'single') flip();
    else if (value === mode && value === 'difference' && !n_way) toggleDiffLayout();
    else setMode(value);
  };

  // Gestures on the difference between the images move them
  const diff_pane = useRef(null);
  useEffect(() => {
    if (!diff_between || !diff_pane.current) return;
    return controller.trackGestures(diff_pane.current);
  }, [controller, diff_between]);

  // Regions of interest: the set shown (controlled with onRegionSetChange, e.g. the same for several viewers, or not),
  // and the region of the set. Sets with `overview` (e.g. annotations) first show the whole image with all their
  // regions outlined: no region is active (index null) until users pick one.
  const [selected_set, setSelectedSet] = useControllable(region_set_prop, defaultRegionSet, onRegionSetChange);
  const active_set = selected_set ? regionSets.find(set => set.id === selected_set) ?? null : null;
  const first_index = set => set?.overview ? null : 0;
  const [region_index, setRegionIndex] = useState({ set: selected_set, index: first_index(active_set) });
  const index = region_index.set === selected_set ? region_index.index : first_index(active_set);
  const active_region = index !== null ? active_set?.regions?.[index] ?? null : null;
  // the regions are outlined on the images (o)
  const [outlines, setOutlines] = useState(true);
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
    const set = regionSets.find(s => s.id === id);
    setSelectedSet(id);
    setRegionIndex({ set: id, index: first_index(set) });
    if (set?.overview) return controller.fit();
    const first_region = set?.regions?.[0];
    if (first_region) controller.fitRegion(first_region);
  };
  // null: all the regions, on the whole image
  const selectRegion = next => {
    setRegionIndex({ set: selected_set, index: next });
    if (next === null) return controller.fit();
    const region = active_set?.regions?.[next];
    if (region) controller.fitRegion(region);
  };
  const stepRegion = step => {
    const count = active_set?.regions?.length ?? 0;
    if (count === 0) return;
    selectRegion(index === null ? (step > 0 ? 0 : count - 1) : (index + step + count) % count);
  };

  const notify = text => {
    setMessage(text);
    setTimeout(() => setMessage(m => m === text ? null : m), 2500);
  };
  // Picking what to compare with. c goes back to the reference, then to the image picked last.
  const [picker_open, setPickerOpen] = useState(false);
  // Where a pick applies, e.g. every run of the page or this one: the app's options ({ value, label, title?, phrase? })
  const [compare_scope, setCompareScope] = useControllable(compare_scope_prop, compareScopes[0]?.value, onCompareScopeChange);
  const scope_phrase = compareScopes.find(option => option.value === compare_scope)?.phrase;
  const last_other = useRef(null);
  const alternative_id = alternative?.id ?? null;
  useEffect(() => {
    if (alternative_id !== null) last_other.current = alternative_id;
  }, [alternative_id]);
  const pickCompared = id => {
    if (id === (compared_id ?? null)) return;
    if (id !== null) last_other.current = id;
    setCompared(id);
    const candidate = id !== null ? compareWith.find(c => c.id === id) : null;
    const what = candidate ? `Comparing with ${candidateLabel(candidate)}` : reference ? `Comparing with ${the_reference} again` : 'The image alone again';
    notify(scope_phrase ? `${what} ${scope_phrase}` : what);
  };
  const toggleCompared = () => {
    if (compared_id != null) return pickCompared(null);
    if (compareWith.some(c => c.id === last_other.current)) return pickCompared(last_other.current);
    setPickerOpen(true);
  };

  const copyRegion = () => {
    const region = controller.visibleRegion();
    if (!region || !size_a) return;
    copied(() => navigator.clipboard.writeText(regionAsYaml(region, size_a)), 'region in view').then(notify);
  };

  // Clicking a pixel pins it: its values stay while users move the mouse away, e.g. to select them. Clicking the image
  // shown alone shows the other: there, Shift+click pins.
  useLayoutEffect(() => {
    controller.setOnClick((name, event, element) => {
      if (single && !event?.shiftKey) return flip();
      if (event) {
        controller.pin(name, event.clientX, event.clientY, element);
        onUse?.('pixel_pin');
      }
    });
  });

  // ...and on the tiles of the other images
  const onTileClick = (event, tile_controller, element) => {
    if (single && !event?.shiftKey) return flip();
    if (event) {
      // the anchor's viewer keeps the pin, like when users click the anchor: Esc and leaving the viewer undo it
      const point = tile_controller.pointAt('a', event.clientX, event.clientY, element);
      const pinned = controller.getPointer()?.pinned ? controller.getPointer().point : null;
      const same = pinned && point && tile_controller.imagePixel('a', pinned)?.x === tile_controller.imagePixel('a', point)?.x
        && tile_controller.imagePixel('a', pinned)?.y === tile_controller.imagePixel('a', point)?.y;
      if (same || !point || !tile_controller.imagePixel('a', point)) controller.unpin();
      else controller.pinPoint(point);
      onUse?.('pixel_pin');
    }
  };
  // The viewers of the images, by their index: the anchor's is ours, the others' are their tiles'
  const [tile_controllers, setTileControllers] = useState({});
  const registerTile = (index, value) => setTileControllers(previous => (previous[index] ?? null) === value ? previous : { ...previous, [index]: value });
  const controllers = list.map((entry, index) => index === anchor_index ? controller : n_way && hasSource(entry) ? tile_controllers[index] ?? null : null);
  const [wipe_all, setWipeAll] = useState(0.5);
  const pickAnchor = index => {
    setAnchor(index);
    notify(`The other images are compared with ${tileName(list[index], index)}`);
  };

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
      // Shift+1 to 9: that image alone
      // (not where digits are typed with Shift, e.g. French keyboards: there the keys 1 to 4 pick the mode)
      const digit = n_way && event.shiftKey && !/^[1-9]$/.test(event.key) ? /^Digit([1-9])$/.exec(event.code ?? '') : null;
      if (digit) {
        const index = Number(digit[1]) - 1;
        if (!hasSource(list[index])) return false;
        setShown(index);
        if (!single) setMode('single');
        return true;
      }
      switch (event.key) {
        case '1': case '2': case '3': case '4':
          if (!comparing && !n_way) return false;
          pickMode(MODES[Number(event.key) - 1].value);
          return true;
        case 't':
          if (!comparing && !n_way) return false;
          flip();
          return true;
        case 'T':
          if (!n_way || !single) return false;
          stepShown(-1);
          return true;
        case 'c':
          if (compareWith.length === 0 || hidden) return false;
          toggleCompared();
          return true;
        case 'h':
          if (!comparing || n_way) return false;
          nextBlindStep();
          return true;
        case 'p':
          toggleValues();
          return true;
        case 'Escape':
          if (!controller.getPointer()?.pinned) return false;
          controller.unpin();
          return true;
        case 'a':
          toggleAnalysis();
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
        case 'o':
          if (!active_set?.regions?.length) return false;
          setOutlines(!outlines);
          notify(outlines ? 'Outlines hidden (o)' : 'Regions outlined (o)');
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
    if (n_way) {
      if (name === 'b') return { ...style, visibility: 'hidden', pointerEvents: 'none' };
      return single && shown_index !== anchor_index ? { ...style, ...slot(anchor_index), visibility: 'hidden' } : { ...style, ...slot(anchor_index), zIndex: 2 };
    }
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
    {name === 'b' && alternative && !hidden && <Icon icon="document" size={12} className="qiv-label-icon" />}
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

  const regionOutlines = name => outlines && active_set?.regions?.length > 0 && <RegionOutlines
    controller={controller}
    pane={name}
    regions={active_set.regions}
    active={index}
    size={size_a}
    paneSize={name === 'b' ? size_b : size_a}
    onSelect={selectRegion}
  />;

  // Whether a pane's image shows
  const shown = name => !comparing ? name === 'a'
    : n_way ? name === 'a' && (!single || shown_index === anchor_index)
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
    <ImageHighlightLayer controller={controller} pane={name} mask={show_analysis ? image_masks?.[name] : null} active={visible && shown(name)} width={pane_width} height={pane_height} />
    {pixelValues(name)}
    {shown(name) && regionOutlines(name)}
    <Crosshair controller={controller} pane={name} />
    {show_analysis && <GuideLine controller={controller} guide={guide} />}
    {n_way ? name === 'a' && !single && <span className="qiv-label qiv-label-left qiv-primary" title="The anchor: the other images are compared with it. Click another image's name to make it the anchor.">
      <Icon icon="anchor" size={12} className="qiv-label-icon" />{names.a}{resolution('a')}
    </span> : apart && label(name, 'left')}
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
  // How far each image is from the anchor shows on its tile; the panel compares them all
  const distances = useDistances(controllers, { enabled: n_way && visible, anchor: anchor_index, full: show_details });
  const entries = n_way ? list.map((entry, index) => ({
    index, image: entry, name: tileName(entry, index), ...tileColor(entry, index), controller: controllers[index], anchor: index === anchor_index,
  })) : [];
  const tileNote = index => {
    const value = distances?.[anchor_index]?.[index];
    if (value === null || value === undefined) return null;
    return value === 0 ? `same as ${names.a} here` : `${formatDistance(value)} from ${names.a}`;
  };
  // sets that say when they have regions, e.g. annotations: the regions button tells users
  const announced = regionSets.find(set => set.announce && (set.total ?? set.regions?.length) > 0) ?? null;
  const announced_count = announced ? announced.total ?? announced.regions.length : 0;
  const adjusted = changedAdjustments(adjustments).length > 0;

  return <div
    ref={root}
    className={`qiv ${fullscreen ? 'qiv-fullscreen' : ''} ${alternative && !hidden ? 'qiv-vs-other' : ''} ${n_way ? 'qiv-n-way' : ''} ${compact && !fullscreen ? `qiv-compact ${chrome ? 'qiv-chrome-open' : ''}` : ''} ${className}`}
    data-theme={theme}
    style={{ ...imageColors(images.a, images.b), ...style }}
    onPointerEnter={() => { hovered_viewer = last_viewer = root.current; }}
    onPointerLeave={() => {
      if (hovered_viewer === root.current) hovered_viewer = null;
      controller.leaveViewer();
    }}
    onFocus={() => { last_viewer = root.current; }}
  >
    <svg className="qiv-filters" aria-hidden="true" width="0" height="0">
      <filter id={filter_id} colorInterpolationFilters="sRGB">
        {primitives.map((primitive, i) => <FilterPrimitive key={i} primitive={primitive} />)}
      </filter>
    </svg>
    <div className="qiv-header" ref={header}>
    <div className="qiv-toolbar">
      {(comparing || n_way) && <Segmented label="Compare" options={n_way ? N_WAY_MODES : MODES} value={mode} onChange={pickMode} />}
      {alone && <Button
        icon="grid-view"
        text={`All ${everything.length} images`}
        title={`${names.a} and ${names.b} alone. Show the ${everything.length} images again`}
        className="qiv-intent"
        onClick={() => setPair(null)}
      />}
      {compareWith.length > 0 && <span className="qiv-group qiv-compare-with">
        <Popover open={picker_open} onOpenChange={setPickerOpen} button={props => <Button
          {...props}
          icon={alternative ? 'document' : 'comparison'}
          className={`qiv-compare-button ${alternative ? 'qiv-intent' : ''}`}
          disabled={hidden}
          title={hidden ? 'Pick what to compare with after the blind test'
            : `Compare with ${alternative ? candidateLabel(alternative) : reference ? the_reference : 'another image'}. Click to compare with another image (c: ${alternative ? `back to ${the_reference}` : 'the image picked last'})`}
        >
          {comparing ? <><span className="qiv-compare-vs">vs</span> <span className="qiv-compare-current">{alternative ? candidateLabel(alternative) : reference_name}</span>{comparedNote && <span className="qiv-compare-note">{comparedNote}</span>}</> : 'Compare with…'}
          <Icon icon="chevron-down" size={12} />
        </Button>}>
          {({ close }) => <CompareWithMenu
            reference={reference}
            referenceName={reference_name}
            theReference={the_reference}
            candidates={compareWith}
            selected={alternative?.id ?? null}
            onSelect={pickCompared}
            close={close}
            scopes={compareScopes}
            scope={compare_scope}
            onScopeChange={setCompareScope}
          />}
        </Popover>
        {alternative && !hidden && <Button
          icon="undo"
          title={reference ? `Back to ${the_reference} (c)` : 'Show the image alone (c)'}
          label={reference ? `Back to ${the_reference}` : 'Show the image alone'}
          onClick={() => pickCompared(null)}
        />}
      </span>}
      {mode === 'difference' && !n_way && <Button
        icon="three-columns"
        text="With the images"
        title={diff_between ? 'Show the difference alone (4)' : `Show the images on each side of the difference: ${names[first]} | difference | ${names[second]} (4)`}
        active={diff_between}
        aria-pressed={diff_between}
        onClick={toggleDiffLayout}
      />}
      {comparing && !n_way && <Button icon="exchange" text="Swap" title={`${flip_title} (t)`} label={`${flip_title} (t)`} onClick={flip} active={swapped && !hidden} aria-pressed={swapped && !hidden} />}
      {comparing && !n_way && <Button
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
      <span className="qiv-notice">{notice}</span>
      <span className="qiv-spacer" />
      <span className="qiv-tools">
      {message && <output className="qiv-toast">{message}</output>}
      {loading && <Spinner label="Loading the images" />}
      {tile_errors > 0 && <span className="qiv-warning-text" title={controller.images.a?.tileError ?? controller.images.b?.tileError}>
        <Icon icon="warning-sign" size={12} /> {tile_errors} tile{tile_errors > 1 ? 's' : ''} failed
      </span>}
      {missing && <span className="qiv-warning-text" title={`${missing} isn't available here: ${reference ? `comparing with ${the_reference}` : 'the image shows alone'}`}>
        <Icon icon="warning-sign" size={12} /> no {missing.split('/').pop()} here
      </span>}
      {different_aspect && <span className="qiv-warning-text" title="The images are compared at the same width: their bottoms don't match.">
        <Icon icon="warning-sign" size={12} /> different aspect ratios
      </span>}
      {toolbarExtra}
      <Popover align="end" button={props => <Button
        {...props}
        icon="detection"
        text={active_set ? active_set.label : announced ? `${announced_count} ${announced.noun ?? 'regions'}` : undefined}
        label="Regions of interest"
        title={announced && !active_set ? `${announced_count} ${announced.noun ?? 'regions'} in ${announced.label}: click to show them` : 'Regions of interest'}
        className={active_set ? 'qiv-intent' : announced ? 'qiv-announce' : ''}
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
      <Button
        icon="properties"
        label="Values under the pointer"
        title={`${show_details ? 'Hide' : 'Show'} the values under the pointer${n_way ? ', and how far apart the images are' : ''}`}
        active={show_details}
        aria-pressed={show_details}
        onClick={() => setDetails(!show_details)}
      />
      <Button
        icon={ANALYSIS_ICONS[analysis]}
        title={`${show_analysis ? 'Hide' : 'Show'} the analysis of the view: histogram, row and column profiles, statistics (a)`}
        active={show_analysis}
        aria-pressed={show_analysis}
        onClick={toggleAnalysis}
      />
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
      outlines={outlines}
      onOutlinesChange={setOutlines}
    />}
    {n_way && show_details && <ComparePanel
      entries={entries}
      main={controller}
      tiles={tiles}
      base={base}
      onToggleBase={() => setBase(b => b === 10 ? 16 : 10)}
      distances={distances}
      onPair={(i, j) => setPair([imageKey(list[i]), imageKey(list[j])])}
      unavailable={getPixels ? null : imageValuesUnavailable}
    />}
    {!n_way && show_details && <Readout
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
      pinHint={single ? 'Shift+click a pixel to pin it' : 'click a pixel to pin it'}
      sizes={{ a: size_a, b: size_b }}
      unavailable={getPixels ? null : imageValuesUnavailable}
    />}
    </div>
    <div
      ref={stage}
      className={`qiv-stage qiv-mode-${mode}`}
      style={{ width: stage_width, height: stage_height }}
    >
      {pane('a')}
      {pane('b')}
      {n_way && others.map(({ image: other, index: place }) => <Tile
        key={place}
        image={other}
        name={tileName(other, place)}
        {...tileColor(other, place)}
        leader={controller}
        anchor={images.a}
        anchorName={names.a}
        anchorSize={size_a}
        anchorFirst={anchor_index < place}
        mode={mode}
        hidden={single && shown_index !== place}
        active={visible}
        syncKey={sync_key}
        {...slot(place)}
        width={pane_width}
        height={pane_height}
        filter={filter}
        diff={diff}
        wipe={wipe_all}
        onWipeChange={setWipeAll}
        showLabel={!single}
        note={single ? null : tileNote(place)}
        regions={outlines ? active_set?.regions : null}
        activeRegion={index}
        onSelectRegion={selectRegion}
        pixelSource={pixel_source}
        pixelTiles={tiles}
        base={base}
        onClick={onTileClick}
        onAnchor={other?.canAnchor === false ? undefined : () => pickAnchor(place)}
        onController={value => registerTile(place, value)}
      />)}
      {n_way && single && <div className="qiv-picks" role="radiogroup" aria-label="The image shown">
        {list.map((entry, index) => <button
          key={index}
          type="button"
          role="radio"
          aria-checked={index === shown_index}
          className={`qiv-label qiv-pick ${index === shown_index ? 'qiv-active' : ''}`}
          style={{ background: tileColor(entry, index).color, color: tileColor(entry, index).textColor }}
          title={`Show ${tileName(entry, index)} (Shift+${index + 1}). t shows the next image, Shift+t the previous one`}
          disabled={!hasSource(entry)}
          onClick={() => setShown(index)}
          onPointerDown={event => event.stopPropagation()}
        >{index === anchor_index && <Icon icon="anchor" size={12} className="qiv-label-icon" />}{index + 1} {tileName(entry, index)}</button>)}
      </div>}
      {compact && !fullscreen && <button
        type="button"
        className="qiv-chrome-toggle"
        title={chrome ? 'Hide the toolbar' : 'Show the toolbar: modes, zoom, regions…'}
        aria-label={chrome ? 'Hide the toolbar' : 'Show the toolbar'}
        aria-pressed={chrome}
        onClick={() => setChrome(!chrome)}
        onPointerDown={event => event.stopPropagation()}
      ><Icon icon="more" size={14} /></button>}
      {mode === 'difference' && !n_way && <div
        ref={diff_pane}
        className={`qiv-pane qiv-diff-pane ${diff_between ? 'qiv-diff-between' : ''}`}
        style={{ width: pane_width, height: pane_height, ...diff_position, zIndex: 3 }}
        onPointerMove={diff_between ? event => controller.hover('diff', event.clientX, event.clientY, event.currentTarget) : undefined}
        onPointerLeave={diff_between ? () => controller.unhover() : undefined}
      >
        <DiffLayer controller={controller} order={[first, second]} diff={diff} active={visible} width={pane_width} height={pane_height} canvasRef={diff_canvas} onError={setDiffError} />
        {pixelValues('diff')}
        {regionOutlines('diff')}
        <Crosshair controller={controller} pane="diff" />
        {show_analysis && <GuideLine controller={controller} guide={guide} />}
        {diff_between && <>
          <span className="qiv-label qiv-label-left qiv-label-diff" title={`${names[first]} − ${names[second]}`}>difference</span>
          <div className="qiv-stage-notes"><DiffLegend diff={diff} names={[names[first], names[second]]} /></div>
        </>}
        {diff_error && <div className="qiv-message qiv-pane-message">{diff_error}</div>}
      </div>}
      <div className="qiv-stage-notes" style={n_way ? { left: slot(anchor_index).left + 6, bottom: stage_height - slot(anchor_index).top - pane_height + 6, maxWidth: pane_width - 12 } : undefined}>
        {mode === 'difference' && !diff_between && <DiffLegend diff={diff} names={n_way ? ['the earlier image', 'the later one'] : [names[first], names[second]]} />}
        <ValuesBadge drawn={pixel_source !== 'off' ? values_drawn : null} />
      </div>
      {mode === 'wipe' && !n_way && <>
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
      {mode === 'single' && !n_way && label(first, 'left')}
      <Minimap controller={controller} image={hidden ? images[first] : images.a} size={size_a} />
    </div>
    {show_analysis && <div ref={analysis_panel} className="qiv-analysis-wrap"><AnalysisPanel
      controller={controller}
      comparing={comparing}
      names={names}
      view={analysis}
      onViewChange={setAnalysis}
      channels={histogram_channels}
      onChannelsChange={setHistogramChannels}
      range={highlight_range}
      onRangeChange={setHighlightRange}
      imageRange={image_range}
      onImageRangeChange={setImageRange}
      onImageHighlightChange={setImageMasks}
      onGuideChange={setGuide}
      values={analysis_values === 'image' ? 'image' : 'display'}
      onValuesChange={setAnalysisValues}
      images={images}
      sizes={{ a: size_a, b: size_b }}
      getPixels={getPixels}
      imageValuesUnavailable={imageValuesUnavailable}
      sensor={sensor}
      onSensorChange={setSensorSetting}
      sensorRemembered={sensorRemembered}
    /></div>}
  </div>;
};

// The height of an element, while `enabled`
const useHeight = (ref, enabled) => {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return height;
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
