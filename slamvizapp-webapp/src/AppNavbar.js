import React, { Component, Fragment } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";

import { Suggest } from "@blueprintjs/select";
import {
  Navbar,
  NavbarGroup,
  NavbarHeading,
  NavbarDivider,
  MenuItem,
  Classes,
  Button,
  InputGroup
} from "@blueprintjs/core";

import { fetchBranches, fetchProjects } from './actions/projects'


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


class AppNavbar extends Component {

  maybeFetchBranches = ({force_fetch}) => {
    const { is_loading, is_home, project, dispatch, branches} = this.props;
    if (!is_loading && !is_home && project && (branches.length===0 || force_fetch) ) 
      dispatch(fetchBranches(project))
  }

  componentDidMount() {
    this.maybeFetchBranches({force_fetch: true});
    this.props.dispatch(fetchProjects())
  }


  renderInputValue = branch => branch;
  handleBranchChange = branch => {
    const { project } = this.props;
    this.props.history.push(`/branch/${branch}?project=${project}`);
  };

  handleCommitChange = event => {
    const { project } = this.props;
    this.props.history.push(`/commit/${event.target.value}?project=${project}`);
  };

  render() {
    const { is_home, project, branches } = this.props;
    return (
      <Navbar className={Classes.DARK}>
        <NavbarGroup>
          <NavbarHeading>
            {is_home ? (
              "SIRC"
            ) : (
              <Link style={{ color: "#fff" }} to={`/?project=${project}`}>
                {project}
              </Link>
            )}
          </NavbarHeading>
          {!is_home && (
            <Fragment>
              <Button disabled minimal icon="git-branch" />
              <Suggest
                itemPredicate={filterBranch}
                items={branches}
                itemRenderer={renderBranch}
                inputValueRenderer={this.renderInputValue}
                noResults={<MenuItem disabled={true} text="No results." />}
                onItemSelect={this.handleBranchChange}
                popoverProps={Classes.MINIMAL}
                placeholder="View branch..."
                onQueryChange={this.maybeFetchBranches}
              />
              <NavbarDivider />
              <InputGroup
                leftIcon="git-commit"
                placeholder="View commit..."
                onChange={this.handleCommitChange}
              />
            </Fragment>
          )}
        </NavbarGroup>
        <NavbarGroup align="right">
          {!is_home && (
            <Link style={{ color: "#fff" }}  to="/projects">
              <Button minimal icon="home">
                All projects
              </Button>
            </Link>
          )}
        </NavbarGroup>
      </Navbar>
    );
  }
}


const mapStateToProps = (state, ownProps) => {
  // console.log(state)
  // console.log(ownProps.location)
  const params = new URLSearchParams(ownProps.location.search);
  let is_home = ownProps.location.pathname.startsWith("/projects");
  // console.log(is_home)
  if (is_home) return {is_home: true}

  let project = params.get("project") || state.selected.project;
  // console.log(project)
  if (!state.projects.data[project]) {
    return {
      project,
      is_home: false,
      branches: [],
    };
  }
  // console.log(project)
  return {
    is_home,
    project,
    branches: state.projects.data[project].branches ||  [],
    is_loading: state.projects.data[project].branches_loading,
  }
}

export default withRouter(connect(mapStateToProps)(AppNavbar) );
