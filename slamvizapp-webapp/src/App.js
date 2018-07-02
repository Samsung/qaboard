import React, { Component } from "react";
import { BrowserRouter as Router, Route } from "react-router-dom";
// import { Provider } from 'react-redux'
import { CookiesProvider } from "react-cookie";

import AppNavbar from "./AppNavbar";
import CiCommitList from "./CiCommitList";
import CiCommitResults from "./CiCommitResults";
import ProjectsList from "./ProjectsList";
import Dashboard from "./Dashboard";

import "../node_modules/@blueprintjs/core/lib/css/blueprint.css";
import "../node_modules/@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../node_modules/@blueprintjs/select/lib/css/blueprint-select.css";
import "../node_modules/@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import "./App.css";

// const Root = ({ store }) => (
//   <Provider store={store}>
//     <Router>
//       <Route path="/" component={App} />
//     </Router>
//   </Provider>
// )

class App extends Component {
  render() {
    return (
      // <React.StrictMode>
      <CookiesProvider>
        <Router>
          <div className="pt-ui-text">
            <AppNavbar />
            <Route exact path="/" component={CiCommitList} />
            <Route path="/branch/(.*)" component={CiCommitList} />
            <Route path="/committer/(.*)" component={CiCommitList} />
            <Route path="/commit/(.*)" component={CiCommitResults} />
            <Route path="/projects" component={ProjectsList} />
            <Route path="/dashboard" component={Dashboard} />
          </div>
        </Router>
      </CookiesProvider>
      // </React.StrictMode>
    );
  }
}

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
//     projects: state.projects,

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
// const ConnectedApp = connect(
//   mapStateToProps,
//   mapDispatchToProps
// )(App)
// export default Root;

export default App;
