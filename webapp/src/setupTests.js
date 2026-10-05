import '@testing-library/jest-dom/vitest';
import { Icons } from '@blueprintjs/icons';

// Blueprint loads the icons' paths asynchronously, then re-renders them, outside of act():
// load them all up front, or tests log "An update to Blueprint6.Icon inside a test was not wrapped in act(...)"
await Icons.loadAll();
