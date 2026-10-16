// How the viewer compares the images. In its own module: apps can list them without loading the viewer.
export const MODES = [
  { value: 'side-by-side', label: 'Side by side', icon: 'split-columns', title: 'Side by side (1)' },
  { value: 'wipe', label: 'Wipe', icon: 'drag-handle-vertical', title: 'Wipe: drag the divider (2)' },
  { value: 'toggle', label: 'Toggle', icon: 'swap-horizontal', title: 'Toggle: one image at a time, click or press t to flip (3)' },
  { value: 'difference', label: 'Difference', icon: 'contrast', title: 'Difference (4)' },
];

export const DEFAULT_MODE = 'side-by-side';
