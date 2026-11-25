// Comparing the batches that two commands ran: the snapshots qa and QA-Board save (qaboard/batch_snapshot.py)
import { parse } from "yaml";
import { DateTime } from "luxon";

import { batchEntries } from "./BatchCommands";
import { runSpec } from "./reproduce";


// The snapshot without its first comments (the command, when it started...): they always differ
export function snapshotBody(text) {
  const lines = (text ?? '').split('\n')
  let start = 0
  while (start < lines.length && (lines[start].startsWith('#') || !lines[start].trim())) start++
  return lines.slice(start).join('\n')
}

// JSON with sorted keys: the same definitions compare equal whatever the order of their keys
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
  : v)

function compare(before = {}, after = {}) {
  const added = Object.keys(after).filter(k => !(k in before))
  const removed = Object.keys(before).filter(k => !(k in after))
  const changed = Object.keys(after).filter(k => k in before && stable(before[k]) !== stable(after[k]))
  return { added, removed, changed }
}

/**
 * What changed between the batches of two snapshots: {batches: {added, removed, changed}, aliases: {...}, same, error?}
 */
export function batchesChanges(before_yaml, after_yaml) {
  let before, after
  try {
    before = parse(before_yaml ?? '') ?? {}
    after = parse(after_yaml ?? '') ?? {}
  } catch (error) {
    return { error: error.message, same: false }
  }
  const { aliases: before_aliases, ...before_batches } = before
  const { aliases: after_aliases, ...after_batches } = after
  const batches = compare(before_batches, after_batches)
  const aliases = compare(before_aliases ?? {}, after_aliases ?? {})
  const same = [batches, aliases].every(c => !c.added.length && !c.removed.length && !c.changed.length)
  return { batches, aliases, same }
}

// "low-light changed, smoke added, 1 alias changed"
export function changesSummary(changes) {
  if (changes.error) return `Could not compare: ${changes.error}`
  if (changes.same) return 'Same batches'
  const list = names => names.length > 3 ? `${names.length} batches` : names.join(', ')
  const parts = []
  const { batches, aliases } = changes
  if (batches.changed.length) parts.push(`${list(batches.changed)} changed`)
  if (batches.added.length) parts.push(`${list(batches.added)} added`)
  if (batches.removed.length) parts.push(`${list(batches.removed)} removed`)
  const n_aliases = aliases.added.length + aliases.removed.length + aliases.changed.length
  if (n_aliases) parts.push(`${n_aliases} alias${n_aliases === 1 ? '' : 'es'} changed`)
  return parts.join(', ')
}


/**
 * The commands of a batch whose batches QA-Board saved, most recent first: [{key, label, snapshot}].
 * `side`: what to call the batch, e.g. "this batch" or "reference".
 */
export function snapshotOptions(batch, side) {
  if (!batch) return []
  return batchEntries(batch)
    .map(entry => ({ entry, snapshot: runSpec(entry, batch).snapshot }))
    .filter(({ snapshot }) => !!snapshot)
    .map(({ entry, snapshot }) => {
      const iso = entry.kind === 'submission' ? entry.submission.created_at : entry.command.command_created_at_datetime
      const date = DateTime.fromISO(iso ?? '', { zone: 'utc' })
      const user = entry.kind === 'submission' ? entry.submission.user : entry.command.user
      const where = entry.kind === 'submission' ? 'from QA-Board' : entry.command.job_url ? 'CI' : 'terminal'
      return {
        key: `${batch.id}:${entry.id}`,
        label: `${side}: ${batch.label} · ${where}${user ? ` by ${user}` : ''}${date.isValid ? ` · ${date.toRelative()}` : ''}`,
        snapshot,
      }
    })
}
