import { describe, expect, it } from 'vitest';
import { useReferencePicker } from '../matching/pickerStore';
import { usePrefsStore } from '../stores/prefs';
import { registerRegionProvider, regionProviders } from '../viewers/images/regionProviders';

// setupTests.js resets module-level state after each test: these two run in this order, even when the suite shuffles
describe('module-level state', { shuffle: false }, () => {
  it('is changed by a test', () => {
    useReferencePicker.getState().open(3);
    registerRegionProvider({ id: 'test-state', label: 'Test', regions: () => [] });
    expect(useReferencePicker.getState().open_for).toBe('3');
  });

  it('is back to its initial state in the next', () => {
    expect(useReferencePicker.getState().open_for).toBeNull();
    expect(useReferencePicker.getState().open).toBeTypeOf('function');
    expect(regionProviders().map(p => p.id)).not.toContain('test-state');
    // the persisted preferences aren't reset: tests set them
    expect(usePrefsStore.persist).toBeDefined();
  });
});
