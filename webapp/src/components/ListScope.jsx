// Above the project's commits: whose (yours or everyone's), with or without the CI's batches, as batches or commits,
// and how many there are in each scope, so that "show everyone's" is always one click away.
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, SegmentedControl, Switch, Tooltip } from "@blueprintjs/core";
import styled from "styled-components";

import { commitCountsQuery } from "../api/queries";
import { updateSelected } from "../selection";
import { useUser } from "../hooks";
import { usePrefsStore } from "../stores/prefs";


const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-bottom: 12px;
  .qa-scope-counts { margin-right: auto; }
  .${Classes.CONTROL} { margin-bottom: 0; }
`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const Counts = ({ counts, scope, hide_ci, onScope }) => {
  if (typeof counts?.all !== 'number') return <span className={`qa-scope-counts ${Classes.TEXT_MUTED}`}>&nbsp;</span>;
  const everyone = hide_ci ? counts.without_ci : counts.all;
  if (scope === 'mine')
    return <span className="qa-scope-counts">
      Your {plural(counts.mine ?? 0, 'commit')}
      <span className={Classes.TEXT_MUTED}> in these dates · </span>
      <Button variant="minimal" size="small" text={`${plural(everyone, 'commit')} by everyone`} endIcon="arrow-right" onClick={() => onScope('all')}/>
    </span>;
  return <span className="qa-scope-counts">
    {plural(everyone, 'commit')}{hide_ci && ' with batches outside the CI'}<span className={Classes.TEXT_MUTED}> in these dates</span>
    {counts.mine !== null && counts.mine !== undefined && onScope && <>
      <span className={Classes.TEXT_MUTED}> · </span>
      <Button variant="minimal" size="small" text={`${counts.mine} yours`} endIcon="arrow-right" onClick={() => onScope('mine')}/>
    </>}
  </span>;
};

export const ListScopeToolbar = ({ list, branch, committer, view, children }) => {
  const user = useUser();
  const setListScope = usePrefsStore(state => state.setListScope);
  const { project, scope, has_scope, hide_ci, date_range, search } = list;
  const { data: counts } = useQuery({
    ...commitCountsQuery({ project, branch: branch ?? undefined, committer: committer ?? undefined, from: date_range[0].toISOString(), to: date_range[1].toISOString() }),
    // searches look at all the commits: counts in these dates would be confusing
    enabled: !!project && !search,
  });
  const onScope = new_scope => {
    setListScope(project, new_scope);
    updateSelected({ scope: new_scope, list_view: undefined });
  };
  const show_scope = has_scope && user.is_logged;
  return <Toolbar>
    {!search && <Counts counts={counts} scope={scope} hide_ci={hide_ci} onScope={show_scope ? onScope : null}/>}
    {search && <span className="qa-scope-counts"/>}
    {show_scope && <SegmentedControl
      aria-label="Whose commits"
      size="small"
      options={[{ value: 'mine', label: 'Yours', icon: 'person' }, { value: 'all', label: 'Everyone', icon: 'people' }]}
      value={scope}
      onValueChange={onScope}
    />}
    <Tooltip content="Leave out the batches sent by CI pipelines: see what people ran, from the web app or their terminal." placement="bottom" openOnTargetFocus={false}>
      <Switch
        label="Hide the CI"
        checked={hide_ci}
        onChange={event => updateSelected({ hide_ci: event.target.checked }, { replace: true })}
      />
    </Tooltip>
    {view && <SegmentedControl
      aria-label="List batches or commits"
      size="small"
      options={[{ value: 'batches', label: 'Batches', icon: 'layers' }, { value: 'commits', label: 'Commits', icon: 'git-commit' }]}
      value={view}
      onValueChange={value => updateSelected({ list_view: value })}
    />}
    {children}
  </Toolbar>;
};

export default ListScopeToolbar;
