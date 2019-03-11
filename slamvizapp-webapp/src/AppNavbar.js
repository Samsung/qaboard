import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import qs from "qs";
import styled from "styled-components";

import { Suggest } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";
import {
  Classes,
  Colors,
  Intent,
  Navbar,
  NavbarGroup,
  FormGroup,
  InputGroup,
  MenuItem,
  Button,
  Icon,
  Tag,
  Tooltip,
} from "@blueprintjs/core";


import { updateSelected } from "./actions/selected";
import { fetchBranches, fetchCommits } from './actions/projects'
import { fetchCommit } from './actions/commit'
import { SelectBatchesNav } from "./components/tuning/SelectBatches";
import { CommitNavbar } from "./components/CommitNavbar";

import {
	projectSelector,
	projectDataSelector,
	commitsDataSelector,
	branchesSelector,
	selectedSelector,
  commitSelector,
  batchSelector,
} from './selectors/projects'


class BatchTags extends React.PureComponent {
  render() {
    if (this.props.batch === undefined || this.props.batch === null)
      return <span/>
    const { valid_outputs, running_outputs, pending_outputs, failed_outputs } = this.props.batch;
    return <>
      {valid_outputs > 0 && (
        <Tag intent={Intent.SUCCESS} minimal round>
          {valid_outputs} outputs
        </Tag>
      )}{" "}
      {running_outputs > 0 && (
        <Tag intent={Intent.SUCCESS} minimal round>
          {running_outputs} running
        </Tag>
      )}{" "}
      {pending_outputs - running_outputs > 0 && (
        <Tag minimal round>
          {pending_outputs - running_outputs}{" "}
          pending
        </Tag>
      )}{" "}
      {failed_outputs > 0 && (
        <Tag intent={Intent.DANGER} minimal round>
          {failed_outputs} crashed
        </Tag>
      )}
    </>
  }
}


const renderBranch = (item, { handleClick, modifiers, query }) => {
  return (
    <MenuItem
      className={!modifiers.active ? Classes.ACTIVE : Classes.INTENT_PRIMARY}
      key={item}
      onClick={handleClick}
      text={item}
    />
  );
};

function filterBranch(query, branch) {
  if (!query) return true;
  return branch.toLowerCase().indexOf(query.toLowerCase()) >= 0;
}


const StyledNavbar = styled(Navbar)`
   position: fixed !important;
   top: 0;
   padding-left: 151px !important;
`

const StyledNavbarNew = styled(Navbar)`
   position: fixed !important;
   padding-left: 151px !important;
   height: 75px !important;
   top: 0 !important;
`
const StyledNavbarRef = styled(Navbar)`
   position: fixed !important;
   padding-left: 151px !important;
   height: 75px !important;
   top: 75px !important;
`



class AppNavbar extends Component {

