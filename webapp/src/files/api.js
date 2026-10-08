// What the file browser asks the server
import { urlFromPath } from "./logic";

export class FilesError extends Error {
  constructor(status, reason, message) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

const readError = async response => {
  try {
    const data = await response.json()
    return new FilesError(response.status, data.reason, data.error)
  } catch {
    return new FilesError(response.status, null, null)
  }
}

// Why the server refuses to show a path: {status, reason, message}, or null if the user can read it.
// We need it when nginx refuses, and answers with this page instead of the backend's JSON errors.
export const fetchAccess = async path => {
  const response = await fetch(`/api/v1/files/authorize?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
  if (response.ok) return null
  return readError(response)
}

// The content of a folder: {path, entries: [{name, type, size, mtime, owner, mode, link, broken}], truncated}
export const fetchListing = async (path, { signal } = {}) => {
  const response = await fetch(urlFromPath(path.endsWith('/') ? path : `${path}/`), {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    // The page has the same URL: if browsers cache the JSON, Back (e.g. after opening a file) shows it instead of the page
    cache: 'no-store',
    signal,
  })
  const isJson = (response.headers.get('Content-Type') ?? '').includes('application/json')
  if (response.ok && isJson)
    return response.json()
  if (isJson)
    throw await readError(response)
  // e.g. nginx refused before asking the backend (sign in, "deny all"...)
  if (response.status === 401 || response.status === 403) {
    const error = await fetchAccess(path).catch(() => null)
    if (error) throw error
    throw new FilesError(response.status, 'nginx', "The server doesn't allow you to see this folder.")
  }
  if (response.status === 404)
    throw new FilesError(404, 'not-found', `${path} doesn't exist (yet, or anymore).`)
  throw new FilesError(response.status, 'server', `The server failed to list this folder (HTTP ${response.status}). Is the backend running?`)
}

export const fetchJson = async url => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new FilesError(response.status, null, `${url}: HTTP ${response.status}`)
  return response.json()
}

export const signIn = async (username, password) => {
  const form = new FormData()
  form.append('username', username)
  form.append('password', password)
  const response = await fetch('/api/v1/user/auth/', { method: 'POST', body: form, credentials: 'same-origin' })
  if (!response.ok) throw await readError(response)
  return response.json()
}

export const signOut = () => fetch('/api/v1/user/logout/', { method: 'POST', credentials: 'same-origin' })

// The run whose output folder is `path` or contains it: {id, folder, is_failed, is_pending, is_running, input, batch, url...}, or null
export const fetchRun = async (path, { signal } = {}) => {
  const response = await fetch(`/api/v1/files/run?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', signal })
  if (!response.ok) return null
  return (await response.json()).run ?? null
}

// Redo, mark as failed or delete a run, with the same API as the web app
const RUN_ACTIONS = {
  redo: id => [`/api/v1/output/redo/${id}/`, 'POST', {}],
  'mark-failed': id => [`/api/v1/output/${id}/`, 'PUT', { is_pending: false, is_running: false, is_failed: true }],
  delete: id => [`/api/v1/output/${id}/`, 'DELETE'],
  'delete-files': id => [`/api/v1/output/${id}/?soft=true`, 'DELETE'],
}

export const runAction = async (action, id) => {
  const [url, method, body] = RUN_ACTIONS[action](id)
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw await readError(response)
}
