import React, { Suspense } from "react";
import { Provider } from 'react-redux'
import { unstable_HistoryRouter as HistoryRouter, useLocation } from "react-router";
import { PersistGate } from 'redux-persist/integration/react'

import { Classes } from "@blueprintjs/core";

import * as Sentry from "@sentry/react";
import { StyleSheetManager } from "styled-components";
import isPropValid from "@emotion/is-prop-valid";

import { history, matchRoutes, RouteMatch } from "./router";
import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";
import EmptyLoading from "./components/EmptyLoading";

import { fetchProjects, fetchProject } from './actions/projects'
import { fetchSiteConfig } from './actions/config'

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
// include blueprint-icons.css for icon font support
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "@blueprintjs/datetime/lib/css/blueprint-datetime.css";

import "./App.css";

import { routes } from './routes'
import PrivateContent from "./components/authentication/PrivateContent"
import { sider_width } from './AppSider'

// Like styled-components@5: don't forward unknown props to DOM elements
// https://styled-components.com/docs/faqs#shouldforwardprop-is-no-longer-provided-by-default
const shouldForwardProp = (prop, target) => typeof target !== "string" || isPropValid(prop);

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

  async initSentry(config) {
    if (!import.meta.env.PROD || !config.sentry_dsn) return;
    Sentry.init({
      dsn: config.sentry_dsn,
      integrations: [
        Sentry.browserTracingIntegration({
          // Group transactions by route, e.g. /:project_id+/commit/:name+
          beforeStartSpan: options => ({
            ...options,
            name: matchRoutes(routes, window.location.pathname)?.route.path ?? window.location.pathname,
          }),
        }),
      ],
      tracesSampleRate: config.sentry_traces_sample_rate ?? 1.0,
      tracePropagationTargets: [/\/api\//],
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
    // Session replays are heavy, only download them when Sentry is used
    const { replayIntegration } = await import('@sentry/replay');
    Sentry.addIntegration(replayIntegration());
  }

  async initPostHog(config) {
    if (!import.meta.env.PROD || !config.posthog_api_key) return;
    // Most deployments don't use PostHog, only download it when needed
    const { default: posthog } = await import('posthog-js');
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
      return <ErrorPage error={this.state.error} info={this.state.info} support_url={this.props.store.getState().siteConfig?.support_url}/>
    return <Provider store={this.props.store}>
      <PersistGate loading={null} persistor={this.props.persistor}>
        <StyleSheetManager shouldForwardProp={shouldForwardProp}>
          <HistoryRouter history={history}>
            <Routes/>
          </HistoryRouter>
        </StyleSheetManager>
      </PersistGate>
    </Provider>
  }
}


const Routes = () => {
  const { pathname } = useLocation();
  if (pathname === "/")
    return <ProjectsList/>
  return <PrivateContent>
    <ProjectApp pathname={pathname}/>
  </PrivateContent>
}


const ProjectApp = ({ pathname }) => {
  const matched = matchRoutes(routes, pathname);
  if (!matched) return null;
  const { route: { sider: Sider, navbar: Navbar, main: Main }, match } = matched;
  return <RouteMatch match={match}>
    <Layout className={Classes.UI_TEXT}>
      <Sider/>
      <div style={{width: '100%'}}>
        <Navbar/>
        <div style={{paddingLeft: sider_width}}>
          <Suspense fallback={<EmptyLoading/>}>
            <Main/>
          </Suspense>
          <Footer/>
        </div>
      </div>
    </Layout>
  </RouteMatch>
}



export default Sentry.withProfiler(App);