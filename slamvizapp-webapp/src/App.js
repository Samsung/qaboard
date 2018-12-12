import React from "react";
import { Provider } from 'react-redux'
import { BrowserRouter as Router, Route } from "react-router-dom";
import { CookiesProvider } from "react-cookie";

import Loadable from 'react-loadable';
import AppNavbar from "./AppNavbar";
import CiCommitList from "./CiCommitList";
import CiCommitResults from "./CiCommitResults";
import ProjectsList from "./ProjectsList";
import EmptyLoading from "./components/EmptyLoading";

import { Classes } from "@blueprintjs/core";
import "../node_modules/@blueprintjs/core/lib/css/blueprint.css";
import "../node_modules/@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../node_modules/@blueprintjs/select/lib/css/blueprint-select.css";
import "../node_modules/@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import "./App.css";


const LoadableDashboard = Loadable({
  loader: () => import('./Dashboard' /* webpackChunkName: "dashboard" */),
  loading: EmptyLoading,
});


class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({error})
    // You can also log the error to an error reporting service
    console.log(error, info);
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return <div>
        <h1>Something went wrong. Please report the bug to Arthur Flam</h1>
        <p>{JSON.stringify(this.state.error)}</p>
       </div>;
    }
	  return <Provider store={this.props.store}>
	    <CookiesProvider>
	      <Router>
	        <div className={Classes.UI_TEXT}>
	          <AppNavbar />
	          <Route path="/projects" component={ProjectsList} />

	          <Route exact path="/" component={CiCommitList} />
	          <Route path="/branch/(.*)" component={CiCommitList} />
	          <Route path="/committer/(.*)" component={CiCommitList} />

	          <Route path="/commit/(.*)" component={CiCommitResults} />

	          <Route path="/dashboard" component={LoadableDashboard} />
	        </div>
	      </Router>
	    </CookiesProvider>
	  </Provider>
  }
}


export default App;
