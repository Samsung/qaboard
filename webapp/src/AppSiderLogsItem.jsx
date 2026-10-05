import { Intent, MenuItem, Tag } from "@blueprintjs/core";

import { batchSubmissions } from "./components/logs/submissions";


const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * What the sidebar's "Logs" entry says about the batch: failures first, then runs in progress.
 * Uses only the batch we already have, the sidebar doesn't fetch anything.
 * Returns null when there is nothing to say, or {intent, tag, title}.
 */
export function logsHint(batch) {
  if (!batch) return null
  const failed = batch.failed_outputs ?? 0
  const running = batch.running_outputs ?? 0
  // pending_outputs includes the running outputs
  const pending = Math.max((batch.pending_outputs ?? 0) - running, 0)
  // For batches started from QA-Board, the backend knows when `qa batch` failed to submit
  const submission = batchSubmissions(batch)[0]
  const submission_failed = submission?.status === 'failed'

  if (failed > 0 || submission_failed) {
    const reasons = [
      failed > 0 && `${plural(failed, 'run')} failed`,
      submission_failed && `qa batch failed`,
    ].filter(Boolean)
    return {
      intent: Intent.DANGER,
      tag: failed > 0 ? `${failed} failed` : 'failed',
      title: `${reasons.join(' and ')}: see why in the logs`,
    }
  }

  if (running > 0 || pending > 0 || submission?.status === 'submitting') {
    const states = [
      running > 0 && `${running} running`,
      pending > 0 && `${pending} pending`,
    ].filter(Boolean)
    return {
      intent: Intent.NONE,
      tag: states[0] ?? 'starting',
      title: states.length ? `${plural(running + pending, 'run')} in progress (${states.join(', ')}): follow them in the logs` : 'qa batch is starting: follow it in the logs',
    }
  }
  return null
}


// The label's class, AppSider un-dims it (the sidebar dims menu item labels)
export const logs_hint_class = 'qa-logs-hint'

export function LogsMenuItem({ batch, ...props }) {
  const hint = logsHint(batch)
  const is_danger = hint?.intent === Intent.DANGER
  return <MenuItem
    icon="console"
    text="Logs"
    intent={is_danger ? Intent.DANGER : undefined}
    title={hint?.title}
    labelClassName={hint ? logs_hint_class : undefined}
    labelElement={hint && <Tag round minimal={!is_danger} intent={hint.intent}>{hint.tag}</Tag>}
    {...props}
  />
}
