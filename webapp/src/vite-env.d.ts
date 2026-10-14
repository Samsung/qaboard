/// <reference types="vite/client" />

// The release notes, from website/release-notes/ (see releaseNotes.js)
declare module "virtual:release-notes" {
  const bundle: { notes: Array<Record<string, unknown>> };
  export default bundle;
}
