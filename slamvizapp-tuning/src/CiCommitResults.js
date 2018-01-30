import React, { Component } from "react";
import { withRouter } from 'react-router'

import styled from "styled-components";
import { NonIdealState } from "@blueprintjs/core";

const Container = styled.div`
  padding-left: 0;
  list-style: none;
  margin-top: 20px;
  margin-bottom: 10px;
  box-sizing: border-box;

  padding-right: 15px;
  padding-left: 15px;
  margin-right: auto;
  margin-left: auto;
  @media (min-width: 768px) {
    width: 750px;
  }
  @media (min-width: 992px) {
    width: 970px;
  }
  @media (min-width: 1200px) {
    width: 1170px;
  }
`;


class CiCommitResults extends Component {
	render() {
		var result = <NonIdealState title="No commit found" description="Your search didn't return any commit." visual="pt-icon-folder-open" />
		return <Container>{result}</Container>;
	}
}


export default withRouter(CiCommitResults);
