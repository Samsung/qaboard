// Which run's reference picker is open (src/matching/ReferenceMatchTag.jsx): from its tag on the run card, or the
// run's menu ("Compare with another reference run…"). One at a time.
import { create } from "zustand";

export const useReferencePicker = create(set => ({
  open_for: null,
  open: id => set({ open_for: String(id) }),
  close: () => set({ open_for: null }),
}));
