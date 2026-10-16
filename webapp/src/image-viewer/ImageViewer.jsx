// Compares an image with a reference: side by side, with a wipe, toggling between them, or as their difference.
// See README.md for the props.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Comparison } from './comparison';
import { describeAdjustments, filterPrimitives, normalizeAdjustments, changedAdjustments } from './adjustments';
import { DEFAULT_DIFF, normalizeDiff } from './metrics';
import { regionAsYaml } from './regions';
import { DEFAULT_MODE, MODES } from './modes';
import { normalizeImage } from './sources';
import { Crosshair, DiffLayer, Minimap, PixelValues, useVisiblePixels } from './overlays';
import { AdjustmentsPanel, DiffLegend, DiffSettings, Histogram, Readout, RegionsMenu, RegionsStrip, Shortcuts } from './panels';
import { Button, Icon, MenuDivider, MenuItem, Popover, Segmented, Spinner } from './ui';
import './image-viewer.css';

const GAP = 4;
const ZOOM_STEP = 1.5;

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

const FilterPrimitive = ({ primitive }) => {
  const { type, attributes, functions } = primitive;
  if (type === 'feComponentTransfer')
    return <feComponentTransfer>
      {functions.map(({ channel, ...f }) => {
        const Func = `feFunc${channel}`;
        return <Func key={channel} {...f} />;
      })}
    </feComponentTransfer>;
  const Element = type;
  return <Element {...attributes} />;
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
  showPixelValues: show_pixel_values_prop,
  defaultShowPixelValues = true,
  onShowPixelValuesChange,
  syncKey = null,
  regionSets = [],
  defaultRegionSet = null,
  getPixels,
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
  const mode = comparing ? (MODES.some(m => m.value === stored_mode) ? stored_mode : 'side-by-side') : 'single';
  const [diff_setting, setDiff] = useControllable(diff_prop, defaultDiff, onDiffChange);
  const diff = normalizeDiff(diff_setting);
  const [adjustments_setting, setAdjustments] = useControllable(adjustments_prop, defaultAdjustments, onAdjustmentsChange);
  const adjustments = normalizeAdjustments(adjustments_setting);
  const [show_pixel_values, setShowPixelValues] = useControllable(show_pixel_values_prop, defaultShowPixelValues, onShowPixelValuesChange);
  const [swapped, setSwapped] = useState(false);
  const [wipe, setWipe] = useState(0.5);
  const [hide_labels, setHideLabels] = useState(false);
  const [base, setBase] = useState(10);
  const [show_histogram, setShowHistogram] = useState(false);
  const [diff_error, setDiffError] = useState(null);
  const [message, setMessage] = useState(null);
  const diff_canvas = useRef(null);

  // Layout: as wide as we can, as high as the window allows
  const root = useRef(null);
  const [available, setAvailable] = useState(0);
  const [window_height, setWindowHeight] = useState(() => window.innerHeight);
  useLayoutEffect(() => {
    const element = root.current;
    const measure = () => setAvailable(element.clientWidth);
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
  const max_height = Math.max(120, typeof maxHeight === 'function' ? maxHeight(window_height) : maxHeight);
  const per_pane = Math.max(0, side_by_side ? (available - GAP) / 2 : available);
  const pane_width = Math.floor(Math.min(per_pane, max_height / aspect));
  const pane_height = Math.floor(pane_width * aspect);
  const stage_width = side_by_side ? 2 * pane_width + GAP : pane_width;

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
  const swap = () => setSwapped(s => !s);

  // Regions of interest
  const [selection, setSelection] = useState(() => defaultRegionSet ? { set: defaultRegionSet, index: 0 } : null);
  const active_set = selection ? regionSets.find(set => set.id === selection.set) : null;
  const active_region = active_set?.regions?.[selection?.index ?? 0] ?? null;
  const region_key = active_region ? JSON.stringify([active_set.id, selection.index, active_region]) : null;
  useEffect(() => {
    controller.setRegion(active_region);
    if (active_region) controller.fitRegion(active_region);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [controller, region_key]);
  useEffect(() => {
    if (active_set && !active_set.regions && !active_set.loading && !active_set.error) active_set.load?.();
  }, [active_set]);
  const selectSet = id => {
    setSelection(id ? { set: id, index: 0 } : null);
    if (!id) controller.fit();
  };
  const stepRegion = step => {
    const count = active_set?.regions?.length ?? 0;
    if (count > 0) setSelection(s => ({ ...s, index: (s.index + step + count) % count }));
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

  // Clicking the image flips it in toggle mode
  const mode_ref = useRef(mode);
  useLayoutEffect(() => {
    mode_ref.current = mode;
    controller.setOnClick(() => {
      if (mode_ref.current === 'toggle') swap();
    });
  });

  // Display adjustments: an SVG filter on the images
  const filter_id = `qiv-filter-${useId().replace(/:/g, '')}`;
  const primitives = filterPrimitives(adjustments);
  const filter = primitives.length > 0 ? `url(#${filter_id})` : undefined;

  // The image's own values, when zoomed in
  const pixels_enabled = show_pixel_values && visible && !!getPixels;
  const fetched_a = useVisiblePixels({ controller, pane: 'a', image: images.a, getPixels, enabled: pixels_enabled, width: pane_width, height: pane_height });
  const fetched_b = useVisiblePixels({ controller, pane: 'b', image: comparing ? images.b : null, getPixels, enabled: pixels_enabled && comparing, width: pane_width, height: pane_height });
  const fetched = { a: fetched_a, b: fetched_b };

  // Keyboard shortcuts, for the viewer that has the focus, or under the mouse
  const hovered = useRef(false);
  const on_key = useRef(null);
  useLayoutEffect(() => {
    on_key.current = event => {
      switch (event.key) {
        case '1': case '2': case '3': case '4':
          if (!comparing) return false;
          setMode(MODES[Number(event.key) - 1].value);
          return true;
        case 't':
          if (!comparing) return false;
          swap();
          return true;
        case 'h':
          setHideLabels(hide => !hide);
          return true;
        case 'p':
          setShowPixelValues(!show_pixel_values);
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
      const focus = document.activeElement;
      const active = root.current?.contains(focus) || (hovered.current && (!focus || focus === document.body));
      if (!active || !on_key.current(event)) return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
    if (mode === 'wipe') return name === second ? { ...style, zIndex: 2, clipPath: `inset(0 0 0 ${wipe * pane_width}px)` } : { ...style, zIndex: 1 };
    if (mode === 'toggle') return name === first ? { ...style, zIndex: 2 } : { ...style, visibility: 'hidden' };
    // difference: the image receives the gestures, under the difference
    if (mode === 'difference') return name === 'a' ? { ...style, zIndex: 1 } : { ...style, visibility: 'hidden' };
    return style;
  };

  const resolution = name => snapshot[name].width ? <span className="qiv-label-detail">{snapshot[name].width}×{snapshot[name].height}</span> : null;
  const label = (name, position) => hide_labels || !comparing ? null : <button
    key={`label-${name}-${position}`}
    type="button"
    className={`qiv-label qiv-label-${position} ${name === 'a' ? 'qiv-primary' : 'qiv-warning'}`}
    title="Swap the images (t). Hide the labels with h"
    onClick={swap}
    onPointerDown={event => event.stopPropagation()}
  >
    {labels[name]}{resolution(name)}
  </button>;

  const pane_error = name => {
    const error = snapshot[name].error;
    if (!error) return null;
    return <div className="qiv-message qiv-pane-message">
      <strong>Can't show {comparing ? `the ${labels[name]} image` : 'the image'}</strong>
      <span>{error.message}</span>
      {error.url && <a href={error.url} target="_blank" rel="noopener noreferrer">See why</a>}
    </div>;
  };

  const pane = name => <div
    key={name}
    className="qiv-pane"
    style={paneStyle(name)}
    onPointerMove={event => controller.hover(name, event.clientX, event.clientY)}
    onPointerLeave={() => controller.unhover()}
  >
    <div className="qiv-osd" ref={element => { if (element) controller.attach(name, element); }} style={{ filter }} />
    <PixelValues controller={controller} pane={name} enabled={show_pixel_values && visible} width={pane_width} height={pane_height} raw={fetched} base={base} />
    <Crosshair controller={controller} pane={name} local={side_by_side} />
    {side_by_side && label(name, 'left')}
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
    <MenuItem icon="duplicate" text={`Copy the ${labels.a} image`} disabled={!can_copy('a')} onClick={() => { copy(controller.canvas('a'), `${labels.a} image`); close(); }} />
    {comparing && <MenuItem icon="duplicate" text={`Copy the ${labels.b} image`} disabled={!can_copy('b')} onClick={() => { copy(controller.canvas('b'), `${labels.b} image`); close(); }} />}
    {mode === 'difference' && <MenuItem icon="duplicate" text="Copy the difference" onClick={() => { copy(diff_canvas.current, 'difference', false); close(); }} />}
    <MenuDivider />
    <MenuItem icon="download" text={`Save the ${labels.a} view (PNG)`} disabled={!can_copy('a')} onClick={() => { saveCanvas(controller.canvas('a'), filter, `${base_name}.${labels.a}.png`); close(); }} />
    {comparing && <MenuItem icon="download" text={`Save the ${labels.b} view (PNG)`} disabled={!can_copy('b')} onClick={() => { saveCanvas(controller.canvas('b'), filter, `${base_name}.${labels.b}.png`); close(); }} />}
    {mode === 'difference' && <MenuItem icon="download" text="Save the difference (PNG)" onClick={() => { saveCanvas(diff_canvas.current, undefined, `${base_name}.difference.png`); close(); }} />}
    {(images.a?.href || images.b?.href) && <MenuDivider />}
    {images.a?.href && <MenuItem icon="media" text={`Open the ${labels.a} file`} href={images.a.href} onClick={close} />}
    {comparing && images.b?.href && <MenuItem icon="media" text={`Open the ${labels.b} file`} href={images.b.href} onClick={close} />}
    {changedAdjustments(adjustments).length > 0 && <div className="qiv-hint">Copied with the adjustments: {describeAdjustments(adjustments).join(', ')}</div>}
  </div>;

  const zoom = useZoom(controller);
  const adjusted = changedAdjustments(adjustments).length > 0;

  return <div
    ref={root}
    className={`qiv ${className}`}
    data-theme={theme}
    style={style}
    onPointerEnter={() => { hovered.current = true; }}
    onPointerLeave={() => { hovered.current = false; }}
  >
    <svg className="qiv-filters" aria-hidden="true" width="0" height="0">
      <filter id={filter_id} colorInterpolationFilters="sRGB">
        {primitives.map((primitive, i) => <FilterPrimitive key={i} primitive={primitive} />)}
      </filter>
    </svg>
    <div className="qiv-toolbar">
      {comparing && <Segmented
        label="Compare"
        options={MODES}
        value={mode}
        onChange={value => {
          // clicking Toggle again flips the images, like t
          if (value === 'toggle' && mode === 'toggle') swap();
          else setMode(value);
        }}
      />}
      {comparing && mode !== 'difference' && <Button icon="exchange" title={`Swap ${labels.a} and ${labels.b} (t)`} onClick={swap} active={swapped} aria-pressed={swapped} />}
      {mode === 'difference' && <DiffSettings diff={diff} onChange={setDiff} />}
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
        {({ close }) => <RegionsMenu sets={regionSets} selected={selection?.set ?? null} onSelect={selectSet} onCopy={copyRegion} close={close} />}
      </Popover>
      <Popover align="end" button={props => <Button {...props} icon="flash" title="Adjust the display: brightness, contrast, gamma, channels…" className={adjusted ? 'qiv-intent qiv-dot' : ''} />}>
        <AdjustmentsPanel adjustments={adjustments} onChange={setAdjustments} />
      </Popover>
      <Button icon="numerical" title={`${show_pixel_values ? 'Hide' : 'Show'} the pixel values when zoomed in (p)`} active={show_pixel_values} aria-pressed={show_pixel_values} onClick={() => setShowPixelValues(!show_pixel_values)} />
      <Button icon="timeline-area-chart" title="Histogram of the view" active={show_histogram} aria-pressed={show_histogram} onClick={() => setShowHistogram(!show_histogram)} />
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
      </span>
    </div>
    {active_set && <RegionsStrip
      set={active_set}
      index={selection.index}
      image={images.a}
      size={size_a}
      onSelect={index => setSelection(s => ({ ...s, index }))}
      onRetry={() => active_set.load?.()}
    />}
    <Readout
      controller={controller}
      images={images}
      comparing={comparing}
      diff={diff}
      getPixels={getPixels}
      fetched={fetched}
      base={base}
      onToggleBase={() => setBase(b => b === 10 ? 16 : 10)}
      sizes={{ a: size_a, b: size_b }}
    />
    <div
      ref={stage}
      className={`qiv-stage qiv-mode-${mode}`}
      style={{ width: stage_width, height: pane_height }}
    >
      {pane('a')}
      {pane('b')}
      {mode === 'difference' && <div className="qiv-pane qiv-diff-pane" style={{ width: pane_width, height: pane_height, left: 0, zIndex: 3 }}>
        <DiffLayer controller={controller} diff={diff} active={visible} width={pane_width} height={pane_height} canvasRef={diff_canvas} onError={setDiffError} />
        <PixelValues controller={controller} pane="diff" enabled={show_pixel_values && visible} width={pane_width} height={pane_height} raw={fetched} base={base} diffCanvas={diff_canvas} />
        {diff_error && <div className="qiv-message qiv-pane-message">{diff_error}</div>}
        {!hide_labels && <DiffLegend diff={diff} />}
      </div>}
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
      {mode === 'toggle' && label(first, 'left')}
      <Minimap controller={controller} image={images.a} size={size_a} />
    </div>
    {show_histogram && <Histogram controller={controller} comparing={comparing} labels={labels} />}
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
