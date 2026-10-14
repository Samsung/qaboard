// Client state that belongs to the user, not to the server: favorite projects, private milestones,
// the last tuning experiments. Kept in localStorage.
import { create } from "zustand";
import { persist } from "zustand/middleware";

const empty = {};

export const usePrefsStore = create()(persist(
  set => ({
    // project => true
    favorites: {},
    // project => { [milestone key]: milestone }
    milestones: {},
    // project => what's in the tuning form
    tuning: {},

    toggleFavorite: project => set(state => ({
      favorites: { ...state.favorites, [project]: !state.favorites[project] },
    })),
    setMilestone: (project, key, milestone) => set(state => ({
      milestones: { ...state.milestones, [project]: { ...state.milestones[project], [key]: milestone } },
    })),
    deleteMilestone: (project, key) => set(state => {
      const { [key]: _deleted, ...milestones } = state.milestones[project] ?? {};
      return { milestones: { ...state.milestones, [project]: milestones } };
    }),
    updateTuning: (project, form) => set(state => ({
      tuning: { ...state.tuning, [project]: { ...state.tuning[project], ...form } },
    })),
  }),
  { name: 'qaboard-prefs', version: 1 },
));

export const usePrivateMilestones = project => usePrefsStore(state => state.milestones[project] ?? empty);
export const useTuningForm = project => usePrefsStore(state => state.tuning[project] ?? empty);


// Until October 2026 those preferences were saved by redux-persist, in IndexedDB via localForage.
// We move them over once, then delete the old data: it also cached all the projects.
export async function migrateFromReduxPersist() {
  const flag = 'qaboard-prefs-migrated';
  try {
    if (localStorage.getItem(flag)) return;
    // Without the old database (new users, other browsers), there is nothing to migrate
    const databases = await indexedDB.databases?.();
    if (databases && !databases.some(db => db.name === 'localforage')) {
      localStorage.setItem(flag, '1');
      return;
    }
    const { default: localforage } = await import("localforage");
    const raw = await localforage.getItem('persist:root');
    if (raw) {
      const root = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const parse = slice => typeof slice === 'string' ? JSON.parse(slice) : slice;
      const projects = parse(root.projects)?.data ?? {};
      const tuning = parse(root.tuning) ?? {};
      const favorites = {};
      const milestones = {};
      for (const [project, data] of Object.entries(projects)) {
        if (data?.is_favorite) favorites[project] = true;
        if (data?.milestones && Object.keys(data.milestones).length > 0) milestones[project] = data.milestones;
      }
      usePrefsStore.setState(state => ({
        favorites: { ...favorites, ...state.favorites },
        milestones: { ...milestones, ...state.milestones },
        tuning: { ...tuning, ...state.tuning },
      }));
    }
    localStorage.setItem(flag, '1');
    if (raw) await localforage.removeItem('persist:root');
  } catch (error) {
    console.warn('Could not migrate preferences from the previous version', error);
  }
}
