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


// store:
//   projects: qatools_config, metrics...
//   


// ​const getVisibleTodos = (todos, filter) => {
//   switch (filter) {
//     case 'SHOW_COMPLETED':
//       return todos.filter(t => t.completed)
//     case 'SHOW_ACTIVE':
//       return todos.filter(t => !t.completed)
//     case 'SHOW_ALL':
//     default:
//       return todos
//   }
// }
// ​
// const mapStateToProps = state => {
//   return {
//     selected_project: state.selected_project,
//     projects: state.selected_projects,

//     commits: state.commits,
//     new_batch: 
//     getVisibleTodos(state.todos, state.visibilityFilter)
//   }
// }

// const mapDispatchToProps = dispatch => {
//   return {
//     updatedSelectedProject: id => {
//       dispatch(toggleTodo(id))
//     }
//   }
// }



// localstroage
// https://github.com/elgerlambert/redux-localstorage/tree/1.0-breaking-changes
// http://yeoman.io/codelab/local-storage.html
export default App;