  update = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  }

  maybeFetchBranches = ({force_fetch}) => {
    const { is_loading, is_home, project, dispatch, branches} = this.props;
    if (!is_loading && !is_home && project && (branches.length===0 || force_fetch) ) 
      dispatch(fetchBranches(project))
  }

  renderInputValue = branch => branch;
  handleBranchChange = branch => {
    const { project } = this.props;
    this.props.dispatch(updateSelected(project, { branch, committer: null }))
    this.props.history.push(`/${project}/commits/${branch}`);
  };

  componentDidMount() {
    this.maybeFetchBranches({force_fetch: true});
  }

  render() {
    const { branches, commits, match, project, project_data, date_range, selected, dispatch, selected_views } = this.props;
    const { new_commit, ref_commit, new_batch, ref_batch, new_batch_filtered, ref_batch_filtered, filter_batch_new, filter_batch_ref, selected_batch_new, selected_batch_ref } = this.props;
    const reference_branch = project_data.information.qatools_config.project.reference_branch;

    let show_ref_navbar = ! (selected_views === 'logs' || selected_views === 'tuning' || selected_views === 'groups')

    const is_commit = this.props.match.path.startsWith('/:project_id+/commit/');
    if (is_commit) {
      const nb_good = batch => (Object.values(batch.outputs).filter(o => !o.is_failed && !o.is_pending) || []).length;
      const nb_outputs_new = nb_good(new_batch);
      const nb_outputs_ref = nb_good(ref_batch);
      return <>
        <StyledNavbarNew>
          <NavbarGroup style={{marginLeft: '20px'}}>
            <CommitNavbar dispatch={dispatch} commit={new_commit} batch={new_batch_filtered} project={project} project_data={project_data} selected={selected} label="new"/>
          </NavbarGroup>

          <NavbarGroup align="right">
            {nb_outputs_new>0 && <FormGroup
              style={{marginTop: '36px'}}
              labelFor="filter-new-input"
              helperText={<Tooltip>
                <><BatchTags batch={new_batch_filtered}/> <Icon style={{marginLeft: '5px', color: Colors.GRAY2}} icon="help"/></>
                <div><span>You can filter outputs by all their properties: path, configuration, platform, tags or tuning parameters (key:value).</span></div>
              </Tooltip>}
            >
              <InputGroup
                value={filter_batch_new}
                placeholder="filter new outputs"
                onChange={this.update('filter_batch_new', 'filter')}
                type="search"
                leftIcon="filter"
              />
            </FormGroup>}
            <SelectBatchesNav
              commit={new_commit}
              selected={selected_batch_new}
              onChange={this.update('batch_new')}
              prefix={<Tag intent={Intent.WARNING}>New commit</Tag>}
              hide_helper_text
              hide_counts
            />
            {!!new_commit && !!commits[new_commit.id] && <>
              <Button className={Classes.TEXT_MUTED} minimal icon="refresh" disabled={!!new_commit && new_commit.id && !this.props.commits[new_commit.id].is_loaded} onClick={() => this.props.dispatch(fetchCommit(project, new_commit.id, `new_commit_id`))} ></Button>
              <a href={`/api/v1/commit/${!!new_commit && new_commit.id}?project=${project}`}><Button className={Classes.TEXT_MUTED} minimal icon="import"></Button></a>
            </>}
          </NavbarGroup>
        </StyledNavbarNew>

        {show_ref_navbar && <StyledNavbarRef>
          <NavbarGroup style={{marginLeft: '20px'}}>
            <CommitNavbar dispatch={dispatch} commit={ref_commit} batch={ref_batch_filtered} project={project} project_data={project_data} selected={selected} label="ref"/>
          </NavbarGroup>
          <NavbarGroup align="right">
            {nb_outputs_ref>0 && <FormGroup
              style={{marginTop: '36px'}}
              labelFor="filter-ref-input"
              helperText={<BatchTags batch={ref_batch_filtered}/>}
            >
              <InputGroup
                value={filter_batch_ref}
                placeholder="filter reference outputs"
                onChange={this.update('filter_batch_ref', 'filter')}
                type="search"
                leftIcon="filter"
              />
            </FormGroup>}
            <SelectBatchesNav
              commit={ref_commit}
              selected={selected_batch_ref}
              onChange={this.update('batch_ref')}
              prefix={<Tag intent={Intent.WARNING}>Ref commit</Tag>}
              hide_helper_text
              hide_counts
            />
            {!!ref_commit && !!commits[ref_commit.id] && <>
              <Button className={Classes.TEXT_MUTED} minimal icon="refresh" disabled={!!ref_commit && ref_commit.id && !commits[ref_commit.id].is_loaded} onClick={() => this.props.dispatch(fetchCommit(project, ref_commit.id, `ref_commit_id`))} ></Button>
              <a href={`/api/v1/commit/${!!ref_commit && ref_commit.id}?project=${project}`}><Button className={Classes.TEXT_MUTED} minimal icon="import"></Button></a>
            </>}
          </NavbarGroup>
        </StyledNavbarRef>}
      </>
    }


    const is_project_home = this.props.match.path === "/:project_id+/commits" || this.props.match.path === "/:project_id+"
    const is_dashboard = this.props.match.path.startsWith('/:project_id+/dashboard/');

    let is_committer = !!match.params.committer;
    let is_branch = !!match.params.name;
    if (is_branch || is_committer)
      var tag = match.params.name || match.params.committer;
    else tag = reference_branch;

    let some_commits_loaded = !!commits && commits.length > 0;
    const first_commit_date = (some_commits_loaded && commits[commits.length - 1].authored_datetime) || date_range[0]
    const last_commit_date = (some_commits_loaded && commits[0].authored_datetime)  || date_range[1]
    const effective_date_range = [
      (!!first_commit_date ? new Date(first_commit_date) : null),
      (!!last_commit_date ? new Date(last_commit_date) : null)
    ]

    const date_input_props = {style: {width:'100px'}}
    const tag_icon = <Icon icon={is_branch ? "git-branch" : (is_committer ? 'user' : null)} style={{marginRight: '5px'}}/>
    return (
      <StyledNavbar>
        <NavbarGroup style={{marginLeft: '20px'}}>
          {!is_commit && <DateRangeInput
          	endInputProps={date_input_props}
          	startInputProps={date_input_props}
            value={effective_date_range}
            maxDate={new Date()}
            allowSingleDayRange
            formatDate={date =>
              date == null ? "" : date.toLocaleDateString()
            }
            parseDate={str => new Date(Date.parse(str))}
            onChange={new_date_range => {
              const { project, aggregated_metrics, dispatch } = this.props;
              const is_dashboard = this.props.match.path.startsWith('/:project_id+/dashboard');
              const options = is_dashboard ? {only_ci_batches: true, with_outputs: true} : {};
              dispatch(fetchCommits(project, {...this.props.match.params}, new_date_range, aggregated_metrics), options)
            }}
            shortcuts
          />}
          {!is_project_home && !is_commit && <b style={{marginLeft: '15px', color: Colors.DARK_GRAY3}}>{tag_icon}{(is_committer || is_branch) && tag}</b>}
        </NavbarGroup>
        <NavbarGroup align="right">

          {is_project_home &&
              <Suggest
                itemPredicate={filterBranch}
                items={branches}
                itemRenderer={renderBranch}
                inputValueRenderer={this.renderInputValue}
                noResults={<MenuItem disabled={true} text="No results." />}
                onItemSelect={this.handleBranchChange}
                popoverProps={Classes.MINIMAL}
                inputProps={{leftIcon: 'git-branch'}}
                placeholder="View branch..."
                onQueryChange={this.maybeFetchBranches}
              />
          }

        {is_dashboard &&
          <InputGroup
            value={this.props.filter_batch_new}
            placeholder="Path, configuration, platform, tag, tuning parameters (key:value)..."
            onChange={this.update('filter_batch_new', 'filter')}
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
  // let commits = commitsSelector(state)

  let selected = selectedSelector(state)

  let { new_commit, ref_commit } = commitSelector(state)
  let {
    selected_batch_new,
    selected_batch_ref,
    new_batch,
    ref_batch,
    new_batch_filtered,
    ref_batch_filtered,
  } = batchSelector(state)

  let selected_views = selected.selected_views || ((project_data.information.qatools_config.outputs || {}).default_tab_details || 'summary')

  // console.log(project)
  return {
    is_home,
    project,
    project_data,

    branches: branchesSelector(state),
    is_loading: project_data.branches_loading,
    commits: state.commits,

    new_commit,
    ref_commit,
    selected_batch_new,
    selected_batch_ref,
    new_batch,
    ref_batch,
    new_batch_filtered,
    ref_batch_filtered,

    date_range: commits_data.date_range,
    filter_batch_new: selected.filter_batch_new,

    selected,
    selected_views,
  }
}

export default withRouter(connect(mapStateToProps)(AppNavbar) );
