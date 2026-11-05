// The region set shown is the same for the viewers of a visualization, e.g. where the images differ. Searches (sets
// found on demand) are opt-in on each page: on the next, they'd compare the images of all its runs again.
// Its own module: the export reads which sets the viewers show, without loading the image viewer.
import { create } from 'zustand';

export const useRegionSetStore = create(set => ({
  // { [path]: { id, page } }
  by_path: {},
  set: (path, id, page) => set(state => ({ by_path: { ...state.by_path, [path]: { id, page } } })),
}));
