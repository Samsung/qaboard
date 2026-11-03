// What browser tabs say about the page, and what their icon shows about the runs (see favicon.js).
//
// Titles read "[status] subject · section · project": the most distinctive part first, since tabs truncate from the
// right and the browser's tab search matches their start. Only what users chose names a tab: the names they gave the
// results, their milestone, the batch, the commit. Switching views or filters doesn't rename it, except for the views
// people keep open on purpose (Logs, Tuning Analysis), named after the subject.
// The status comes first, only while there is something to say:
//   12/40 ISP v2 vs baseline · isp     runs still pending or running: how many are done
//   3✕ ISP v2 vs baseline · isp        finished, 3 runs failed
//   ✓ ISP v2 vs baseline · isp         finished while the tab was in the background, until users look at it
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useComparison } from './hooks'
import { commitSummaryQuery } from './api/queries'
import { batchSubmissions } from './components/logs/submissions'
import { pretty_label } from './utils'
import { useFavicon } from './favicon'


export const APP_NAME = 'QA-Board'

// "isp" for "group/isp"
export const project_name = project => (project ?? '').split('/').filter(Boolean).slice(-1)[0] ?? ''

// Joins the parts of a title, without the empty ones
export const join_title = (...parts) => parts.filter(part => part !== undefined && part !== null && part !== '' && part !== false).join(' · ')

// The app's own pages: "Profile · Settings · QA-Board"
export const app_title = (...parts) => join_title(...parts, APP_NAME)

// Commit lists: the branch, else whose commits, else the project's
export const list_title = ({ project, branch, committer }) => join_title(branch || (committer ? `${committer}'s commits` : 'Commits'), project_name(project))

export const history_title = ({ project, branch }) => join_title(branch ? `History of ${branch}` : 'History', project_name(project))

// The views that are destinations: people open them in their own tab, so the tab says so (after the subject)
const sections = [['logs', 'Logs'], ['optimization', 'Tuning Analysis'], ['tuning', 'Run Tests / Tuning'], ['groups', 'Available Tests']]

export const short_id = commit_id => (commit_id ?? '').slice(0, 8)

// The commit page: what users named the results (or their milestones), else the batch, else the commit.
//   name_new, name_ref: what the new results and the reference are called, null when nobody named them
export const commit_title = ({ project, name_new, name_ref, commit_id, branch, batch, views = [], prefix = '' }) => {
  const sha = short_id(commit_id)
  const batch_name = batch && batch.label && batch.label !== 'default' ? pretty_label(batch).trim() : null
  let subject
  if (name_new) subject = name_ref ? `${name_new} vs ${name_ref}` : name_new
  else if (name_ref) subject = `${sha || 'commit'} vs ${name_ref}`
  else if (batch_name) subject = sha ? `${batch_name} on ${sha}` : batch_name
  else subject = [sha, branch].filter(Boolean).join(' ') || 'Commit'
  const section = sections.find(([view]) => views.includes(view))?.[1]
  return `${prefix}${join_title(subject, section, project_name(project))}`
}


// The runs of a batch, for the tab's status. null when there is nothing to say (no runs).
//   starting: `qa batch` was started from QA-Board and hasn't submitted runs yet
//   failed_to_start: it failed before submitting any
export const runs_status = batch => {
  if (!batch) return null
  const pending = batch.pending_outputs ?? 0
  const running = batch.running_outputs ?? 0
  const failed = batch.failed_outputs ?? 0
  const valid = batch.valid_outputs ?? 0
  const total = valid + failed + pending
  const submission = batchSubmissions(batch)[0]
  const starting = pending === 0 && submission?.status === 'submitting'
  const failed_to_start = total === 0 && submission?.status === 'failed'
  if (total === 0 && !starting && !failed_to_start) return null
  return { pending, running, failed, done: valid + failed, total, starting, failed_to_start }
}

// What the tab shows about the runs: {prefix, state}, state is 'running' | 'failed' | 'finished' | null.
//   unseen: the runs finished while the tab was in the background, and nobody looked at it since
export const status_badge = (status, { unseen = false } = {}) => {
  if (!status) return { prefix: '', state: null }
  if (status.failed_to_start) return { prefix: '✕ ', state: 'failed' }
  if (status.starting) return { prefix: '', state: 'running' }
  // failures show first, like in the sidebar: red while the others still run
  if (status.pending > 0) return { prefix: `${status.done}/${status.total} `, state: status.failed > 0 ? 'failed' : 'running' }
  if (status.failed > 0) return { prefix: `${status.failed}✕ `, state: 'failed' }
  return unseen ? { prefix: '✓ ', state: 'finished' } : { prefix: '', state: null }
}

