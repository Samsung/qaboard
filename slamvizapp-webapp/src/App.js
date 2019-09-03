import React from "react";
import { Provider } from 'react-redux'
import history from "./history";
import { Router, Route, Switch } from "react-router-dom";
import { PersistGate } from 'redux-persist/integration/react'

import { Classes } from "@blueprintjs/core";

import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";

import { fetchProjects } from './actions/projects'

import "../node_modules/@blueprintjs/core/lib/css/blueprint.css";
import "../node_modules/@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../node_modules/@blueprintjs/select/lib/css/blueprint-select.css";
import "../node_modules/@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import "./App.css";

import { routes } from './routes'


class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  componentDidMount() {
    this.props.store.dispatch(fetchProjects())
  }


  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({error: JSON.stringify(error), info})
    console.log(error, info);
  }

  render() {
    if (this.state.hasError)
      return <ErrorPage error={this.state.error} info={this.state.info}/>
	  return <Provider store={this.props.store}><PersistGate loading={null} persistor={this.props.persistor}>
	    <Router history={history}>
        <Switch>
          <Route exact path="/" component={ProjectsList} />
          <Route component={ProjectApp} />
        </Switch>
      </Router>
	  </PersistGate></Provider>
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
          />
        ))}
        </Switch>
        <div style={{paddingLeft: '151px'}}>
          <Switch>
            {routes.map((route, index) => (
              <Route
                key={index}
                path={route.path}
                component={route.main}
              />
            ))}
          </Switch>
        </div>
      </div>
    </Layout>
  }
}



  

export default App;
