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

export type Mode = 'side-by-side' | 'wipe' | 'toggle' | 'difference';

export type DiffMethod = 'absolute' | 'signed' | 'perceptual' | 'deltaE' | 'exact';

export interface DiffSettings {
  method: DiffMethod;
  /** "absolute" and "signed": how much the difference is amplified */
  gain?: number;
  /** "perceptual" (a fraction, e.g. 0.05) and "deltaE" (e.g. 5): the difference shown with the colormap's last color */
  max?: number;
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
}

export interface PixelRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pixels {
  /** The rows of the region, each pixel a number or its channels: like numpy's image[y:y+h, x:x+w].tolist() */
  values: (number | number[])[][];
  /** What the values are, e.g. "I;16" or "RGB" */
  mode?: string;
}

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

  /** Write the values of the pixels on them, when zoomed in enough */
  showPixelValues?: boolean;
  defaultShowPixelValues?: boolean;
  onShowPixelValuesChange?: (shown: boolean) => void;

  /** Viewers with the same key, showing images of the same aspect ratio, zoom and pan together */
  syncKey?: string | null;

  /** Regions of interest users can step through */
  regionSets?: RegionSet[];
  /** The id of the set shown first, e.g. "presets" */
  defaultRegionSet?: string | null;

  /**
   * The images' own values, e.g. raw or 16-bit, shown under the pointer and on the pixels.
   * Without it, the viewer shows the displayed 8-bit RGB values.
   */
  getPixels?: (image: ImageDescriptor, region: PixelRegion, options: { signal: AbortSignal }) => Promise<Pixels>;

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
