// The OpenSeadragon viewers of a comparison: the image (pane "a") and its reference (pane "b").
//
// They always show the same region: the one users move leads, the other follows, and other viewers with the same
// sync key follow too (sync.js). React subscribes to the state (useSyncExternalStore) and to the draws, e.g. to
// compute the difference once both viewers drew the same region.

import OpenSeadragon from 'openseadragon';

import { imageKey, openImage } from './sources';
import { joinSyncGroup, syncGroupKey, viewportAfterImageChange } from './sync';
import { regionToViewport, viewportToRegion } from './regions';

export const PANES = ['a', 'b'];

const OSD_OPTIONS = {
  // We read the pixels it draws. The WebGL drawer would also use one of the few WebGL contexts per page per viewer.
  drawer: 'canvas',
  showNavigationControl: false,
  showNavigator: false,
  // the viewer handles the keys
  keyboardNavEnabled: false,
  // the image stays in view
  visibilityRatio: 1,
  minZoomImageRatio: 1,
  // up to 100 screen pixels per image pixel: big enough to read the values written on them
  maxZoomPixelRatio: 100,
  animationTime: 0.3,
  springStiffness: 12,
  // we want to see the pixels
  imageSmoothingEnabled: false,
  smoothTileEdgesMinZoom: Infinity,
  // to read the pixels, images from another origin need CORS headers
  crossOriginPolicy: 'Anonymous',
  ajaxWithCredentials: false,
  // the viewer places the images
  preserveViewport: true,
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: false },
  tileRetryMax: 2,
  // large raw images can take a while to be tiled
  timeout: 120000,
};

