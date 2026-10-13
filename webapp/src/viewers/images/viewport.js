// Keeping the image viewers' viewport (zoom and center) when the image they show changes,
// e.g. when a Dynamic Option (a slider over an ISP's stages...) picks another file of the same output.
//
// OpenSeadragon's viewport coordinates are relative to the image's width: x goes from 0 to 1, y from 0 to height/width.
// The same zoom and center show the same region of any image with the same aspect ratio, whatever its size.


// The viewport of a viewer, with the size of the image it shows, or null if it doesn't show any image yet.
export const capture_viewport = (viewer, width, height) => {
  if (!viewer?.viewport || !viewer.world || viewer.world.getItemCount() === 0 || !width || !height)
    return null
  return {
    zoom: viewer.viewport.getZoom(),
    center: viewer.viewport.getCenter(),
    width,
    height,
  }
}


const same_aspect_ratio = (a, b) => Math.abs(a.height / a.width - b.height / b.width) < 1e-3


// What to do with the viewport when a viewer gets a new image of size {width, height}, given the viewport
// captured before the change (null on the first image):
// - null: nothing special, like the first time an image shows (the whole image, then the selected ROI preset)
// - {action: 'keep', zoom, center}: the same aspect ratio, same size or not (e.g. a half-resolution stage): keep the
//   region the user was looking at, which the ROI presets would also give (they're scaled to the image's size)
// - {action: 'refit'}: another aspect ratio, the region doesn't map to the new image: apply the selected ROI
//   preset again (scaled to the new image), or show the whole image
export const viewport_after_image_change = (previous, next) => {
  if (!previous || !next?.width || !next?.height)
    return null
  if (same_aspect_ratio(previous, next))
    return { action: 'keep', zoom: previous.zoom, center: previous.center }
  return { action: 'refit' }
}


// The size of a viewer's container if OpenSeadragon's viewport doesn't know it yet, else null.
// While the reference is the same image as new, its viewer is hidden (display: none) and OpenSeadragon sees a 1x1
// container. When it shows again, OpenSeadragon keeps the bounds it had in that 1x1 square: it zooms out, and leads
// the synced viewers there. Callers resize the viewport themselves first, and align it to the other viewer.
export const unsized_container = viewer => {
  if (!viewer?.viewport || !viewer.container)
    return null
  const { clientWidth, clientHeight } = viewer.container
  if (!clientWidth || !clientHeight) // still hidden
    return null
  const { x, y } = viewer.viewport.getContainerSize()
  if (x === clientWidth && y === clientHeight)
    return null
  return { x: clientWidth, y: clientHeight }
}
