// Saving and editing a milestone: what results it is, its name, group, notes, and who sees it.
import { useId, useState } from "react";
import styled from "styled-components";
import { create } from "zustand";
import {
  Alert,
  Button,
  Callout,
  Classes,
  Colors,
  Dialog,
  DialogBody,
  DialogFooter,
  FormGroup,
  Icon,
  InputGroup,
  Intent,
  SegmentedControl,
  Tag,
  TextArea,
} from "@blueprintjs/core";

import AuthButton from "../components/authentication/Auth";
import { useUser } from "../hooks";
import { pretty_label } from "../utils";
import { copyWithToast } from "../utils/clipboard";
import {
  milestone_name, milestone_url, owner_name, relative_date, results_project, dataset_label,
} from "./api";
import { useMilestones, useMilestoneActions } from "./hooks";


const Summary = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  align-items: baseline;
  padding: 10px 12px;
  margin-bottom: 16px;
  border-radius: 4px;
  background: var(--qa-subtle-background, rgba(143, 153, 168, 0.12));
  font-size: 13px;

  dt {
    color: var(--qa-text-muted, ${Colors.GRAY3});
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  code {
    font-size: 12px;
  }
`;

// What results the milestone is
export const ResultsSummary = ({ project, target, runs }) => {
  const { commit, batch, filter, commit_project } = target;
  return <Summary as="dl" aria-label="The results saved as a milestone">
    <dt>Commit</dt>
    <dd title={commit.message ?? undefined}>
      <code>{commit.id?.slice(0, 8)}</code>
      {commit.branch && <> on <strong>{commit.branch}</strong></>}
      {commit.message && <span className={Classes.TEXT_MUTED}> · {commit.message.split('\n')[0]}</span>}
    </dd>
    {(commit.committer_name || commit.authored_datetime) && <>
      <dt>By</dt>
      <dd>{commit.committer_name}{commit.authored_datetime && <span className={Classes.TEXT_MUTED}> · {relative_date(commit.authored_datetime)}</span>}</dd>
    </>}
    <dt>Batch</dt>
    <dd><Tag minimal icon="layout-skew-grid">{pretty_label({ label: batch || 'default' })}</Tag></dd>
    <dt>Filter</dt>
    <dd>
      {filter ? <Tag minimal icon="filter" intent={Intent.PRIMARY}>{filter}</Tag> : <span className={Classes.TEXT_MUTED}>none: all the runs</span>}
      {runs !== undefined && runs !== null && <span className={Classes.TEXT_MUTED}> · {runs} run{runs === 1 ? '' : 's'}</span>}
    </dd>
    {!!commit_project && commit_project !== project && <>
      <dt>Project</dt>
      <dd><Tag minimal icon="git-repo">{commit_project}</Tag></dd>
    </>}
    {(target.runs_summary?.databases?.length ?? 0) > 0 && <>
      <dt>Datasets</dt>
      <dd title={target.runs_summary.databases.map(d => `${d.name} (${d.runs} runs)`).join('\n')}>
        {target.runs_summary.databases.slice(0, 4).map(d => <Tag key={d.name} minimal round icon="database" style={{ marginRight: 4 }}>{dataset_label(d.name)} <span className={Classes.TEXT_MUTED}>{d.runs}</span></Tag>)}
        {target.runs_summary.databases.length > 4 && <span className={Classes.TEXT_MUTED}>+{target.runs_summary.databases.length - 4}</span>}
      </dd>
    </>}
    {(target.runs_summary?.batches?.length ?? 0) > 0 && <>
      <dt>qa batches</dt>
      <dd title={target.runs_summary.batches.map(b => `${b.name} (${b.runs} runs)`).join('\n')}>
        {target.runs_summary.batches.slice(0, 4).map(b => <Tag key={b.name} minimal round icon="layout-skew-grid" style={{ marginRight: 4 }}>{b.name} <span className={Classes.TEXT_MUTED}>{b.runs}</span></Tag>)}
        {target.runs_summary.batches.length > 4 && <span className={Classes.TEXT_MUTED}>+{target.runs_summary.batches.length - 4}</span>}
      </dd>
    </>}
  </Summary>;
};

// A milestone's results, as ResultsSummary shows them
const target_of = m => ({
  commit: { id: m.commit, branch: m.branch, message: m.message, committer_name: m.committer_name },
  batch: m.batch,
  filter: m.filter,
  commit_project: m.commit_project,
  runs_summary: m.runs,
});

// A name for new milestones: users can keep it, or type over it
const suggested_name = ({ commit, batch, filter }) => {
  const parts = [batch && batch !== 'default' ? pretty_label({ label: batch }) : (commit.branch || commit.id?.slice(0, 8)), filter].filter(Boolean);
  return parts.join(' · ');
};

const visibility_options = [
  { label: 'Only me', value: 'personal', icon: 'person' },
  { label: 'Everyone on the project', value: 'shared', icon: 'people' },
];


// One dialog for the whole app: menus that open it close when it opens, they can't host it.
//   openMilestoneDialog({ project, milestone })          to edit or see a milestone
//   openMilestoneDialog({ project, target, runs })       to save results: {commit, batch, filter, commit_project}
const useDialogStore = create(() => ({ props: null }));
export const openMilestoneDialog = props => useDialogStore.setState({ props: { ...props, opened: Date.now() } });
const closeMilestoneDialog = () => useDialogStore.setState(state => ({ props: state.props && { ...state.props, closed: true } }));

export const MilestoneDialogHost = () => {
  const props = useDialogStore(state => state.props);
  if (!props) return null;
  return <MilestoneDialog key={props.opened} {...props} isOpen={!props.closed} onClose={closeMilestoneDialog}/>;
};


// `milestone`: the one to edit, else we save `target`: {commit, batch, filter, commit_project}
export const MilestoneDialog = ({ isOpen, onClose, project, milestone, target, runs, onSaved }) => {
  const user = useUser();
  // reset the form each time it opens
  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title={milestone ? (milestone.can_edit ? 'Edit the milestone' : milestone_name(milestone)) : 'Save as a milestone'}
    icon={milestone?.shared ? 'crown' : 'star'}
    style={{ width: 540, maxWidth: 'calc(100vw - 32px)' }}
    canOutsideClickClose={false}
  >
    {isOpen && (user.is_logged || milestone
      ? <MilestoneForm key={milestone?.id ?? 'new'} project={project} milestone={milestone} target={target} runs={runs} onClose={onClose} onSaved={onSaved} user={user}/>
      : <DialogBody>
          <ResultsSummary project={project} target={target} runs={runs}/>
          <Callout intent={Intent.PRIMARY} icon="log-in" title="Log in to save milestones">
            <p>Milestones are saved in your account: they follow you on every computer, and you can share them with the project.</p>
            <AuthButton/>
          </Callout>
        </DialogBody>
    )}
  </Dialog>;
};


const MilestoneForm = ({ project, milestone: existing, target: new_target, runs, onClose, onSaved, user }) => {
  const id = useId();
  const { list } = useMilestones(project);
  const { save, remove, toggleFavorite } = useMilestoneActions(project);
  // others' milestones are read-only. Users can save their own copy.
  const [copying, setCopying] = useState(false);
  // a copy is the user's own: personal, until they decide to share it
  const copy = () => {
    setCopying(true);
    setVisibility('personal');
    setLabel(label => `${label} (mine)`);
  };
  const milestone = copying ? null : existing;
  const target = milestone ? target_of(milestone) : (new_target ?? target_of(existing));
  const read_only = !!milestone && !milestone.can_edit;

  const [label, setLabel] = useState(() => milestone ? milestone.label : suggested_name(target));
  const [group, setGroup] = useState(milestone?.group ?? '');
  const [notes, setNotes] = useState(milestone?.notes ?? (copying ? existing?.notes ?? '' : ''));
  const [visibility, setVisibility] = useState(milestone?.shared ? 'shared' : 'personal');
  const [saving, setSaving] = useState(false);
  const [confirm_delete, setConfirmDelete] = useState(false);

  // the groups users already use, to stay consistent
  const groups = [...new Set(list.filter(m => m.is_mine || m.shared).map(m => m.group).filter(Boolean))].sort();
  const is_favorite = !!list.find(m => m.id === existing?.id)?.is_favorite || !!existing?.is_favorite;

  const submit = async event => {
    event?.preventDefault();
    if (read_only || !label.trim()) return;
    setSaving(true);
    try {
      const fields = { label, group, notes, shared: visibility === 'shared' };
      const saved = milestone
        ? await save(fields, milestone)
        : await save({
            ...fields,
            commit: target.commit.id,
            batch: target.batch || 'default',
            filter: target.filter || '',
            commit_project: target.commit_project && target.commit_project !== project ? target.commit_project : null,
            branch: target.commit.branch ?? undefined,
            committer_name: target.commit.committer_name ?? undefined,
            message: target.commit.message?.split('\n')[0] ?? undefined,
          });
      onSaved?.(saved);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const deleteMilestone = async () => {
    setConfirmDelete(false);
    try {
      await remove(milestone);
      onClose();
    } catch { /* toasted */ }
  };

  return <form onSubmit={submit}>
    <DialogBody>
      <ResultsSummary project={project} target={target} runs={milestone ? undefined : runs}/>
      {read_only
        ? <ReadOnly milestone={milestone}/>
        : <>
            <FormGroup label="Name" labelFor={`${id}-label`} helperText={!milestone ? "Why it's worth comparing with: a release, “best denoiser so far”…" : undefined}>
              <InputGroup
                id={`${id}-label`}
                value={label}
                onChange={e => setLabel(e.target.value)}
                onFocus={e => e.target.select()}
                autoFocus
                required
                maxLength={200}
                intent={label.trim() ? undefined : Intent.DANGER}
              />
            </FormGroup>
            <FormGroup label="Group" labelFor={`${id}-group`} labelInfo="(optional)" helperText={<>Milestones are listed by group. Use <code>/</code> for subgroups, e.g. <code>tuning/denoiser</code>.</>}>
              <InputGroup
                id={`${id}-group`}
                leftIcon="folder-close"
                value={group}
                onChange={e => setGroup(e.target.value)}
                list={`${id}-groups`}
                placeholder="e.g. releases, tuning/denoiser"
                maxLength={200}
                autoComplete="off"
              />
              <datalist id={`${id}-groups`}>{groups.map(g => <option key={g} value={g}>{g}</option>)}</datalist>
            </FormGroup>
            <FormGroup label="Notes" labelFor={`${id}-notes`} labelInfo="(optional)">
              <TextArea
                id={`${id}-notes`}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="What changed, what to look at, the parameters…"
                rows={3}
                fill
                autoResize
              />
            </FormGroup>
            <FormGroup
              label="Who sees it in their lists"
              helperText={visibility === 'shared'
                ? "Listed for everyone on the project. Only you can edit or delete it."
                : "Listed only for you. Anyone on the project can still open its link."}
            >
              <SegmentedControl options={visibility_options} value={visibility} onValueChange={setVisibility} size="small"/>
            </FormGroup>
          </>
      }
    </DialogBody>
    <DialogFooter
      actions={<>
        {!!milestone && <Button icon="link" text="Copy link" variant="minimal" onClick={() => copyWithToast(milestone_url(milestone), { what: 'the link to the milestone' })}/>}
        <Button text={read_only ? 'Close' : 'Cancel'} onClick={onClose}/>
        {!read_only && <Button type="submit" intent={Intent.PRIMARY} icon="star" text={milestone ? 'Save' : 'Save milestone'} loading={saving} disabled={!label.trim()}/>}
      </>}
    >
      {!!existing && !copying && <span style={{ display: 'flex', gap: 4 }}>
        {user.is_logged && <Button
          variant="minimal"
          icon={<Icon icon="heart" color={is_favorite ? Colors.RED4 : undefined}/>}
          text={is_favorite ? 'Favorite' : 'Add to favorites'}
          aria-pressed={is_favorite}
          onClick={() => toggleFavorite({ ...existing, is_favorite }).catch(() => {})}
        />}
        {read_only && user.is_logged && <Button variant="minimal" icon="duplicate" text="Save my own" onClick={copy}/>}
        {milestone?.can_edit && <Button variant="minimal" intent={Intent.DANGER} icon="trash" text="Delete" onClick={() => setConfirmDelete(true)}/>}
      </span>}
    </DialogFooter>
    <Alert
      isOpen={confirm_delete}
      icon="trash"
      intent={Intent.DANGER}
      cancelButtonText="Cancel"
      confirmButtonText="Delete"
      canEscapeKeyCancel
      onCancel={() => setConfirmDelete(false)}
      onConfirm={deleteMilestone}
    >
      <p>Delete the milestone <strong>{milestone ? milestone_name(milestone) : ''}</strong>?</p>
      <p className={Classes.TEXT_MUTED}>Its results stay, but the cleanup of old results will be able to delete them.{milestone?.shared ? ' Everyone on the project will lose it.' : ''}</p>
    </Alert>
  </form>;
};


const ReadOnly = ({ milestone }) => <div>
  {!!milestone.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{milestone.notes}</p>}
  {!!milestone.group && <p><Icon icon="folder-close" size={12} className={Classes.TEXT_MUTED}/> {milestone.group}</p>}
  <p className={Classes.TEXT_MUTED}>
    {milestone.shared ? 'Shared with the project' : 'Personal milestone'}
    {owner_name(milestone) ? `, saved by ${owner_name(milestone)}` : ''}
    {milestone.created_at ? ` ${relative_date(milestone.created_at)}` : ''}.
    {' '}Only {owner_name(milestone) ?? 'its owner'} can edit it.
  </p>
  {results_project(milestone) !== milestone.project && <p className={Classes.TEXT_MUTED}>Results from {results_project(milestone)}.</p>}
</div>;
