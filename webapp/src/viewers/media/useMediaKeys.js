// The keyboard of the "Logged media" section: ←/→ steps, ↑/↓ samples, space new/reference, e evolution strip, f the
// image viewer, ? the section's help, Esc closes. The section takes the focus when users click in it (not on a
// control), so that its keys work without tabbing to a button first.
import { Classes } from "@blueprintjs/core";

import { nextStep, sampleKey } from "./media";

// the app's cheat sheet lists them too (components/HelpSheet.jsx)
export const MEDIA_SHORTCUTS = [
  ['← →', 'previous / next logged step'],
  ['↑ ↓', 'previous / next sample of the key'],
  ['space', 'the reference on top / the new run on top'],
  ['e', 'the sample across the steps (evolution strip)'],
  ['f', 'open the sample in the image viewer'],
  ['Esc', 'close'],
  ['?', 'this help'],
];

const CONTROLS = 'button, a[href], input, textarea, select, label, [role="slider"], [role="button"], [role="menuitem"], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]';
// a dialog or drawer is open (ours, the app's, a viewer's full screen): the keys are its
const modal_open = () => typeof document !== 'undefined' && !!document.querySelector(`.${Classes.DIALOG}, .${Classes.DRAWER}, [aria-modal="true"]`);

// root: the section's element. focus_key, focus_items, focus_sample: what the keys act on (the key and sample users
// are on). Returns the section's props: { tabIndex, onKeyDown, onMouseDown }
export const useMediaKeys = ({ root, steps, step, choose, focus, setFocus, focus_key, focus_items, focus_sample, flip, openHelp, selector }) => {
  const onKeyDown = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // React bubbles events through portals: the popovers and menus of the viewers inside aren't in the section
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    if (modal_open()) return;
    if (e.target.isContentEditable || e.target.closest?.(TYPING)) return;
    // space activates buttons and links, but the thumbnails': on them, it switches new and reference
    if (e.key === ' ' && e.target.closest?.('button:not(.qa-media-thumbnail), a[href], [role="button"], [role="menuitem"], summary')) return;
    // the viewers of the items have their own keys
    const in_viewer = !!e.target.closest?.('.qa-media-viewer');
    const go = action => {
      e.preventDefault();
      // not the app's: "?" would open its cheat sheet too
      e.stopPropagation();
      action();
    };
    if (e.key === '?') return go(openHelp);
    if (in_viewer) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return go(() => choose(nextStep(steps, step, e.key === 'ArrowRight' ? 1 : -1)));
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && focus_items.length > 0) return go(() => {
      const i = focus_items.findIndex(item => sampleKey(item, focus_items) === focus_sample);
      const next = sampleKey(focus_items[Math.max(0, Math.min(focus_items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))], focus_items);
      setFocus({ key: focus_key, sample: next });
      root?.querySelector(`${selector('key', focus_key)} ${selector('sample', next)} button`)?.focus();
    });
    if (e.key === ' ' && focus_key) return go(flip);
    // e and f: the sample whose thumbnail has the focus, else the one users are on
    const thumbnail = e.target.closest?.('[data-sample]');
    const thumbnail_key = thumbnail?.closest('[data-key]')?.dataset.key;
    const [key, sample] = thumbnail && thumbnail_key ? [thumbnail_key, thumbnail.dataset.sample] : [focus_key, focus_sample];
    if (e.key === 'e' && sample) return go(() => setFocus({ key, sample, evolution: !(focus.key === key && focus.sample === sample && focus.evolution) }));
    if (e.key === 'f' && sample) return go(() => setFocus({ key, sample, open: true }));
    if (e.key === 'Escape' && (focus.evolution || focus.open)) return go(() => setFocus({ evolution: false, open: false }));
  };
  // a click in the section, not on a control nor in a viewer, gives it the focus: its keys work
  const onMouseDown = e => {
    if (e.button !== 0 || !(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
    if (e.target.closest(CONTROLS) || e.target.closest('.qa-media-viewer')) return;
    e.currentTarget.focus({ preventScroll: true });
  };
  return { tabIndex: -1, onKeyDown, onMouseDown };
};
