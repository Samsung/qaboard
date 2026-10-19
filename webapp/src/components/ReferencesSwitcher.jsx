// Users can select several references, and compare the new commit with one of them at a time (src/selection.js).
// In the reference's header: ‹ 2/4 › to switch, and a menu to list, add, remove them. However many there are,
// it takes the same room. "r" shows the next reference, "Shift R" the previous one.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import {
  Button,
  ButtonGroup,
  Classes,
  InputGroup,
  Intent,
  MenuDivider,
  MenuItem,
  PopoverNext,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import { MilestonesPanel } from "../milestones/MilestonesPanel";
import { milestone_name, results_project } from "../milestones/api";
import { commitQuery } from "../api/queries";
import { errorMessage } from "../api/http";
import { useComparison, useSiteConfig, updateSelected, usePrefetchCommitPage } from "../hooks";
import { add_reference, remove_reference, show_as_new, show_reference } from "../selection";
import { is_typing } from "./HelpSheet";
import { shortId, pretty_label } from "../utils";
import { toaster } from "../toaster";


const Row = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
  .qa-reference-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-reference-meta {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-reference-meta > * + *::before {
    content: '·';
    margin: 0 5px;
    opacity: 0.6;
  }
`;

// What we call a reference in the list: its milestone, else its branch, else its commit
const reference_name = (reference, project) => reference.milestone ? milestone_name(reference.milestone)
  : reference.commit?.branch ?? (reference.commit_id ? shortId(project, reference.commit_id) : 'Latest on the reference branch');

const ReferenceItem = ({ reference, project, can_remove, can_show_as_new, onShow, onRemove, onShowAsNew }) => {
  const prefetch = usePrefetchCommitPage(reference.project, reference.commit_id);
  const meta = [
    reference.commit_id && (reference.milestone || reference.commit?.branch) ? <code key="id">{shortId(project, reference.commit_id)}</code> : null,
    reference.batch !== 'default' ? <span key="batch">{pretty_label({ label: reference.batch })}</span> : null,
    reference.filter ? <span key="filter">filter: {reference.filter}</span> : null,
    reference.project !== project ? <span key="project">{reference.project}</span> : null,
  ].filter(Boolean);
  const stop = action => event => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };
  return <MenuItem
    {...prefetch}
    active={reference.is_shown}
    icon={<Tag minimal round intent={reference.is_shown ? Intent.PRIMARY : undefined}>{reference.number}</Tag>}
    shouldDismissPopover={false}
    onClick={onShow}
    aria-label={`Compare with ${reference_name(reference, project)}`}
    text={<Row>
      <span className="qa-reference-name">{reference_name(reference, project)}</span>
      {meta.length > 0 && <span className={`qa-reference-meta ${Classes.TEXT_MUTED}`}>{meta}</span>}
    </Row>}
    labelElement={<span style={{ display: 'flex' }}>
      {can_show_as_new && <Tooltip content="Show as the new results">
        <Button size="small" variant="minimal" icon="chevron-up" aria-label="Show as the new results" onClick={stop(onShowAsNew)}/>
      </Tooltip>}
      {can_remove && <Tooltip content="Remove from the references">
        <Button size="small" variant="minimal" icon="cross" aria-label="Remove from the references" onClick={stop(onRemove)}/>
      </Tooltip>}
    </span>}
  />;
};


export const ReferencesSwitcher = () => {
  const queryClient = useQueryClient();
  const { docs_root } = useSiteConfig();
  const { project, project_data, selected, references, new_commit } = useComparison();
  const [commit_input, setCommitInput] = useState('');
  const several = references.length > 1;
  const shown = references[selected.ref_index];
  // the actions need the commits' ids, e.g. the default reference's
  const resolved = { ...selected, references, new_commit_id: selected.new_commit_id || new_commit?.id || null };
  const show = index => updateSelected(show_reference(resolved, (index + references.length) % references.length));
  const add = side => updateSelected(add_reference(resolved, side));

  useEffect(() => {
    if (!several) return;
    const onKeyDown = event => {
      if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return;
      if (is_typing(event.target)) return;
      event.preventDefault();
      show(selected.ref_index + (event.shiftKey ? -1 : 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const addBranch = async branch => {
    try {
      const commit = await queryClient.fetchQuery(commitQuery({ project, branch }));
      queryClient.setQueryData(commitQuery({ project, id: commit.id }).queryKey, commit);
      add({ project, commit_id: commit.id });
    } catch (error) {
      toaster.show({ message: `Could not find the latest commit on ${branch}: ${errorMessage(error)}`, intent: Intent.DANGER });
    }
  };
  const addMilestone = milestone => {
    // milestones from qaboard.yaml are only a branch, tag or commit
    if (!milestone.commit && milestone.branch) return addBranch(milestone.branch);
    add({ project: results_project(milestone), commit_id: milestone.commit, batch: milestone.batch || 'default', filter: milestone.filter ?? '' });
  };
  const addCommit = () => {
    const id = commit_input.trim();
    if (!id) return;
    add({ project, commit_id: id });
    setCommitInput('');
  };
  const reference_branch = project_data?.data?.qatools_config?.project?.reference_branch ?? 'master';

  const panel = <MilestonesPanel
    project={project}
    project_data={project_data}
    docs_root={docs_root}
    selected={{ project: shown.project, commit: shown.commit_id, batch: shown.batch, filter: shown.filter }}
    onSelect={addMilestone}
    before={<>
      <MenuDivider title={several ? `Compare with one of ${references.length} references` : "Compare with more references"}/>
      {references.map(reference => <ReferenceItem
        key={reference.index}
        reference={reference}
        project={project}
        can_remove={several}
        can_show_as_new={!!reference.commit_id && !!resolved.new_commit_id}
        onShow={() => show(reference.index)}
        onRemove={() => updateSelected(remove_reference(resolved, reference.index))}
        onShowAsNew={() => updateSelected(show_as_new(resolved, reference.index))}
      />)}
      {several && <li className={Classes.TEXT_MUTED} style={{ fontSize: 12, padding: '2px 7px 6px' }}>
        <kbd className={Classes.KEY}>r</kbd> next, <kbd className={Classes.KEY}>Shift</kbd> <kbd className={Classes.KEY}>r</kbd> previous
      </li>}
      <MenuDivider title="Add a reference"/>
      <li style={{ padding: '2px 0 6px' }}>
        <InputGroup
          leftIcon="git-commit"
          placeholder="commit id"
          aria-label="Add a commit as reference"
          inputClassName={Classes.MONOSPACE_TEXT}
          value={commit_input}
          onChange={e => setCommitInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCommit()}
          rightElement={<Button variant="minimal" icon="plus" aria-label="Add" disabled={!commit_input.trim()} onClick={addCommit}/>}
        />
      </li>
      <MenuItem text={reference_branch} label="reference branch" icon="git-branch" shouldDismissPopover={false} onClick={() => addBranch(reference_branch)}/>
    </>}
  />;

  const menu_button = <Button
    size="small"
    variant="minimal"
    icon={several ? undefined : "layers"}
    endIcon={several ? "caret-down" : undefined}
    aria-label={several ? `Reference ${shown.number} of ${references.length}: list, add or remove references` : "Compare with more references"}
  >
    {several ? <span className={Classes.MONOSPACE_TEXT}>{shown.number}/{references.length}</span> : null}
  </Button>;
  const menu = <PopoverNext placement="bottom-start" content={panel}>{menu_button}</PopoverNext>;
  return <ButtonGroup variant="minimal" size="small" style={{ alignSelf: 'center', flex: 'none', marginRight: '5px' }}>
    {several && <Tooltip content={<>Previous reference <kbd className={Classes.KEY}>Shift</kbd> <kbd className={Classes.KEY}>r</kbd></>}>
      <Button size="small" variant="minimal" icon="chevron-left" aria-label="Previous reference" onClick={() => show(selected.ref_index - 1)}/>
    </Tooltip>}
    {several ? menu : <Tooltip content="Compare with more references: keep this one, add others, switch between them">{menu}</Tooltip>}
    {several && <Tooltip content={<>Next reference <kbd className={Classes.KEY}>r</kbd></>}>
      <Button size="small" variant="minimal" icon="chevron-right" aria-label="Next reference" onClick={() => show(selected.ref_index + 1)}/>
    </Tooltip>}
  </ButtonGroup>;
};
