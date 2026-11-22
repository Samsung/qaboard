// The sidebar's "Local changes": the distinct code states the batch's runs ran, with how many runs each.
import { useState } from "react";
import { Button, Classes, HTMLTable, NonIdealState, Tag } from "@blueprintjs/core";

import { updateSelected } from "../../hooks";
import { LocalChangesDialogLoader } from "./LocalChangesTag";
import { changes_sentence, saved_file, short_sha, unpushed_text } from "./localChanges";
import "./LocalChanges.css";

const max_runs_listed = 50;
// "Show only these runs" sets the filter to their ids: up to this many
const max_runs_filtered = 100;
const run_name = output => output.test_input_path || `run ${output.id}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// id:(1|2)(?!\d) keeps runs 1 and 2, not 12
const ids_filter = outputs => `id:(${outputs.map(o => o.id).join('|')})(?!\\d)`;
const showRuns = outputs => updateSelected({ filter_batch_new: ids_filter(outputs) });

const kind_text = group => group.kind === 'changes'
  ? `Uncommitted changes: ${changes_sentence(group.changes)}`
  : group.kind === 'clean' ? 'No local changes' : "Unknown: git couldn't tell";

// the patch's content address, short, to tell sets apart
const patch_id = changes => typeof changes.sha256 === 'string' && /^[0-9a-f]{7,}$/.test(changes.sha256) ? changes.sha256.slice(0, 7) : null;

const GroupRow = ({ group, ref_batch }) => {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const { changes, kind, count, outputs, output } = group;
  const unpushed = unpushed_text(changes);
  const viewable = kind === 'changes' || (kind === 'clean' && !!saved_file(changes, 'unpushed'));
  const id = kind === 'changes' ? patch_id(changes) : null;
  const ids = outputs.every(o => Number.isInteger(Number(o.id)));
  return <>
    <tr>
      <td>
        <Tag minimal intent={kind === 'unknown' ? 'warning' : 'none'} icon={kind === 'changes' ? 'git-new-branch' : kind === 'clean' ? 'git-commit' : 'help'}>
          {kind_text(group)}
        </Tag>
        {id && <> <code className={Classes.TEXT_MUTED} title="The patch's id: runs with the same id ran the same code">{id}</code></>}
      </td>
      <td><code>{short_sha(changes.head) || '?'}</code>{changes.branch && <> on <code>{String(changes.branch)}</code></>}</td>
      <td>{unpushed || (changes.pushed === true ? 'pushed' : <span className={Classes.TEXT_MUTED}>unknown</span>)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Button size="small" variant="minimal" icon={expanded ? 'chevron-up' : 'chevron-down'} aria-expanded={expanded}
          text={plural(count, 'run')} onClick={() => setExpanded(!expanded)}/>
        {ids && count <= max_runs_filtered && <Button size="small" variant="minimal" icon="filter" aria-label={`Show only these ${plural(count, 'run')}`}
          title="Show only these runs" onClick={() => showRuns(outputs)}/>}
      </td>
      <td>{viewable && <Button size="small" icon="eye-open" text="View" aria-label={`View: ${kind_text(group)}`} onClick={() => setOpen(true)}/>}
        <LocalChangesDialogLoader isOpen={open} onClose={() => setOpen(false)} output={output} output_ref={ref_batch?.outputs?.[output.reference_id]}/>
      </td>
    </tr>
    {expanded && <tr>
      <td colSpan={5}>
        <ul className={Classes.LIST} style={{ margin: 0 }}>
          {outputs.slice(0, max_runs_listed).map(o => <li key={o.id}>{run_name(o)}</li>)}
        </ul>
        {count > max_runs_listed && <p className={Classes.TEXT_MUTED}>and {count - max_runs_listed} more</p>}
      </td>
    </tr>}
  </>;
};

// groups: group_local_changes(the runs shown)
const LocalChangesView = ({ groups, ref_batch }) => {
  if (!groups?.has_data)
    return <NonIdealState icon="git-new-branch" title="No local changes recorded" description="Runs started from your computer record their code changes. CI runs and older runs don't."/>;
  const n = groups.groups.length;
  return <>
    <p>{groups.shared !== null ? 'The runs shown ran the same code.' : `The runs shown recorded ${n} different set${n === 1 ? '' : 's'} of local changes.`}</p>
    <div className="local-changes-table-wrapper">
      <HTMLTable compact striped style={{ width: '100%' }}>
        <thead><tr><th>Changes</th><th>Commit</th><th>Pushed</th><th>Runs</th><th><span className="local-changes-sr-only">Details</span></th></tr></thead>
        <tbody>
          {groups.groups.map(group => <GroupRow key={group.key} group={group} ref_batch={ref_batch}/>)}
          {groups.missing > 0 && <tr>
            <td colSpan={3} className={Classes.TEXT_MUTED}>Didn't record their local changes (CI or older runs)</td>
            <td colSpan={2}>{plural(groups.missing, 'run')}</td>
          </tr>}
        </tbody>
      </HTMLTable>
    </div>
  </>;
};

export default LocalChangesView;
