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
