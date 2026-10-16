// Viewers that show the same scene stay in sync: zoom, pan, and where the pointer is.
//
// Viewers join a group by key (the `syncKey` prop). A viewport is OpenSeadragon's: { zoom, center }, in viewport
// coordinates, where x goes from 0 to 1 across the image's width. The same viewport shows the same region of any
// image with the same aspect ratio, whatever its size: the viewer adds the aspect ratio to the key.
//
// The viewer that users move leads, the others follow. Viewers off-screen don't follow right away: they catch up
// when they show (see `viewport()`), else scrolling a page with many viewers would redraw all of them.

const groups = new Map();

// member: { setViewport(viewport), setPointer(point | null) }
export const joinSyncGroup = (key, member) => {
  let group = groups.get(key);
  if (!group) {
    group = { members: new Set(), viewport: null, leader: null };
    groups.set(key, group);
  }
  group.members.add(member);
  let left = false;
  return {
    // The group's viewport, e.g. for a viewer that shows up late. null until a viewer moves.
    viewport: () => group.viewport,
    // This viewer is the one users move
    lead: () => {
      group.leader = member;
    },
    leads: () => group.leader === member,
    // This viewer's viewport changed. Only the leader's changes are followed.
    publish: viewport => {
      if (left || group.leader !== member) return;
      group.viewport = viewport;
      for (const other of group.members)
        if (other !== member) other.setViewport(viewport);
    },
    // Where the pointer is, in viewport coordinates, or null when it left
    pointer: point => {
      if (left) return;
      for (const other of group.members)
        if (other !== member) other.setPointer(point);
    },
    leave: () => {
      if (left) return;
      left = true;
      group.members.delete(member);
      if (group.leader === member) group.leader = null;
      // The next viewers start from the whole image
      if (group.members.size === 0) groups.delete(key);
    },
  };
};

// The key of the group of a viewer, given the key the app chose and the size of the image
export const syncGroupKey = (key, width, height) =>
  (key === null || key === undefined || !width || !height) ? null : `${key}@${(height / width).toFixed(3)}`;


// What to do with the viewport when a viewer gets a new image, e.g. when the app picks another file to show.
// previous: { zoom, center, width, height } before the change (null for the first image), next: { width, height }
// - null: like the first image: the whole image, or the selected region
// - { action: 'keep', zoom, center }: the same aspect ratio, same size or not (e.g. a half-resolution version):
//   keep showing the region users were looking at
// - { action: 'refit' }: another aspect ratio: the region doesn't map to the new image, show the selected region again
export const viewportAfterImageChange = (previous, next) => {
  if (!previous || !next?.width || !next?.height || !previous.width || !previous.height)
    return null;
  if (Math.abs(previous.height / previous.width - next.height / next.width) < 1e-3)
    return { action: 'keep', zoom: previous.zoom, center: previous.center };
  return { action: 'refit' };
};
