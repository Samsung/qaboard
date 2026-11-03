// Copying text to the clipboard. Kept light: the file browser uses it too.
import copy from 'copy-to-clipboard'
import { Intent } from '@blueprintjs/core'

import { toaster } from '../toaster'


// navigator.clipboard only exists in secure contexts (https, localhost), but QA-Board is also served over http
// (e.g. http://qaboard on an intranet): there we fall back to copy-to-clipboard. Resolves to whether we could copy.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // e.g. the page doesn't have the focus
    }
  }
  return copy(text, { format: 'text/plain' })
}


// Copies, then says so in a toast: "Copied {what}" or "Could not copy {what}".
// Other toast props (message, timeout, action...) customize the success toast.
// The clipboard holds one thing: by default all copies share a toast, repeated copies update it instead of stacking.
export async function copyWithToast(text, { what, key = 'copy', ...toast } = {}) {
  const copied = await copyText(text)
  toaster.show(copied
    ? { message: what ? `Copied ${what}` : 'Copied', icon: 'tick', intent: Intent.SUCCESS, timeout: 2000, ...toast }
    : { message: what ? `Could not copy ${what}` : 'Could not copy', icon: 'error', intent: Intent.DANGER },
  key)
  return copied
}


const escape_html = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// A link as chats and documents paste it: the link with its text, then the details as plain text
export const link_html = ({ url, text, details }) =>
  `<a href="${escape_html(url)}">${escape_html(text)}</a>${details ? `: ${escape_html(details)}` : ''}`

// Copies HTML, with a plain-text version for the places that don't take HTML. Resolves to whether we could copy.
// Over http, where navigator.clipboard doesn't exist, we select a hidden element and copy it with our own data.
export async function copyHtml(html, text) {
  if (navigator.clipboard?.write && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })])
      return true
    } catch {
      // e.g. the page doesn't have the focus
    }
  }
  const mark = document.createElement('span')
  mark.textContent = text
  mark.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none; user-select: text;'
  const on_copy = event => {
    event.stopPropagation()
    event.preventDefault()
    event.clipboardData.clearData()
    event.clipboardData.setData('text/html', html)
    event.clipboardData.setData('text/plain', text)
  }
  document.body.appendChild(mark)
  const selection = window.getSelection()
  const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection.getRangeAt(i))
  try {
    const range = document.createRange()
    range.selectNodeContents(mark)
    selection?.removeAllRanges()
    selection?.addRange(range)
    mark.addEventListener('copy', on_copy)
    return !!document.execCommand?.('copy')
  } catch {
    return false
  } finally {
    mark.removeEventListener('copy', on_copy)
    mark.remove()
    selection?.removeAllRanges()
    ranges.forEach(range => selection.addRange(range))
  }
}

// Copies a link to the page that pastes as its name in Teams, Outlook or Confluence ("ISP v2 vs baseline · isp"),
// and as the URL in plain-text places. Says so in a toast.
//   url: the page's, by default the current one; text: what the link says; details: a few words after it
export async function copyLink({ url = window.location.href, text, details } = {}, { what = 'the link', ...toast } = {}) {
  const copied = await copyHtml(link_html({ url, text, details }), url)
  toaster.show(copied
    ? { message: `Copied ${what}: it pastes as “${text}”`, icon: 'tick', intent: Intent.SUCCESS, timeout: 4000, ...toast }
    : { message: `Could not copy ${what}`, icon: 'error', intent: Intent.DANGER },
  'copy')
  return copied
}
