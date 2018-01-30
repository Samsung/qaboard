import React, { Component } from "react";
import { BrowserRouter as Router, Route } from "react-router-dom";

import AppNavbar from "./AppNavbar"
import CiCommitList from "./CiCommitList";
import CiCommitResults from "./CiCommitResults";

import "./App.css";

class App extends Component {
  render() {
    return (
      <Router>
        <div className="pt-ui-text">
          <AppNavbar />
          <Route exact path="/" component={CiCommitList} />
          <Route path="/branch/(.*)" component={CiCommitList} />
          <Route path="/commit" component={CiCommitDetails} />
          <Route path="/tuning" component={CiCommitTuning} />
        </div>
      </Router>
    );
  }
}

const CiCommitTuning = () => <p>todo</p>;
const CiCommitDetails = () => <CiCommitResults/>;
// ci_commit=this.state.ci_commits[this.state.]

export default App;
