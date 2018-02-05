import React, { Component } from "react";
import { BrowserRouter as Router, Route } from "react-router-dom";

import AppNavbar from "./AppNavbar"
import CiCommitList from "./CiCommitList";
import CiCommitResults from "./CiCommitResults";

import '../node_modules/@blueprintjs/core/lib/css/blueprint.css';
import '../node_modules/@blueprintjs/icons/lib/css/blueprint-icons.css';
import '../node_modules/@blueprintjs/select/lib/css/blueprint-select.css';


class App extends Component {
  render() {
    return (
      <Router>
        <div className="pt-ui-text">
          <AppNavbar />
          <Route exact path="/" component={CiCommitList} />
          <Route path="/branch/(.*)" component={CiCommitList} />
          <Route path="/commit/(.*)" component={CiCommitDetails} />
          <Route path="/tuning" component={CiCommitTuning} />
        </div>
      </Router>
    );
  }
}

const CiCommitDetails = () => <CiCommitResults/>;
// ci_commit=this.state.ci_commits[this.state.]
const CiCommitTuning = () => <p>todo</p>;

export default App;
