import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import { get } from "axios";

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
  return branch.toLowerCase().indexOf(query.toLowerCase()) >= 0;
}

class AppNavbar extends Component {
  constructor(props) {
    super(props);
    this.state = {
      branches: []
    };
  }

  componentDidMount() {
    const params = new URLSearchParams(this.props.location.search);
    let project = params.get("project") || "dvs/psp_swip";
    get("/api/v1/project/branches", { params: { project } })
      .then(response => {
        this.setState({
          branches: response.data
        });
      })
      .catch(error => {
        console.error(error);
      });
  }

  renderInputValue = branch => branch;
  handleBranchChange = branch => {
    const params = new URLSearchParams(this.props.location.search);
    let project = is_home ? "SIRC" : params.get("project") || "dvs/psp_swip";
    this.props.history.push(`/branch/${branch}?project=${project}`);
  };

  handleCommitChange = event => {
    const params = new URLSearchParams(this.props.location.search);
    let project = is_home ? "SIRC" : params.get("project") || "dvs/psp_swip";
    this.props.history.push(`/commit/${event.target.value}?project=${project}`);
  };

  render() {
    const params = new URLSearchParams(this.props.location.search);
    let is_home = this.props.location.pathname.startsWith("/projects");
    let project = is_home ? "SIRC" : params.get("project") || "dvs/psp_swip";
    return (
      <Navbar className="pt-dark">
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
              <Button disabled className="pt-minimal" icon="git-branch" />
              <Suggest
                itemPredicate={filterBranch}
                items={this.state.branches}
                itemRenderer={renderBranch}
                inputValueRenderer={this.renderInputValue}
                noResults={<MenuItem disabled={true} text="No results." />}
                onItemSelect={this.handleBranchChange}
                popoverProps={Classes.MINIMAL}
                placeholder="Filter by branch..."
                initialContent="Filter by branch..."
                onFocus={this.getBranches}
              />
              <NavbarDivider />
              <InputGroup
                leftIcon="git-commit"
                placeholder="Go to commit or folder..."
                onChange={this.handleCommitChange}
              />
            </Fragment>
          )}
        </NavbarGroup>
        <NavbarGroup align="right">
          {!is_home && (
            <Link to="/projects">
              <Button className="pt-minimal" icon="home">
                All projects
              </Button>
            </Link>
          )}
        </NavbarGroup>
      </Navbar>
    );
  }
}

export default withRouter(AppNavbar);
