// How to run a `qa batch` again: its command, the snapshot of the batches it ran (qaboard/batch_snapshot.py),
// the commands to run it again from a terminal, and what to fill in Run Tests / Tuning.


// Like Python's shlex.quote
export const shellQuote = text => {
  const value = String(text)
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export const shellJoin = args => args.map(shellQuote).join(' ')


// `/home/alice/.venv/bin/qa --share batch x` => `qa --share batch x`: what people type
export function commandText(argv) {
  if (!argv?.length) return ''
  const [program, ...args] = argv
  const name = String(program).split(/[/\\]/).pop()
  const qa = /^qa(\.exe)?$/i.test(name) || /^__main__\.py$/.test(name)
  return shellJoin([qa ? 'qa' : program, ...args])
}


// A file name for the snapshot, e.g. batches.nightly-check.yaml
export const snapshotFileName = label => {
  const name = String(label ?? '').replace(/^@[^|]*\|\s*/, '').replace(/[^\w.@=-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
  return name ? `batches.${name}.yaml` : 'batches.yaml'
}

// batches started from a computer are labeled "@alice| label": the label people chose
export const rawLabel = label => String(label ?? '').replace(/^@[^|]*\|\s*/, '')


/**
 * What we know about how a `qa batch` started, to run it again.
 * `entry`: {kind: 'submission', submission} (started from QA-Board) or {kind: 'command', id, command} (a terminal, the CI).
 * Returns {label, names (the batches as given), platform, tuning_search, overwrite, snapshot: {batches, aliases, files,
 * inputs, yaml?, url?} or null, argv (what was typed), search_type}.
 */
export function runSpec(entry, batch) {
  const label = rawLabel(batch?.label)
  if (entry.kind === 'submission') {
    const { submission } = entry
    const request = submission.request ?? {}
    const names = Array.isArray(request.selected_group) ? request.selected_group
      : request.selected_group ? [request.selected_group]
      : (submission.batch ?? '').split(' ').filter(Boolean)
    const snapshot = submission.batches_snapshot
    return {
      label,
      names,
      platform: request.platform ?? null,
      tuning_search: request.tuning_search ?? null,
      overwrite: request.overwrite ?? null,
      snapshot: snapshot && submission.log_dir_url ? { ...snapshot, url: `${submission.log_dir_url}/${snapshot.path ?? 'batches.yaml'}` } : null,
      argv: null,
      search_type: request.tuning_search?.search_type ?? (/ optimize /.test(submission.command ?? '') ? 'optimize' : 'grid'),
    }
  }
  const { command } = entry
  const snapshot = command.batches_snapshot
  return {
    label,
    names: snapshot?.names ?? [],
    platform: command.platform ?? null,
    tuning_search: command.tuning_search ?? null,
    overwrite: null,
    // without its YAML (too large, or not saved) we can't run it again as it ran
    snapshot: snapshot?.yaml ? snapshot : null,
    snapshot_error: snapshot?.error ?? (snapshot?.too_large ? `The batches were too large to save (${Math.round(snapshot.too_large / 1024)} kB).` : null),
    argv: command.argv ?? null,
    search_type: (command.argv ?? []).includes('optimize') ? 'optimize' : 'grid',
  }
}

/**
 * The commands to run it again from a terminal, with the snapshot saved as `file`:
 * - local: in a checkout of the commit, like it was started
 * - server: QA-Board runs it on the commit, from its artifacts (`qa batch --commit`)
 */
export function terminalCommands(spec, { file, commit_id, label }) {
  const names = spec.names
  const tuning = spec.tuning_search && spec.search_type !== 'optimize' && Object.keys(spec.tuning_search.parameter_search ?? {}).length
    ? ['--tuning-search', JSON.stringify(spec.tuning_search)] : []
  const platform = spec.platform ? ['--platform', spec.platform] : []
  let local
  if (spec.argv && !spec.snapshot?.reproduce) {
    // started before qa saved the batches: what was typed
    local = commandText(spec.argv)
  } else if (spec.argv) {
    local = shellJoin(spec.snapshot.reproduce.map(arg => arg === 'batches.yaml' ? file : arg))
  } else if (names.length) {
    local = shellJoin(['qa', '--label', label, ...platform, 'batch', '--batches-file', file, ...names, ...tuning])
  }
  const server = names.length && commit_id && spec.search_type !== 'optimize'
    ? shellJoin(['qa', '--label', label, ...platform, 'batch', '--commit', String(commit_id).slice(0, 10), '--batches-file', file, ...names, ...tuning])
    : null
  return { local: local ?? null, server }
}


/**
 * What Run Tests / Tuning is filled with, to start it again from QA-Board with the snapshot of the batches.
 * Several batches: the form selects one name, we send an alias for them in a second file.
 */
export function formPrefill(spec, { yaml, label, created_at }) {
  const names = spec.names
  const files = [{ path: snapshotFileName(spec.label), content: yaml }]
  let selected_group = names[0] ?? ''
  if (names.length > 1) {
    selected_group = `${label}-batches`
    files.push({ path: 'run-again.yaml', content: `# The batches ${spec.label} ran, together\naliases:\n  ${JSON.stringify(selected_group)}: ${JSON.stringify(names)}\n` })
  }
  const prefill = {
    experiment_name: label,
    selected_group,
    batches_snapshot: { from: spec.label, created_at: created_at ?? null, files, names },
  }
  if (spec.platform) prefill.platform = spec.platform
  if (typeof spec.overwrite === 'boolean') prefill.overwrite = spec.overwrite
  if (spec.search_type === 'optimize' && typeof spec.tuning_search?.parameter_search === 'string') {
    prefill.search_type = 'optimize'
    prefill.parameter_search_auto = spec.tuning_search.parameter_search
  } else {
    prefill.search_type = spec.tuning_search?.search_type === 'sampler' ? 'sampler' : 'grid'
    const parameter_search = spec.tuning_search?.parameter_search
    prefill.parameter_search = parameter_search && Object.keys(parameter_search).length ? JSON.stringify(parameter_search, null, 2) : '{}'
    if (spec.tuning_search?.search_options && Object.keys(spec.tuning_search.search_options).length)
      prefill.search_options = spec.tuning_search.search_options
  }
  return prefill
}

// A new label for the batch that runs it again: label-again, label-again-2...
export function againLabel(label, existing = []) {
  const base = `${rawLabel(label)}-again`
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}
