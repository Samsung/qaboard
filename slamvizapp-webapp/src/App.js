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



const App = ({ store }) => (
  <Provider store={store}>
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
)


// add to the project list
// select project
// select commit
// select batch
// init with url
// filter and shown metrics?
// reselect memoiation for filtered_batch and tuning aggregation
// localstorage..
// output_type refactor.. <ImageViewer<ImageView>er> <HexViewer>
// dont redner all tabs, split editor?



// localstroage
// https://github.com/elgerlambert/redux-localstorage/tree/1.0-breaking-changes
// http://yeoman.io/codelab/local-storage.html
export default App;
