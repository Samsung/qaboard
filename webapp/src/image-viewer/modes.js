// How the viewer compares the images. In its own module: apps can list them without loading the viewer.
export const MODES = [
  { value: 'side-by-side', label: 'Side by side', icon: 'split-columns', title: 'Side by side (1)' },
  { value: 'wipe', label: 'Wipe', icon: 'drag-handle-vertical', title: 'Wipe: drag the divider (2)' },
  { value: 'single', label: 'Single', icon: 'media', title: 'Single: one image at a time, in place. t or a click on the image shows the other (3)' },
  { value: 'difference', label: 'Difference', icon: 'contrast', title: 'Difference, alone or with the images on its sides: click again or press 4 again to switch (4)' },
];

export const DEFAULT_MODE = 'side-by-side';
