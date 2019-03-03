import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
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
  NavbarHeading,
  FormGroup,
  InputGroup,
  MenuItem,
  Button,
  Icon,
} from "@blueprintjs/core";


import { updateSelected } from "./actions/selected";
import { fetchBranches, fetchCommits } from './actions/projects'

import {
	projectSelector,
	projectDataSelector,
	commitsDataSelector,
	commitsSelector,
	branchesSelector,
	selectedSelector,
} from './selectors/projects'


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

   // left: 151px;
   // padding-left: 0px !important;
`

class AppNavbar extends Component {

  update = (attribute, attribute_url) => e => {
  	const value = (e.target && e.target.value) || e;
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
    const { is_home, branches, commits, match, project_data, date_range } = this.props;
    const reference_branch = project_data.information.qatools_config.project.reference_branch;

    const is_project_home = this.props.match.path === "/:project_id+/commits" || this.props.match.path === "/:project_id+"
    const is_commit = this.props.match.path.startsWith('/:project_id+/commit/');
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
              const { project, branch, aggregated_metrics, dispatch } = this.props;
              const is_dashboard = this.props.match.path.startsWith('/:project_id+/dashboard');
              const options = is_dashboard ? {only_ci_batches: true, with_outputs: true} : {};
              dispatch(fetchCommits(project, branch, new_date_range, aggregated_metrics), options)
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
  let commits = commitsSelector(state)

  let selected = selectedSelector(state)


  // console.log(project)
  return {
    is_home,
    project,
    project_data,

    branches: branchesSelector(state),
    is_loading: project_data.branches_loading,
    commits,

    // we rely on URL changes to trigger fetches of new data
    // selected,

    date_range: commits_data.date_range,
    filter_batch_new: selected.filter_batch_new,
  }
}

export default withRouter(connect(mapStateToProps)(AppNavbar) );
