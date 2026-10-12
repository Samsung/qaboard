import copy from 'copy-to-clipboard'


// navigator.clipboard only exists in secure contexts (https, localhost), but QA-Board is also served over http
// (e.g. http://qa): there we fall back to copy-to-clipboard. Resolves to whether we could copy.
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
