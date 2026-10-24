// Client state that belongs to the user, not to the server: favorite projects, the last tuning experiments,
// which groups of milestones are collapsed. Kept in localStorage.
import { create } from "zustand";
import { persist } from "zustand/middleware";

const empty = {};

export const usePrefsStore = create()(persist(
  set => ({
    // project => true
    favorites: {},
    // Milestones older versions saved in this browser: project => { [milestone key]: milestone }.
    // They move to the user's account when they log in (see useImportLegacyMilestones in src/milestones/hooks.js)
    milestones: {},
    // "mine/tuning/denoiser" => true: groups of milestones the user collapsed in the milestones menus
    milestoneGroupsCollapsed: {},
    // "group/repo" => true (expanded) or false (collapsed): the groups users opened or closed in Explore.
    // Others have their default (src/explore/ExplorePage.jsx)
    exploreGroups: {},
    // project => what's in the tuning form
    tuning: {},
    // "system" (follows the OS), "light" or "dark", see src/theme.js
    theme: 'system',
    // how lists of commits look: "comfortable" (a few lines per commit) or "compact" (one line per commit)
    commitListDensity: 'comfortable',
    // the app's sidebar shows only icons
    siderCollapsed: false,
    // the values the image viewers write on the pixels, when zoomed in: 'image' (their own), 'display' or 'off'
    imagePixelValues: 'image',
    // the view of the image viewers' analysis panel: 'histogram', 'profiles' or 'stats'
    imageAnalysis: 'histogram',
    // ...and what it measures: the displayed values ('display') or the images' own ('image')
    imageAnalysisValues: 'display',
    // project => what users said of the sensor of its raw images: CFA, black level... (see the image viewer's `sensor`)
    imageSensor: {},
    // runs show only the settings of their configuration that not all runs share
    hide_shared_settings: true,
    // project => the last scope users picked on its page: "mine" or "all"
    listScope: {},
    // other emails in users' git config: their commits are theirs too (the server reads it, see backend/mine.py)
    git_emails: [],
    // batch id => {failed, at}: the batches users dismissed from the home page's "Needs attention", with how many
    // runs had failed. They come back if more fail.
    homeDismissed: {},

    toggleFavorite: project => set(state => ({
      favorites: { ...state.favorites, [project]: !state.favorites[project] },
    })),
    forgetLegacyMilestones: projects => set(state => ({
      milestones: Object.fromEntries(Object.entries(state.milestones).filter(([project]) => !projects.includes(project))),
    })),
    toggleMilestoneGroup: path => set(state => {
      const { [path]: collapsed, ...others } = state.milestoneGroupsCollapsed;
      return { milestoneGroupsCollapsed: collapsed ? others : { ...others, [path]: true } };
    }),
    // `default_expanded`: what the group shows without a choice, not remembered: the list only keeps users' choices
    setExploreGroup: (path, expanded, default_expanded) => set(state => {
      const { [path]: _previous, ...others } = state.exploreGroups;
      return { exploreGroups: !!expanded === default_expanded ? others : { ...others, [path]: !!expanded } };
    }),
    setTheme: theme => set({ theme }),
    setSiderCollapsed: collapsed => set({ siderCollapsed: !!collapsed }),
    setImagePixelValues: values => set({ imagePixelValues: values }),
    setImageAnalysis: view => set({ imageAnalysis: view }),
    setImageAnalysisValues: values => set({ imageAnalysisValues: values }),
    setImageSensor: (project, sensor) => set(state => ({ imageSensor: { ...state.imageSensor, [project]: sensor } })),
    setCommitListDensity: density => set({ commitListDensity: density === 'compact' ? 'compact' : 'comfortable' }),
    setGitEmails: emails => set({ git_emails: [...new Set(emails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))] }),
    // `latest`: when the batch last got a run: it comes back if it runs again
    dismissHomeBatch: (id, failed, latest = null, now = Date.now()) => set(state => ({
      // "Needs attention" shows a week: older dismissals can go
      homeDismissed: {
        ...Object.fromEntries(Object.entries(state.homeDismissed ?? {}).filter(([, d]) => now - new Date(d.at).getTime() < 30 * 24 * 3600 * 1000)),
        [id]: { failed, latest, at: new Date(now).toISOString() },
      },
    })),
    setListScope: (project, scope) => set(state => ({ listScope: { ...state.listScope, [project]: scope } })),
    toggleHideSharedSettings: () => set(state => ({ hide_shared_settings: !state.hide_shared_settings })),
    updateTuning: (project, form) => set(state => ({
      tuning: { ...state.tuning, [project]: { ...state.tuning[project], ...form } },
    })),
  }),
  // New preferences don't need a new version: the saved state is merged into the defaults above, so preferences saved
  // before they existed get their default. A new version without a `migrate` function would drop everything users saved.
  { name: 'qaboard-prefs', version: 1 },
));

export const useTuningForm = project => usePrefsStore(state => state.tuning[project] ?? empty);
// whatever was saved, "comfortable" or "compact"
export const useCommitListDensity = () => usePrefsStore(state => state.commitListDensity === 'compact' ? 'compact' : 'comfortable');


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
