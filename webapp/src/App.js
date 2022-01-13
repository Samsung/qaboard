import React from "react";
import { Provider } from 'react-redux'
import history from "./history";
// https://github.com/remix-run/react-router/blob/main/docs/upgrading/v5.md
import { Router, Route, Switch } from "react-router-dom";
import { PersistGate } from 'redux-persist/integration/react'

import { Classes } from "@blueprintjs/core";

import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";
import IeDeprecationWarning from './components/IeDeprecationWarning'

import { fetchProjects, fetchProject } from './actions/projects'

import "../node_modules/@blueprintjs/core/lib/css/blueprint.css";
import "../node_modules/@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../node_modules/@blueprintjs/select/lib/css/blueprint-select.css";
import "../node_modules/@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import "./App.css";

import { routes } from './routes'
import { sider_width } from './AppSider'

const Footer = () => {
  return <div style={{margin: "10px", textAlign: "right"}}>
     <span className={Classes.TEXT_MUTED}>Made with <span role="img" aria-label="<3">❤️</span> at Samsung, under <a href="https://github.com/Samsung/qaboard">Apache License 2.0</a></span> 
  </div>
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  componentDidMount() {
    this.props.store.dispatch(fetchProjects())
    const state = this.props.store.getState()
    if (state.selected.project !== null)
      fetchProject(state.selected.project)
    const selected = state.selected[state.selected.project]
    if (selected.new_project !== null)
      fetchProject(selected.new_project)
    if (selected.ref_project !== null)
      fetchProject(selected.ref_project)
  }


  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({error, info})
    console.log(error, info);
  }

  render() {
    if (this.state.hasError)
      return <ErrorPage error={this.state.error} info={this.state.info}/>
	  return <Provider store={this.props.store}>
      <PersistGate loading={null} persistor={this.props.persistor}>
        <IeDeprecationWarning/>
        <Router history={history}>
          <Switch>
            <Route exact path="/" component={ProjectsList} />
            <Route component={ProjectApp} />
          </Switch>
        </Router>
      </PersistGate>
    </Provider>
  }
}





class ProjectApp extends React.Component {
  render() {
    return <Layout className={Classes.UI_TEXT}>
      <Switch>
        {routes.map((route, index) => (
          <Route
            key={index}
            path={route.path}
            component={route.sider}
            displayName={`sider-${route.path}`}
          />
        ))}
      </Switch>
      <div style={{width: '100%'}}>
        <Switch>
        {routes.map((route, index) => (
          <Route
            key={index}
            path={route.path}
            component={route.navbar}
            displayName={`navbar-${route.path}`}
          />
        ))}
        </Switch>
        <div style={{paddingLeft: sider_width}}>
          <Switch>
            {routes.map((route, index) => (
              <Route
                key={index}
                path={route.path}
                component={route.main}
                displayName={`main-${route.path}`}
              />
            ))}
          </Switch>
          <Footer/>
        </div>
      </div>
    </Layout>
  }
}



  

export default App;
