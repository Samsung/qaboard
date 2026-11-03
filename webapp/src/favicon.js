// The tab's icon, with a dot for the status of the runs it shows (see pageTitle.js): yellow while they run, red when
// some failed, green when they finished while the tab was in the background. When tabs get narrow, the icon is all
// that is left of them: the dot tells the tabs apart at a glance. Drawn on a canvas over the site's icon.
// Not animated: a tab bar people look at all day shouldn't blink.
import { useEffect } from 'react'

// Yellow, red and green, like CI status dots (Blueprint's gold, danger and success)
export const badge_colors = { running: '#F0B726', failed: '#CD4246', finished: '#238551' }

const icon_links = () => Array.from(document.querySelectorAll('link[rel~="icon"]'))

// The site's icons, before we drew on them: Map<link, href>
let original_hrefs = null
// {state: data URL}: each badge is drawn once
const drawn = new Map()
let base_image = null

const load_base_image = href => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = href
})

const size = 32
// The dot: in the bottom right corner, with a light ring so it stands out on the icon
export const draw_badge = async (state, href) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  if (!base_image) base_image = load_base_image(href)
  context.drawImage(await base_image, 0, 0, size, size)
  const radius = 7
  const center = size - radius - 1
  context.beginPath()
  context.arc(center, center, radius + 2, 0, 2 * Math.PI)
  context.fillStyle = 'rgba(255, 255, 255, 0.95)'
  context.fill()
  context.beginPath()
  context.arc(center, center, radius, 0, 2 * Math.PI)
  context.fillStyle = badge_colors[state]
  context.fill()
  return canvas.toDataURL('image/png')
}

// The state shown, so that a slow drawing doesn't overwrite a newer state
let shown = null

// Shows the state's dot on the tab's icon, or the plain icon without a state.
// `draw(state, href)` resolves to the icon's URL (tests inject theirs: jsdom has no canvas).
export async function set_favicon_state(state, { draw = draw_badge } = {}) {
  shown = state
  const links = icon_links()
  if (links.length === 0) return
  if (!original_hrefs) original_hrefs = new Map(links.map(link => [link, link.href]))
  const restore = () => links.forEach(link => { if (original_hrefs.has(link)) link.href = original_hrefs.get(link) })
  if (!state || !badge_colors[state]) return restore()
  try {
    if (!drawn.has(state)) {
      // the largest icon: the one with sizes="32x32", else the first
      const base = links.find(link => link.sizes?.contains?.('32x32')) ?? links[0]
      drawn.set(state, await draw(state, original_hrefs.get(base) ?? base.href))
    }
    const url = drawn.get(state)
    if (shown !== state) return
    if (!url) return restore()
    links.forEach(link => { link.href = url })
  } catch {
    restore()
  }
}

// For tests
export const reset_favicon = () => {
  original_hrefs = null
  drawn.clear()
  base_image = null
  shown = null
}

// The dot follows `state` while the component is shown, the plain icon is back when it leaves
export const useFavicon = state => {
  useEffect(() => {
    set_favicon_state(state)
    return () => { set_favicon_state(null) }
  }, [state])
}
