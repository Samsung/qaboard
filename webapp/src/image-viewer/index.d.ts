// Types of the image viewer's public API. See README.md.
import type { CSSProperties, ReactNode } from 'react';

/**
 * An image: a URL the browser can decode (PNG, JPEG, WebP...), or an object.
 * Extra fields are kept: the viewer gives the image back to your callbacks, e.g. `getPixels`.
 */
export type ImageSource = string | ImageDescriptor;

export interface ImageDescriptor {
  /** A plain image, loaded at once */
  url?: string;
  /** An IIIF Image API service (the URL without /info.json): streamed tile by tile, for large images */
  iiif?: string;
  /** Shown on the image, e.g. "new" or "reference" */
  label?: string;
  /** A link to the original file, offered in the copy menu */
  href?: string;
  [key: string]: unknown;
}

export type Mode = 'side-by-side' | 'wipe' | 'single' | 'difference';

export type DiffMethod = 'absolute' | 'signed' | 'perceptual' | 'deltaE' | 'exact';

export interface DiffSettings {
  method: DiffMethod;
  /** "absolute" and "signed": how much the difference is amplified */
  gain?: number;
  /** "perceptual" (a fraction, e.g. 0.05) and "deltaE" (e.g. 5): the difference shown with the colormap's last color */
  max?: number;
  /** "between": the images on each side of the difference (the default), or "alone" */
  layout?: 'between' | 'alone';
}

export interface Adjustments {
  /** Added to each channel, from -255 to 255 */
  brightness?: number;
  /** Around mid-gray */
  contrast?: number;
  /** Over 1 brightens the shadows */
  gamma?: number;
  /** Unsharp masking, from 0 to 2 */
  sharpen?: number;
  /** One channel as gray levels */
  channel?: 'rgb' | 'r' | 'g' | 'b' | 'luma';
  /** A colormap for the gray levels */
  falseColor?: 'turbo' | 'viridis' | 'inferno' | null;
  invert?: boolean;
}

/** A region of interest, in the pixels of the image, or of an image of size imageWidth x imageHeight (it's scaled) */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  /** A CSS color, e.g. how much the images differ there */
  color?: string;
  imageWidth?: number;
  imageHeight?: number;
}

export interface RegionSet {
  id: string;
  label: string;
  description?: string;
  /** undefined until loaded */
  regions?: Region[];
  loading?: boolean;
  error?: string;
  /** Finds the regions, e.g. by asking a server. Called when users pick the set and it has no regions. */
  load?: () => void;
  /** Shown when the set has no regions, e.g. "No difference found". Default: "No regions" */
  empty?: string;
}

/** A blind test: what the image (`image`, not `reference`) is called, and whether users revealed which is which */
export interface BlindTest {
  a: 'A' | 'B';
  revealed?: boolean;
}

/** An action of the app in the regions menu, e.g. finding the regions of all the images of a page */
export interface RegionAction {
  id: string;
  label: string;
  /** One of the viewer's icons, e.g. "search" (icons.js) */
  icon?: string;
  title?: string;
  onClick: () => void;
}

export interface PixelRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The values of a region: flat, row by row and channel by channel (a typed array is best) */
export interface PixelData {
  data: ArrayLike<number>;
  width: number;
  height: number;
  /** By default, data.length / (width * height) */
  channels?: number;
  /** What the values are, e.g. "I;16" or "RGB;10" */
  mode?: string;
}

/** The values of a region, as rows of pixels */
export interface PixelRows {
  /** The rows of the region, each pixel a number or its channels: like numpy's image[y:y+h, x:x+w].tolist() */
  values: (number | number[])[][];
  /** What the values are, e.g. "I;16" or "RGB" */
  mode?: string;
}

export type Pixels = PixelData | PixelRows;

/** The values written on the pixels: the image's own (with getPixels), the displayed 8-bit ones, or none */
export type PixelValuesSource = 'image' | 'display' | 'off';

export interface ImageViewerProps {
  /** The image */
  image: ImageSource;
  /** What it's compared with. Without it, the viewer shows the image alone. */
  reference?: ImageSource | null;

  /** How the images are compared: controlled with onModeChange, or not, from defaultMode */
  mode?: Mode;
  defaultMode?: Mode;
  onModeChange?: (mode: Mode) => void;

  /** How the difference is computed and shown, in the "difference" mode */
  diff?: DiffSettings;
  defaultDiff?: DiffSettings;
  onDiffChange?: (diff: DiffSettings) => void;

