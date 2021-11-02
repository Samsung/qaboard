import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import styled from "styled-components";

import { Suggest } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";
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

import { updateSelected } from "./actions/selected";
import { fetchBranches, fetchCommits } from './actions/projects'
import { CommitNavbar } from "./components/CommitNavbar";
import { SelectBatchesNav } from "./components/tuning/SelectBatches";

import {
	projectSelector,
	projectDataSelector,
	commitsDataSelector,
	commitsSelector,
	branchesSelector,
	selectedSelector,
  commitSelector,
  batchSelector,
} from './selectors/projects'

import { sider_width } from './AppSider'




const renderBranch = (item, { handleClick, modifiers, query }) => {
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

const StyledNavbarNew = styled(Navbar)`
   position: fixed !important;
   padding-left: ${sider_width} !important;
   height: 75px !important;
   top: 0 !important;
`
const StyledNavbarRef = styled(Navbar)`
   position: fixed !important;
   padding-left: ${sider_width} !important;
   height: 75px !important;
   top: 75px !important;
`



class AppNavbar extends Component {

  update = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
  }

  maybeFetchBranches = ({force_fetch}) => {
    const { is_loading_branches, is_home, project, dispatch, branches} = this.props;
    if (!is_loading_branches && !is_home && project && (branches.length===0 || force_fetch) ) 
      dispatch(fetchBranches(project))
  }

  renderInputValue = branch => branch;
  handleBranchChange = branch => {
    const { project } = this.props;
    if (branch.commit !== undefined && branch.commit !== null) {
      this.props.dispatch(updateSelected(project, { new_commit_id: branch.commit }))
      this.props.history.push(`/${project}/commit/${branch.commit}`);
    } else {
      this.props.dispatch(updateSelected(project, { branch, committer: null }))
      this.props.history.push(`/${project}/commits/${branch}`);
    }
  };

  update_selected_batches = event => {
    const { project } = this.props;
    let label = event.target.value
    this.props.dispatch(updateSelected(project, { selected_batch_new: label, selected_batch_ref: label }))    
  }

  componentDidMount() {
    this.maybeFetchBranches({force_fetch: true});
  }

  render() {
    const {
      selected_views,
      project,
      project_data,
      date_range,
      branches,
      commits,
      selected,
      new_commit,
      ref_commit,
      selected_batch_new,
      new_batch,
      ref_batch,
      filter_batch_new,
      filter_batch_ref,
      dispatch,
      match,
    } = this.props;

    let show_ref_navbar = ! (selected_views.includes('logs') || selected_views.includes('tuning') || selected_views.includes('groups'))

    const is_commit = match.path.startsWith('/:project_id+/commit')
                   && !match.path.startsWith('/:project_id+/commits')
                   && !match.path.startsWith('/:project_id+/committer');
    if (is_commit) {
      return <>
        <StyledNavbarNew>
          <CommitNavbar
            dispatch={dispatch}
            update={this.update}
            loading={!commits[this.props.selected.new_project]?.[new_commit?.id]?.is_loaded}
            commit={new_commit}
            batch={new_batch}
            filter={filter_batch_new}
            project={project}
            project_data={project_data}
            selected={selected}
            type="new"
          />
        </StyledNavbarNew>
        {show_ref_navbar && <StyledNavbarRef>
          <CommitNavbar
            dispatch={dispatch}
            update={this.update}
            commit={ref_commit}
            batch={ref_batch}
            filter={filter_batch_ref}
            project={project}
            loading={commits[this.props.selected.ref_project]?.[ref_commit?.id]?.is_loaded}
            project_data={project_data}
            selected={selected}
            type="ref"
          />
        </StyledNavbarRef>}
      </>
    }
    /*<a rel="noopener noreferrer" target="_blank" href={`/api/v1/commit/${!!new_commit && new_commit.id}?project=${project}`}><Button className={Classes.TEXT_MUTED} minimal icon="database"></Button></a>*/


    const is_project_home = match.path === "/:project_id+/commits" || match.path === "/:project_id+"
    const is_project_branch_home = match.path === "/:project_id+/commits/:name+"
    const is_dashboard = match.path.startsWith('/:project_id+/history/');

    // let is_committer = !!match.params.committer;
    // let is_branch = !!match.params.name;
    // if (is_branch || is_committer)
    //   var tag = match.params.name || match.params.committer;
    // else tag = reference_branch;

    let some_commits_loaded = !!commits && commits.length > 0;
    const first_commit_date = (some_commits_loaded && commits[commits.length - 1].authored_datetime) || date_range[0]
    const last_commit_date = (some_commits_loaded && commits[0].authored_datetime)  || date_range[1]
    // const effective_date_range = [
    //   (!!first_commit_date ? new Date(first_commit_date) : null),
    //   (!!last_commit_date ? new Date(last_commit_date) : null)
    // ]

    const date_input_props = {style: {width:'100px'}}
    // const tag_icon = <Icon icon={is_branch ? "git-branch" : (is_committer ? 'user' : null)} style={{marginRight: '5px'}}/>
    return (
      <StyledNavbar>
        <NavbarGroup style={{marginLeft: '20px'}}>
          {!is_commit && <DateRangeInput
          	endInputProps={date_input_props}
          	startInputProps={date_input_props}
            value={date_range}
            maxDate={new Date()}
            allowSingleDayRange
            formatDate={date =>
              date == null ? "" : date.toLocaleDateString()
            }
            parseDate={str => new Date(Date.parse(str))}
            onChange={new_date_range => {
              const { project, aggregated_metrics, dispatch } = this.props;
              let extended_date_range = [new_date_range[0], new_date_range[1]]
              extended_date_range[0].setHours(0,0,0,0);
              extended_date_range[1].setHours(23,59,59,999);
              const is_dashboard = match.path.startsWith('/:project_id+/history');
              const options = is_dashboard ? {only_ci_batches: selected_batch_new === 'default', with_outputs: true} : {};
              dispatch(fetchCommits(project, {...match.params}, new_date_range, aggregated_metrics, options))
            }}
            shortcuts
          />}
          {<div style={{marginLeft: '5px'}}>
              <Button icon="refresh"
                      disabled={this.props.is_loading}
                      minimal
                      onClick={() =>{
                          const { project, aggregated_metrics, dispatch } = this.props;
                          let extended_date_range = [date_range[0], date_range[1]]
                          extended_date_range[0].setHours(0,0,0,0);
                          extended_date_range[1].setHours(23,59,59,999);
                          const is_dashboard = match.path.startsWith('/:project_id+/history');
                          const options = is_dashboard ? {only_ci_batches: selected_batch_new === 'default', with_outputs: true} : {};
                          dispatch(fetchCommits(project, {...match.params}, extended_date_range, aggregated_metrics, options))
                        }
                      }
              />
          </div>}
          {this.props.is_loading && <div style={{marginLeft: '15px'}}><Spinner size={Spinner.SIZE_SMALL} /></div>}
        </NavbarGroup>
        <NavbarGroup align="right">
          {is_dashboard && <SelectBatchesNav
            commit={new_commit}
            batch={new_batch}
            onChange={this.update_selected_batches}
            hide_counts
          />}
          {(is_project_home || is_project_branch_home) &&
              <Suggest
                query={selected.search}
                itemPredicate={filterBranch}
                createNewItemFromQuery={query => ({commit: query.trim()})}
                createNewItemRenderer={renderNewItem}
                items={branches}
                itemRenderer={renderBranch}
                inputValueRenderer={this.renderInputValue}
                noResults={<MenuItem disabled={true} text="No results." />}
                onItemSelect={this.handleBranchChange}
                inputProps={{
                  leftIcon: 'filter',
                  intent: (!!selected.search && selected.search.length > 0) ? Intent.PRIMARY : null,
                }}
                intent={!!selected.search ? 'primary' : 'default'}
                placeholder="Filter..."
                onQueryChange={query => {
                  this.maybeFetchBranches({});
                  this.update('search')(query)
                }}
              />
          }

        {is_dashboard &&
          <InputGroup
            value={this.props.filter_batch_new}
            placeholder="Path, configuration, platform, tag, tuning parameters (key:value)..."
            onChange={this.update('filter_batch_new')}
            type="search"
            leftIcon="filter"
            style={{width: '450px'}}
          />}
        </NavbarGroup>
      </StyledNavbar>
    );
  }
}


