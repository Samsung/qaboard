import styled from "styled-components";

import { Suggest } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";
import enUS from "date-fns/locale/en-US";
import {
  Classes,
  Intent,
  Navbar,
  NavbarGroup,
  InputGroup,
  MenuItem,
  Button,
  Spinner,
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
      className={!modifiers.active ? Classes.ACTIVE : Classes.INTENT_PRIMARY}
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
                


function filterBranch(query, branch) {
  if (!query) return true;
  return branch.toLowerCase().indexOf(query.toLowerCase()) >= 0;
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
  const [search, onSearchChange] = useUrlText(selected.search, query => updateSelected({ search: query || undefined }, { replace: true }));
  const [filter, onFilterChange] = useUrlText(selected.filter_batch_new, value => updateSelected({ filter_batch_new: value }, { replace: true }));
  const { data: branches = [] } = useBranches(project, { enabled: wants_branches });

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
  return (
    <StyledNavbar>
      <NavbarGroup style={{marginLeft: '20px'}}>
        <DateRangeInput
          locale={enUS}
          endInputProps={date_input_props}
          startInputProps={date_input_props}
          value={date_range}
          maxDate={today}
          allowSingleDayRange
          formatDate={date => date == null ? "" : date.toLocaleDateString()}
          parseDate={str => new Date(str)}
          onChange={changeDates}
          shortcuts
        />
        <div style={{marginLeft: '5px'}}>
          <Button icon="refresh" aria-label="Refresh" disabled={list.isFetching} minimal onClick={() => list.refetch()}/>
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
              inputValueRenderer={branch => branch}
              noResults={<MenuItem disabled={true} text="No results." />}
              onItemSelect={handleBranchChange}
              inputProps={{
                leftIcon: 'filter',
                intent: !!search ? Intent.PRIMARY : null,
              }}
              intent={!!search ? 'primary' : 'default'}
              placeholder="Filter..."
              onQueryChange={query => {
                setWantsBranches(true);
                onSearchChange(query);
              }}
            />
        }
        {route.is_history &&
          <InputGroup
            value={filter}
            placeholder="Path, configuration, platform, tag, tuning parameters (key:value)..."
            onChange={onFilterChange}
            type="search"
            leftIcon="filter"
            style={{width: '450px'}}
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
