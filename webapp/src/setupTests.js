import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { Icons } from '@blueprintjs/icons';

// Blueprint loads the icons' paths asynchronously, then re-renders them, outside of act():
// load them all up front, or tests log "An update to Blueprint6.Icon inside a test was not wrapped in act(...)"
await Icons.loadAll();

// Blueprint's toasts render in a portal with timers that can fire after a test's DOM is gone
vi.mock('./toaster', () => ({ toaster: { show: vi.fn(), dismiss: vi.fn(), clear: vi.fn() } }));