// "40 runs: 37 passed, 3 failed", "12 of 40 runs done, 2 failed"... for link previews. '' without runs.
export const runs_summary = status => {
  if (!status) return ''
  if (status.failed_to_start) return 'failed to start'
  if (status.starting) return 'starting'
  const runs = n => `${n} run${n === 1 ? '' : 's'}`
  const failed = status.failed > 0 ? `, ${status.failed} failed` : ''
  if (status.pending > 0) return `${status.done} of ${runs(status.total)} done${failed}`
  const passed = status.total - status.failed
  return `${runs(status.total)}: ${passed} passed${failed}`
}


// Sets the tab's title. Every page calls it: a page that doesn't keeps the title of the previous one.
export const usePageTitle = title => {
  useEffect(() => {
    if (title) document.title = title
  }, [title])
}


const subscribe_visibility = callback => {
  document.addEventListener('visibilitychange', callback)
  return () => document.removeEventListener('visibilitychange', callback)
}
const is_hidden = () => document.visibilityState === 'hidden'
export const useDocumentHidden = () => useSyncExternalStore(subscribe_visibility, is_hidden, () => false)

// Whether the runs of `key` finished while the tab was in the background, until users look at the tab again.
//   key: what the tab shows (project, commit, batch), pending: whether runs are still pending
export const useFinishedUnseen = ({ key, pending }) => {
  const hidden = useDocumentHidden()
  // the key whose runs finished unseen, and what we knew of the pending runs: [key, pending]
  const [finished, setFinished] = useState(null)
  const [known, setKnown] = useState([key, pending])
  if (known[0] !== key || known[1] !== pending) {
    setKnown([key, pending])
    if (known[0] === key && known[1] === true && pending === false && hidden) setFinished(key)
  }
  if (finished !== null && !hidden) setFinished(null)
  return finished === key
}


// The pieces of the commit page's title, from the comparison: what users named, the batch, the commit...
// `side.label` is what users called the results, else their milestone's name, else "new" or "ref 2"
const name_of = side => side && (side.milestone || side.label !== side.default_label) ? side.label : null

export const useCommitTitleParts = () => {
  const { project, selected, new_commit, new_batch, selected_views, compared } = useComparison()
  const [new_side, ref_side] = compared ?? []
  const commit_id = new_commit?.id ?? selected.new_commit_id
  return {
    project, commit_id,
    name_new: name_of(new_side), name_ref: name_of(ref_side),
    branch: new_commit?.branch, batch: new_batch, views: selected_views ?? [],
    message: (new_commit?.message ?? '').split('\n')[0].trim(),
  }
}

// Background tabs stop polling the commit (each refresh downloads all its outputs). While runs are pending and the
// tab is hidden, we poll its summary instead (the batches' counts, without outputs), and refresh the commit once
// they are done, or when users come back to the tab.
const background_interval = 30 * 1000
const useBackgroundBatch = ({ project, commit_id, batch_label, pending }) => {
  const hidden = useDocumentHidden()
  const queryClient = useQueryClient()
  const enabled = hidden && pending && !!project && !!commit_id
  const { data, dataUpdatedAt } = useQuery({
    ...commitSummaryQuery({ project, id: commit_id }),
    enabled,
    refetchInterval: enabled ? background_interval : false,
    refetchIntervalInBackground: true,
  })
  const batch = enabled ? data?.batches?.[batch_label] : undefined
  const finished = !!batch && !(batch.pending_outputs > 0)
  // The commit's own queries, with whatever branch or batch they were fetched with
  useEffect(() => {
    if (finished) queryClient.invalidateQueries({ queryKey: ['commit', project, commit_id] })
  }, [finished, project, commit_id, queryClient])
  // Back to the tab: the commit catches up with what the summary saw while it was hidden, once per summary
  const [summary_at, setSummaryAt] = useState(0)
  if (enabled && dataUpdatedAt !== summary_at) setSummaryAt(dataUpdatedAt)
  const caught_up = useRef(0)
  useEffect(() => {
    if (hidden || !summary_at || caught_up.current === summary_at) return
    caught_up.current = summary_at
    queryClient.invalidateQueries({ queryKey: ['commit', project, commit_id] })
  }, [hidden, summary_at, project, commit_id, queryClient])
  return batch
}

// The commit page's tab: its title with the runs' status, and the status in its icon.
export const useCommitTab = () => {
  const parts = useCommitTitleParts()
  const { project, commit_id, batch } = parts
  const own_status = runs_status(batch)
  const background = useBackgroundBatch({ project, commit_id, batch_label: batch?.label, pending: !!own_status && (own_status.pending > 0 || own_status.starting) })
  const status = background ? runs_status({ ...batch, ...background }) : own_status
  const key = `${project}|${commit_id}|${batch?.label}`
  const unseen = useFinishedUnseen({ key, pending: !!status && (status.pending > 0 || status.starting) })
  const { prefix, state } = status_badge(status, { unseen })
  usePageTitle(commit_id ? commit_title({ ...parts, prefix }) : null)
  useFavicon(state)
}