const mapStateToProps = (state, ownProps) => {
  // const params = new URLSearchParams(ownProps.location.search);
  let is_home = ownProps.location.pathname === '/';
  if (is_home) return {is_home: true}

  let project = projectSelector(state)
  let project_data = projectDataSelector(state)
  let commits_data = commitsDataSelector(state)
  let selected = selectedSelector(state)
  let { new_commit, ref_commit } = commitSelector(state)
  let {
    selected_batch_new,
    new_batch,
    ref_batch,
    new_batch_filtered,
    ref_batch_filtered,
  } = batchSelector(state)

  const commits = commitsSelector(state)
  let is_branch = !!ownProps.match.params.name;
  let some_commits_loaded = !!commits && commits.length > 0;
  let project_data_ = (is_branch && some_commits_loaded && commits[0]) || project_data
  let project_metrics = project_data_.data?.qatools_metrics || {};
  let aggregated_metrics = {};
  (project_metrics.main_metrics || []).forEach(m => {
    if (project_metrics.available_metrics[m] !== undefined)
      aggregated_metrics[m] = project_metrics.available_metrics[m].target ?? 0
});


  let selected_views = selected.selected_views || project_data.data?.qatools_config?.outputs?.default_tab_details || 'summary'

  return {
    is_home,
    project,
    project_data,
    aggregated_metrics,

    branches: branchesSelector(state),
    is_loading_branches: project_data.branches_loading,
    is_loading: commits_data.is_loading,
    commits: state.commits,

    new_commit,
    ref_commit,
    selected_batch_new,
    new_batch,
    ref_batch,
    new_batch_filtered,
    ref_batch_filtered,

    date_range: commits_data.date_range,
    filter_batch_new: selected.filter_batch_new,
    filter_batch_ref: selected.filter_batch_ref,

    selected,
    selected_views,
  }
}

export default withRouter(connect(mapStateToProps)(AppNavbar) );
