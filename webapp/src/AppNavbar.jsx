import styled from "styled-components";

import { Suggest } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";
import enUS from "date-fns/locale/en-US";
import {
  Intent,
  Navbar,
  NavbarGroup,
  InputGroup,
  MenuItem,
  Button,
  Spinner,
  Tooltip,
} from "@blueprintjs/core";

import { useState } from "react";
import { useRouter } from "./router";
import { path_segment } from "./selection";
import { CommitNavbar } from "./components/CommitNavbar";
import { SelectBatchesNav } from "./components/tuning/SelectBatches";
import { useBranches, useCommitsList, useComparison, useUrlText, updateSelected } from "./hooks";

import { sider_width } from './AppSider'




const renderBranch = (item, { handleClick, modifiers }) => {
  return (
    <MenuItem
      active={modifiers.active}
      icon="git-branch"
      key={item}
      onClick={handleClick}
      text={item}
    />
  );
};
const renderNewItem = (query, active, handleClick)  => {
  return <MenuItem
      icon="git-commit"
      text={<span><strong>Go to commit:</strong> {query}</span>}
      active={active}
      onClick={handleClick}
      shouldDismissPopover={false}
  />

}
                


// What we look for in branch names, in searches like "fix" or "speed branch:feature -wip"
export const branch_query = search => {
  const qualified = search.match(/(?:^|\s)branch:(?:"([^"]*)"?|(\S+))/i);
  if (qualified) return (qualified[1] ?? qualified[2]).trim();
  const words = search.trim().split(/\s+/).filter(word => !word.startsWith('-') && !word.includes(':'));
  return words.length === 1 ? words[0].replace(/"/g, '') : '';
}

export function filterBranch(query, branch) {
  const text = branch_query(query ?? '');
  // e.g. "fix crash" or "committer:alice" are not about branches
  if (!text) return !(query ?? '').trim();
  return branch.toLowerCase().indexOf(text.toLowerCase()) >= 0;
}


const StyledNavbar = styled(Navbar)`
   position: fixed !important;
   top: 0;
   padding-left: ${sider_width} !important;
   /*overflow-y: auto !important;*/
`

const navbar_height = 75;
const StyledNavbarNew = styled(Navbar)`
   position: fixed !important;
   padding-left: ${sider_width} !important;
   height: ${navbar_height}px !important;
   top: 0 !important;
   align-content: center;
`
const StyledNavbarRef = styled(Navbar)`
   position: fixed !important;
   padding-left: ${sider_width} !important;
   height: ${navbar_height}px !important;
   top: ${navbar_height}px !important;
   align-content: center;
`



// When comparing commits: one navbar for each
const CommitsNavbars = () => {
  const { project, project_data, selected, selected_views, new_commit, ref_commit, new_batch, ref_batch } = useComparison();
  const update = attribute => e => {
    const value = (e?.target && e.target.value !== undefined) ? e.target.value : e;
    // typing filters shouldn't add browser history entries
    updateSelected({ [attribute]: value }, { replace: attribute.startsWith('filter') })
  }
  const show_ref_navbar = !(selected_views.includes('logs') || selected_views.includes('tuning') || selected_views.includes('groups'))
  // e.g. the latest commit of the reference branch, compared to itself
  const same_as_new = !!new_commit?.id && new_commit.id === ref_commit?.id
    && (selected.new_project ?? project) === (selected.ref_project ?? project)
    && new_batch?.label === ref_batch?.label
    && (selected.filter_batch_new ?? '') === (selected.filter_batch_ref ?? '')
  return <>
    <StyledNavbarNew>
      <CommitNavbar
        update={update}
        loading={!new_commit?.is_loaded}
        commit={new_commit}
        batch={new_batch}
        filter={selected.filter_batch_new}
        project={project}
        project_data={project_data}
        selected={selected}
        type="new"
      />
    </StyledNavbarNew>
    {show_ref_navbar && <StyledNavbarRef>
      <CommitNavbar
        update={update}
        loading={!ref_commit?.is_loaded}
        commit={ref_commit}
        batch={ref_batch}
        filter={selected.filter_batch_ref}
        project={project}
        project_data={project_data}
        selected={selected}
        type="ref"
        same_as_new={same_as_new}
      />
    </StyledNavbarRef>}
  </>
}


// Lists of commits: pick the dates, filter, go to a branch or a commit
const CommitsListNavbar = () => {
  const { history } = useRouter();
  const list = useCommitsList();
  const { project, date_range } = list;
  const { project_data, selected, new_commit, new_batch } = useComparison();
  // We only fetch branches once users start searching
  const [wants_branches, setWantsBranches] = useState(false);
  const [today] = useState(() => new Date());
  // The search goes in the URL when users pause typing: it searches commits (CiCommitList) and branches
  const [search, onSearchChange] = useUrlText(selected.search, query => updateSelected({ search: query || undefined }, { replace: true }), 300);
  const [filter, onFilterChange] = useUrlText(selected.filter_batch_new, value => updateSelected({ filter_batch_new: value }, { replace: true }));
  const branch_search = branch_query(selected.search);
  const { data: branches = [] } = useBranches(project, branch_search, { enabled: wants_branches && (!!branch_search || !selected.search.trim()) });

  const handleBranchChange = branch => {
    if (branch.commit !== undefined && branch.commit !== null)
      history.push(`/${path_segment(project)}/commit/${path_segment(branch.commit)}`);
    else
      updateSelected({ branch });
  };
  const changeDates = new_date_range => {
    if (new_date_range[0] === null && new_date_range[1] === null)
      return
    updateSelected({ from: new_date_range[0] ?? date_range[0], to: new_date_range[1] ?? date_range[1] }, { replace: true })
  }

  const { route } = selected;
  const date_input_props = {style: {width:'100px'}}
  // searches look at all the commits (see useCommitsList)
  const is_searching = route.is_commits && !!selected.search?.trim()
  return (
    <StyledNavbar>
      <NavbarGroup style={{marginLeft: '20px'}}>
        <Tooltip content="Searches look at all the commits, whatever the dates." disabled={!is_searching}>
        <DateRangeInput
          locale={enUS}
          endInputProps={{...date_input_props, 'aria-label': 'End date'}}
          startInputProps={{...date_input_props, 'aria-label': 'Start date'}}
          disabled={is_searching}
          value={date_range}
          maxDate={today}
          allowSingleDayRange
          formatDate={date => date == null ? "" : date.toLocaleDateString()}
          parseDate={str => new Date(str)}
          onChange={changeDates}
          shortcuts
        />
        </Tooltip>
        <div style={{marginLeft: '5px'}}>
          <Tooltip content="Check for new commits">
            <Button icon="refresh" aria-label="Check for new commits" disabled={list.isFetching} minimal onClick={() => list.refetch()}/>
          </Tooltip>
        </div>
        {list.isFetching && <div style={{marginLeft: '15px'}}><Spinner size={16} /></div>}
      </NavbarGroup>
      <NavbarGroup align="right">
        {route.is_history && <SelectBatchesNav
          commit={new_commit}
          batch={new_batch}
          project={project}
          project_data={project_data}
          onChange={event => updateSelected({ selected_batch_new: event.target.value, selected_batch_ref: event.target.value })}
          hide_counts
        />}
        {route.is_commits &&
            <Suggest
              query={search}
              itemPredicate={filterBranch}
              createNewItemFromQuery={query => ({commit: query.trim()})}
              createNewItemRenderer={renderNewItem}
              items={branches}
              itemRenderer={renderBranch}
              inputValueRenderer={item => typeof item === 'string' ? item : item.commit}
              noResults={<MenuItem disabled={true} text="No results." />}
              onItemSelect={handleBranchChange}
              inputProps={{
                leftIcon: 'filter',
                intent: !!search ? Intent.PRIMARY : null,
                // Suggest only reads the placeholder from inputProps
                placeholder: "Search commits, or go to a branch or commit…",
                style: {width: '350px'},
              }}
              onQueryChange={query => {
                setWantsBranches(true);
                onSearchChange(query);
              }}
            />
        }
        {route.is_history &&
          <InputGroup
            value={filter}
            placeholder="Filter runs: path, tag, key:value…"
            title="Filter runs by path, configuration, platform, tag or tuning parameters (key:value)"
            aria-label="Filter runs"
            intent={filter ? Intent.PRIMARY : undefined}
            onChange={onFilterChange}
            type="text"
            leftIcon="filter"
            rightElement={filter ? <Button size="small" variant="minimal" icon="cross" aria-label="Clear the filter" onClick={() => onFilterChange('')}/> : undefined}
            style={{width: '320px'}}
          />}
      </NavbarGroup>
    </StyledNavbar>
  );
}


const AppNavbar = () => {
  const { selected } = useComparison();
  return selected.route.is_commit ? <CommitsNavbars/> : <CommitsListNavbar/>;
}

export default AppNavbar;
