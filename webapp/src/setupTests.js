import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { Icons } from '@blueprintjs/icons';

// Blueprint loads the icons' paths asynchronously, then re-renders them, outside of act():
// load them all up front, or tests log "An update to Blueprint6.Icon inside a test was not wrapped in act(...)"
await Icons.loadAll();

// Blueprint's toasts render in a portal with timers that can fire after a test's DOM is gone
vi.mock('./toaster', () => ({ toaster: { show: vi.fn(), dismiss: vi.fn(), clear: vi.fn() } }));

// jsdom has no canvas: the tab's icon (src/favicon.js) finds no 2d context and keeps the plain icon, silently
HTMLCanvasElement.prototype.getContext = () => null;

// findBy*/waitFor give up after 1 s by default. With the suite's workers on all cores (or a busy CI host), a lazy
// component's first import or a *ByRole query on a big page takes longer: tests that pass alone timed out. A wait
// returns as soon as its condition holds, so this only delays the failures. testTimeout (vite.config.js) is above it.
configure({ asyncUtilTimeout: 5000 });