const same_aspect = (a, b) => !!a?.width && !!b?.width && Math.abs(a.height / a.width - b.height / b.width) < 1e-3;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export class Comparison {
  constructor({ syncKey = null } = {}) {
    this.viewers = {};
    this.images = {};
    // the pane users move: the other follows
    this.leader = 'a';
    this.visible = true;
    this.syncKey = syncKey;
    this.group = null;
    this.groupKey = null;
    // a viewport from the sync group, to apply when the viewer shows
    this.pending = null;
    // the region to show when an image first shows, or changes aspect ratio
    this.region = null;
    this.onClick = null;
    this.listeners = new Set();
    this.drawListeners = new Set();
    this.pointerListeners = new Set();
    this.snapshot = this.computeSnapshot();
    this.pointer = null;
    // where the mouse is over a pane: { name, clientX, clientY }
    this.hovered = null;
    this.drawFrame = null;
  }

  // --- React's subscriptions ---

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  computeSnapshot() {
    const pane = name => {
      const entry = this.images[name];
      return {
        status: entry?.status ?? 'empty',
        width: entry?.width ?? null,
        height: entry?.height ?? null,
        error: entry?.error ?? null,
        fullyLoaded: !!entry?.fullyLoaded,
        tileErrors: entry?.tileErrors ?? 0,
      };
    };
    return { a: pane('a'), b: pane('b') };
  }

  emit() {
    const next = this.computeSnapshot();
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    this.listeners.forEach(listener => listener());
  }

  // Called after the viewers drew, once per frame
  onDraw = listener => {
    this.drawListeners.add(listener);
    return () => this.drawListeners.delete(listener);
  };
  scheduleDraw() {
    if (this.drawFrame !== null) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      // the image moved under the pointer, e.g. zoomed with the keyboard: it's over another pixel
      const { hovered } = this;
      if (hovered) {
        const point = this.pointAt(hovered.pane, hovered.clientX, hovered.clientY, hovered.element);
        const current = this.pointer?.point;
        if (point && (!current || point.x !== current.x || point.y !== current.y)) {
          this.setPointerState({ point, pane: hovered.pane, remote: false });
          this.group?.pointer(point);
        }
      }
      this.drawListeners.forEach(listener => listener());
    });
  }

  subscribePointer = listener => {
    this.pointerListeners.add(listener);
    return () => this.pointerListeners.delete(listener);
  };
  getPointer = () => this.pointer;
  setPointerState(pointer) {
    this.pointer = pointer;
    this.pointerListeners.forEach(listener => listener());
  }

  // --- Viewers ---

  attach(name, element) {
    if (this.viewers[name]?.element === element) return;
    this.detach(name);
    const viewer = OpenSeadragon({ ...OSD_OPTIONS, element });
    this.viewers[name] = viewer;
    viewer.addHandler('viewport-change', () => this.onViewportChange(name));
    viewer.addHandler('update-viewport', () => this.scheduleDraw());
    // Users lead with gestures, not by moving the mouse over another pane: it would stop the zoom of the other halfway
    for (const event of ['canvas-press', 'canvas-scroll', 'canvas-pinch', 'canvas-drag'])
      viewer.addHandler(event, () => this.lead(name));
    viewer.addHandler('canvas-click', event => {
      if (event.quick) this.onClick?.(name, event);
    });
    viewer.addHandler('tile-load-failed', event => {
      const entry = this.images[name];
      if (!entry || event.tiledImage !== entry.item) return;
      entry.tileErrors = (entry.tileErrors ?? 0) + 1;
      entry.tileError = event.message;
      this.emit();
    });
    const entry = this.images[name];
    if (entry?.opened) this.addImage(name, entry, entry.opened);
  }

  detach(name) {
    const viewer = this.viewers[name];
    if (!viewer) return;
    delete this.viewers[name];
    if (this.images[name]) this.images[name].item = null;
    viewer.destroy();
  }

  // Releases the viewers. The comparison works again when React attaches the panes and sets the images (e.g. in
  // StrictMode, which unmounts and mounts again).
  dispose() {
    PANES.forEach(name => {
      this.images[name]?.abort?.abort();
      this.detach(name);
    });
    this.images = {};
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    this.drawFrame = null;
    this.group?.leave();
    this.group = null;
    this.groupKey = null;
  }

  // --- Images ---

  setImage(name, image) {
    const key = imageKey(image);
    const current = this.images[name];
    if (current && current.key === key) {
      current.image = image;
      return;
    }
    current?.abort?.abort();
    if (!key) {
      this.images[name] = { key, status: 'empty' };
      this.removeItems(name);
      this.emit();
      return;
    }
    const abort = new AbortController();
    const entry = { key, image, status: 'loading', abort, width: current?.width, height: current?.height };
    this.images[name] = entry;
    this.emit();
    openImage(image, { signal: abort.signal }).then(opened => {
      if (abort.signal.aborted) return;
      entry.opened = opened;
      if (this.viewers[name]) this.addImage(name, entry, opened);
    }, error => {
      if (abort.signal.aborted) return;
      entry.status = 'error';
      entry.error = { message: error.message, url: error.url, details: error.details };
      // we don't show an image that is not the one users asked for
      this.removeItems(name);
      this.emit();
    });
  }

  removeItems(name, except = null) {
    const world = this.viewers[name]?.world;
    if (!world) return;
    for (let i = world.getItemCount() - 1; i >= 0; i--) {
      const item = world.getItemAt(i);
      if (item !== except) world.removeItem(item);
    }
  }

  addImage(name, entry, opened) {
    const viewer = this.viewers[name];
    entry.opened = null;
    // until it's replaced, the entry has the size of the image shown
    const shown = { width: entry.width, height: entry.height };
    const previous = name === 'a' ? this.captureViewport(shown) : null;
    const restore = viewportAfterImageChange(previous, opened);
    const old_items = [];
    for (let i = 0; i < viewer.world.getItemCount(); i++) old_items.push(viewer.world.getItemAt(i));
    // Images of another aspect ratio would overflow: they go now. Others stay until the new one is loaded, else it
    // would blink.
    if (old_items.length > 0 && !same_aspect(shown, opened)) {
      this.removeItems(name);
      old_items.length = 0;
    }
    viewer.addTiledImage({
      tileSource: opened.tileSource,
      x: 0,
      y: 0,
      width: 1,
      success: ({ item }) => {
        if (this.images[name] !== entry || this.viewers[name] !== viewer) {
          viewer.world.removeItem(item);
          return;
        }
        entry.item = item;
        entry.width = opened.width;
        entry.height = opened.height;
        entry.status = 'ready';
        entry.error = null;
        entry.tileErrors = 0;
        entry.fullyLoaded = item.getFullyLoaded();
        item.addHandler('fully-loaded-change', event => {
          // an image that was replaced meanwhile: its tiles may still arrive
          if (this.images[name] !== entry || entry.item !== item) return;
          entry.fullyLoaded = event.fullyLoaded;
          if (event.fullyLoaded) this.removeItems(name, item);
          this.emit();
        });
        if (entry.fullyLoaded) this.removeItems(name, item);
        if (name === 'a') this.updateGroup();
        this.place(name, restore, !previous);
        this.emit();
      },
      error: event => {
        if (this.images[name] !== entry) return;
        entry.status = 'error';
        entry.error = { message: event?.message ?? 'Could not open the image' };
        this.removeItems(name);
        this.emit();
      },
    });
  }

  // Where the viewers look once an image was added
  place(name, restore, first) {
    if (name === 'b') {
      if (this.viewers.a?.world.getItemCount() > 0) this.copyViewport('a', 'b');
      else this.viewers.b?.viewport.goHome(true);
      return;
    }
    if (restore?.action === 'keep') {
      this.applyViewport(restore);
      return;
    }
    const from_group = first ? this.group?.viewport() : null;
    if (from_group) this.applyViewport(from_group);
    else if (!this.fitRegion(this.region, { immediately: true })) this.home(true);
  }

  // --- Viewports ---

  viewportOf(name) {
    const viewport = this.viewers[name]?.viewport;
    if (!viewport) return null;
    return { zoom: viewport.getZoom(true), center: viewport.getCenter(true) };
  }

  // The viewport of the image's viewer, with the size of the image it shows (size), or null when it shows none
  captureViewport(size) {
    const viewer = this.viewers.a;
    if (!viewer || viewer.world.getItemCount() === 0 || !size?.width || !size?.height) return null;
    return { ...this.viewportOf('a'), width: size.width, height: size.height };
  }

  // Both viewers, at once
  applyViewport({ zoom, center }) {
    for (const name of PANES) {
      const viewport = this.viewers[name]?.viewport;
      if (!viewport) continue;
      viewport.zoomTo(zoom, null, true);
      viewport.panTo(new OpenSeadragon.Point(center.x, center.y), true);
    }
  }

  copyViewport(from, to) {
    const viewport = this.viewportOf(from);
    const target = this.viewers[to]?.viewport;
    if (!viewport || !target) return;
    target.zoomTo(viewport.zoom, null, true);
    target.panTo(viewport.center, true);
  }

  onViewportChange(name) {
    const other = name === 'a' ? 'b' : 'a';
    if (this.leader !== name) {
      // The follower moved by itself, e.g. it resized with the layout and rounded its zoom differently: back in line
      if (this.images[name]?.item && this.images[other]?.item && !this.aligned()) this.copyViewport(other, name);
      return;
    }
    if (this.images[other]?.item) this.copyViewport(name, other);
    const viewport = this.viewportOf(name);
    if (viewport && this.images[name]?.item) this.group?.publish(viewport);
  }

  // Called with the pane's name when users click an image (not when they drag it)
  setOnClick(listener) {
    this.onClick = listener;
  }

  // Users move this pane
  lead(name) {
    this.leader = name;
    this.group?.lead();
  }

  setSyncKey(key) {
    this.syncKey = key;
    this.updateGroup();
  }

  updateGroup() {
    const { width, height } = this.images.a ?? {};
    const key = syncGroupKey(this.syncKey, width, height);
    if (key === this.groupKey) return;
    this.group?.leave();
    this.groupKey = key;
    this.group = key === null ? null : joinSyncGroup(key, {
      setViewport: viewport => this.followGroup(viewport),
      setPointer: point => this.setPointerState(point ? { point, remote: true } : null),
    });
  }

  followGroup(viewport) {
    if (!this.visible || !this.images.a?.item) {
      this.pending = viewport;
      return;
    }
    this.pending = null;
    this.applyViewport(viewport);
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) return;
    const viewport = this.pending ?? null;
    this.pending = null;
    if (viewport && this.images.a?.item) this.applyViewport(viewport);
  }

  // Both viewers show the same region: e.g. the difference compares the same pixels
  aligned() {
    const a = this.viewportOf('a');
    const b = this.viewportOf('b');
    if (!a || !b) return false;
    return close(a.zoom, b.zoom) && close(a.center.x, b.center.x) && close(a.center.y, b.center.y);
  }

  // --- Navigation ---

  home(immediately = false) {
    for (const name of PANES) this.viewers[name]?.viewport.goHome(immediately);
  }

  zoomBy(factor) {
    const viewport = this.viewers.a?.viewport;
    if (!viewport) return;
    this.lead('a');
    viewport.zoomBy(factor);
    viewport.applyConstraints();
  }

  // One image pixel per screen pixel
  actualSize() {
    const item = this.images.a?.item;
    const viewport = this.viewers.a?.viewport;
    if (!item || !viewport) return;
    this.lead('a');
    viewport.zoomTo(item.imageToViewportZoom(1));
    viewport.applyConstraints();
  }

  fit() {
    this.lead('a');
    this.home();
  }

  // Shows a region of the image. Returns false if there is none to show.
  fitRegion(region, { immediately = false } = {}) {
    const a = this.images.a;
    const viewer = this.viewers.a;
    if (!region || !viewer || !a?.width) return false;
    const rect = regionToViewport(region, a);
    if (!rect) return false;
    if (!immediately) this.lead('a');
    viewer.viewport.fitBounds(new OpenSeadragon.Rect(rect.x, rect.y, rect.width, rect.height), immediately);
    if (immediately) this.copyViewport('a', 'b');
    return true;
  }

  // Centers the view on an image point, e.g. from the minimap
  panToImagePoint(x, y, immediately = false) {
    const item = this.images.a?.item;
    const viewport = this.viewers.a?.viewport;
    if (!item || !viewport) return;
    this.lead('a');
    viewport.panTo(item.imageToViewportCoordinates(x, y), immediately);
    viewport.applyConstraints(immediately);
  }

  setRegion(region) {
    this.region = region;
  }

  // The region of the image in view, in its pixels
  visibleRegion() {
    const a = this.images.a;
    const viewer = this.viewers.a;
    if (!a?.item || !viewer) return null;
    return viewportToRegion(viewer.viewport.getBounds(true), a);
  }

  // Screen pixels per image pixel: 1 is "actual pixels"
  imageZoom() {
    const item = this.images.a?.item;
    const viewport = this.viewers.a?.viewport;
    if (!item || !viewport) return null;
    return item.viewportToImageZoom(viewport.getZoom(true));
  }

  // --- Pixels ---

  canvas(name) {
    return this.viewers[name]?.drawer?.canvas ?? null;
  }

  // The viewer whose geometry a pane has: other panes, e.g. the difference, are drawn like the first image
  geometry(pane) {
    return pane === 'b' ? 'b' : 'a';
  }

  // The viewport point under a mouse event on a pane (or on another element of the size of the panes)
  pointAt(pane, clientX, clientY, element = null) {
    const viewer = this.viewers[this.geometry(pane)];
    if (!viewer) return null;
    const rect = (element ?? viewer.element).getBoundingClientRect();
    return viewer.viewport.pointFromPixel(new OpenSeadragon.Point(clientX - rect.left, clientY - rect.top), true);
  }

  hover(pane, clientX, clientY, element = null) {
    this.hovered = { pane, clientX, clientY, element };
    const point = this.pointAt(pane, clientX, clientY, element);
    if (!point) return;
    this.setPointerState({ point, pane, remote: false });
    this.group?.pointer(point);
  }

  // Gestures on another element of the size of the panes, e.g. the difference between the images, move the images
  // like on the first one. Returns a function that stops.
  trackGestures(element) {
    const viewport = () => this.viewers.a?.viewport;
    const moved = () => {
      this.lead('a');
      return viewport();
    };
    const tracker = new OpenSeadragon.MouseTracker({
      element,
      scrollHandler: event => {
        event.preventDefault = true;
        const v = moved();
        if (!v) return;
        v.zoomBy(this.viewers.a.zoomPerScroll ** event.scroll, v.pointFromPixel(event.position, true));
        v.applyConstraints();
      },
      dragHandler: event => {
        const v = moved();
        v?.panBy(v.deltaPointsFromPixels(event.delta.negate()));
      },
      dragEndHandler: () => viewport()?.applyConstraints(),
      pinchHandler: event => {
        const v = moved();
        if (!v) return;
        const center = v.pointFromPixel(event.center, true);
        const last_center = v.pointFromPixel(event.lastCenter, true);
        v.zoomBy(event.distance / event.lastDistance, center, true);
        v.panBy(last_center.minus(center), true);
        v.applyConstraints();
      },
      dblClickHandler: event => {
        const v = moved();
        if (!v) return;
        v.zoomBy(this.viewers.a.zoomPerClick, v.pointFromPixel(event.position, true));
        v.applyConstraints();
      },
    });
    return () => tracker.destroy();
  }

  unhover() {
    this.hovered = null;
    if (this.pointer && !this.pointer.remote) {
      this.setPointerState(null);
      this.group?.pointer(null);
    }
  }

  // Where a viewport point is in a pane, in CSS pixels
  screenPoint(pane, point) {
    const viewport = this.viewers[this.geometry(pane)]?.viewport;
    if (!viewport || !point) return null;
    return viewport.pixelFromPoint(new OpenSeadragon.Point(point.x, point.y), true);
  }

  // The image pixel at a viewport point, or null outside the image
  imagePixel(name, point) {
    const entry = this.images[name];
    if (!entry?.item || !point) return null;
    const { x, y } = entry.item.viewportToImageCoordinates(point.x, point.y, true);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= entry.width || iy >= entry.height) return null;
    return { x: ix, y: iy };
  }

  // The displayed color at a viewport point: [r, g, b, a], or null
  displayPixel(name, point) {
    const canvas = this.canvas(name);
    // at the center of the image pixel under the point: at its edge, the screen pixel may show the next one
    const pixel = this.imagePixel(name, point);
    if (!canvas || !pixel) return null;
    const position = this.screenPoint(name, this.images[name].item.imageToViewportCoordinates(pixel.x + 0.5, pixel.y + 0.5, true));
    if (!position) return null;
    const ratio = OpenSeadragon.pixelDensityRatio;
    const x = Math.floor(position.x * ratio);
    const y = Math.floor(position.y * ratio);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    try {
      return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    } catch {
      // without CORS headers
      return null;
    }
  }

  // Where the image is drawn in a pane: { origin, scale } in CSS pixels, see pixels.js
  imageTransform(name) {
    const item = this.images[name]?.item;
    if (!item) return null;
    const origin = item.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const corner = item.imageToViewerElementCoordinates(new OpenSeadragon.Point(1, 1));
    return { origin, scale: corner.x - origin.x };
  }
}

export const pixelDensityRatio = () => OpenSeadragon.pixelDensityRatio;
