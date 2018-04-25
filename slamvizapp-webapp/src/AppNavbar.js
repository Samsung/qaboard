import React, { Component } from "react";
import { withRouter } from 'react-router'
import { Link } from "react-router-dom";
import { get } from "axios";

import { Suggest } from "@blueprintjs/select";
import { Navbar, NavbarGroup, NavbarHeading, NavbarDivider,
         MenuItem, Classes,
         Button, InputGroup
} from "@blueprintjs/core";


const renderBranch = ( item, {handleClick, modifiers, query} ) => {
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
      branches: [],
    };
  }

  componentDidMount() {
    get("/api/v1/branches")
    .then(response=>{
       this.setState({
         branches: response.data,
       });
    })
    .catch(error=>{console.error(error);})
  };

  renderInputValue = (branch) => branch;
  handleBranchChange = (branch) => {
    this.props.history.push(`/branch/${branch}`);
  }

  handleCommitChange = (event) => {
    this.props.history.push(`/commit/${event.target.value}`);
  }

  render() {
  	return (
	  <Navbar className="pt-dark">
	    <NavbarGroup>
	      <NavbarHeading>SLAM</NavbarHeading>
	      <Button disabled className="pt-minimal" icon="git-branch"></Button>
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
	       />
	      <NavbarDivider />
	      <InputGroup leftIcon="git-commit" placeholder="Go to commit or folder..." onChange={this.handleCommitChange}/>
	    </NavbarGroup>
	    <NavbarGroup align="right">
	      <Link to="/"><Button className="pt-minimal" icon="home">Recent Commits</Button></Link>
	    </NavbarGroup>
      </Navbar>
    )
  }
}

export default withRouter(AppNavbar);
