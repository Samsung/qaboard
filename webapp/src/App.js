import React from "react";
import { Provider } from 'react-redux'
// https://github.com/remix-run/react-router/blob/main/docs/upgrading/v5.md
import { Router, Route, Switch } from "react-router-dom";
import { PersistGate } from 'redux-persist/integration/react'

import { Classes } from "@blueprintjs/core";

import posthog from 'posthog-js'
import * as Sentry from "@sentry/react";
import history from "./history";
const SentryRoute = Sentry.withSentryRouting(Route);

import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";
import IeDeprecationWarning from './components/IeDeprecationWarning'

import { fetchProjects, fetchProject } from './actions/projects'
import { fetchSiteConfig } from './actions/config'

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
// include blueprint-icons.css for icon font support
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import "@blueprintjs/datetime2/lib/css/blueprint-datetime2.css";

import "./App.css";

import { routes } from './routes'
import PrivateContent from "./components/authentication/PrivateContent"
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
    this.props.store.dispatch(fetchSiteConfig()).then(config => {
      this.initSentry(config);
      this.initPostHog(config);
    });
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

  initSentry(config) {
    // https://docs.sentry.io/platforms/javascript/guides/react/configuration/integrations/react-router/
    // https://docs.sentry.io/platforms/javascript/guides/react/features/react-router/
    // TODO: migrate to react-router-v6, then improve the sentry integration
    //       https://reactrouter.com/en/main/upgrading/v5#upgrade-to-react-router-v6
    //       it make require moving to hooks in many places, so at this stage nextjs might make more sense...
    if (process.env.NODE_ENV !== 'production' || !config.sentry_dsn) return;
    Sentry.init({
      dsn: config.sentry_dsn,
      integrations: [
        new Sentry.BrowserTracing({
          routingInstrumentation: Sentry.reactRouterV5Instrumentation(history),
        }),
        new Sentry.Replay(),
      ],
      tracesSampleRate: config.sentry_traces_sample_rate ?? 1.0,
      tracePropagationTargets: [/\/api\//],
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
  }

  initPostHog(config) {
    if (process.env.NODE_ENV !== 'production' || !config.posthog_api_key) return;
    posthog.init(config.posthog_api_key, {
      api_host: config.posthog_host || undefined,
    });
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
              <SentryRoute exact path="/" >
                  <ProjectsList/>
              </SentryRoute>
              <SentryRoute>
                <PrivateContent>
                  <ProjectApp/>
                </PrivateContent>
              </SentryRoute>
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
          <SentryRoute
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
          <SentryRoute
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
              <SentryRoute
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



export default Sentry.withProfiler(App);