  /** Display adjustments, applied to both images */
  adjustments?: Adjustments;
  defaultAdjustments?: Adjustments;
  onAdjustmentsChange?: (adjustments: Adjustments) => void;

  /** The values written on the pixels when zoomed in enough. 'image' needs getPixels, else they're the displayed ones. Default: 'image' */
  pixelValues?: PixelValuesSource;
  defaultPixelValues?: PixelValuesSource;
  onPixelValuesChange?: (source: PixelValuesSource) => void;

  /** Viewers with the same key, showing images of the same aspect ratio, zoom and pan together */
  syncKey?: string | null;

  /** Regions of interest users can step through */
  regionSets?: RegionSet[];
  /** The set shown (null: the full image), controlled with onRegionSetChange, e.g. the same for several viewers, or not, from defaultRegionSet */
  regionSet?: string | null;
  /** The id of the set shown first, e.g. "presets" */
  defaultRegionSet?: string | null;
  onRegionSetChange?: (id: string | null) => void;
  /** The app's actions in the regions menu */
  regionActions?: RegionAction[];

  /** The reference shows first (left, or in single mode), controlled with onSwappedChange, e.g. for every viewer of a page */
  swapped?: boolean;
  defaultSwapped?: boolean;
  onSwappedChange?: (swapped: boolean) => void;

  /**
   * A blind test: the images are called A and B. Without it, the viewer runs its own (h, or the Blind test button).
   * Controlled, the viewer asks with onBlindTestChange: 'start' (show the images in a random order with `swapped`, the
   * first one called A), 'reveal', then 'end'.
   */
  blindTest?: BlindTest | null;
  onBlindTestChange?: (action: 'start' | 'reveal' | 'end') => void;

  /**
   * The images' own values, e.g. raw or 16-bit, shown under the pointer and on the pixels.
   * Asked by tiles of 64x64 pixels (cut at the image's edges), kept, and cancelled with the signal when no longer needed.
   * Without it, the viewer shows the displayed 8-bit RGB values.
   */
  getPixels?: (image: ImageDescriptor, region: PixelRegion, options: { signal: AbortSignal }) => Promise<Pixels>;
  /** Without getPixels: why the images' own values aren't available, e.g. "Sign in to read the images' own values" */
  imageValuesUnavailable?: string;

  /** The highest the images can be, in CSS pixels, or a function of the window's height. Default: h => h - 160 */
  maxHeight?: number | ((windowHeight: number) => number);
  /** By default, the system's. Or theme with the CSS variables, see README.md. */
  theme?: 'light' | 'dark';
  /** Shown in the toolbar, after the comparison controls */
  notice?: ReactNode;
  /** Shown in the toolbar, before the tools */
  toolbarExtra?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export declare const ImageViewer: (props: ImageViewerProps) => ReactNode;
export default ImageViewer;

export declare const MODES: { value: Mode; label: string; icon: string; title: string }[];
export declare const DEFAULT_MODE: Mode;

export declare const DIFF_METHODS: Record<DiffMethod, {
  label: string;
  title: string;
  description: string;
  setting: 'gain' | 'max' | null;
  values: number[];
  default: number | null;
  format: (value: number) => string;
}>;
export declare const DEFAULT_DIFF: DiffSettings;
export declare function normalizeDiff(diff?: Partial<DiffSettings>): DiffSettings;
/** The difference of two displayed pixels ([r, g, b, a?], 0-255) */
export declare function diffAt(diff: Partial<DiffSettings> | undefined, a: number[], b: number[]): {
  delta: number[];
  value: number | null;
  amount: number;
};

export declare const DEFAULT_ADJUSTMENTS: Required<Adjustments>;
export declare function normalizeAdjustments(adjustments?: Adjustments): Required<Adjustments>;

/** The URL of the IIIF service of a file on an IIIF server whose identifiers are paths: slashes are encoded */
export declare function iiifUrl(server: string, identifier: string): string;
/** Loads an image's size, and its OpenSeadragon tile source */
export declare function openImage(image: ImageSource, options?: { signal?: AbortSignal }): Promise<{ width: number; height: number; tileSource: unknown }>;
/** A small version of an IIIF image, or of a region of it. null for other images. */
export declare function thumbnailUrl(image: ImageSource, region?: Region | null, height?: number): string | null;

export declare function regionAsYaml(region: Region, size: { width: number; height: number }): string;
export declare function scaleRegion(region: Region, size: { width: number; height: number }): Region;
export declare function clipRegion(region: Region, size: { width: number; height: number }): Region | null;
