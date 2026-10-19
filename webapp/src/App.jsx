import { Suspense, lazy, useEffect } from "react";
import { unstable_HistoryRouter as HistoryRouter, useLocation } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { Classes } from "@blueprintjs/core";

import { StyleSheetManager } from "styled-components";
import isPropValid from "@emotion/is-prop-valid";

import { history, matchRoutes, RouteMatch } from "./router";
import { queryClient, persistOptions, onCacheRestored } from "./api/queryClient";
import { siteConfigQuery } from "./api/queries";
import { ComparisonProvider, useSiteConfig } from "./hooks";
import { initSentry, initPostHog } from "./analytics";
import { Layout } from "./components/layout";
import ProjectsList from "./ProjectsList";
import ErrorPage from "./components/ErrorPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import EmptyLoading from "./components/EmptyLoading";
import Footer from "./components/Footer";
import { ThemeSync } from "./theme";

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
// include blueprint-icons.css for icon font support
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";

import "./App.css";

import { routes } from './routes'
import { ReleaseNotesProvider } from "./releaseNotes/ReleaseNotes"
import { HelpSheetProvider } from "./components/HelpSheet"
import PrivateContent from "./components/authentication/PrivateContent"
import AppSider, { sider_width } from './AppSider'
import AppNavbar from './AppNavbar'
import { MilestoneDialogHost } from "./milestones/MilestoneDialog"
import { ManageMilestonesHost } from "./milestones/ManageMilestones"
import { useImportLegacyMilestones } from "./milestones/hooks"

// In development, inspect queries and their cache: https://tanstack.com/query/latest/docs/framework/react/devtools
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then(m => ({ default: m.ReactQueryDevtools })))
  : () => null;

// Like styled-components@5: don't forward unknown props to DOM elements
// https://styled-components.com/docs/faqs#shouldforwardprop-is-no-longer-provided-by-default
const shouldForwardProp = (prop, target) => typeof target !== "string" || isPropValid(prop);

const route_name = pathname => matchRoutes(routes, pathname)?.route.path ?? pathname;



// Monitoring and analytics, once we know the site's configuration
const Analytics = () => {
  const { data: config } = useQuery(siteConfigQuery);
  useEffect(() => {
    if (!config) return;
    initSentry(config, route_name);
    initPostHog(config);
  }, [config]);
  return null;
}

const Fallback = ({ error, componentStack }) => {
  const { support_url } = useSiteConfig();
  return <ErrorPage error={error} info={{ componentStack }} support_url={support_url}/>;
}


const App = ({ persist = true }) => {
  // Tests don't have IndexedDB: they don't persist the cache
  const Provider = persist ? PersistQueryClientProvider : QueryClientProvider;
  const providerProps = persist ? { client: queryClient, persistOptions, onSuccess: onCacheRestored } : { client: queryClient };
  return <Provider {...providerProps}>
    <ThemeSync/>
    <ErrorBoundary fallback={props => <Fallback {...props}/>}>
      <Analytics/>
      <StyleSheetManager shouldForwardProp={shouldForwardProp}>
        <ReleaseNotesProvider>
          <HelpSheetProvider>
            <HistoryRouter history={history}>
              <Routes/>
            </HistoryRouter>
          </HelpSheetProvider>
        </ReleaseNotesProvider>
      </StyleSheetManager>
    </ErrorBoundary>
    <Suspense><ReactQueryDevtools buttonPosition="bottom-left"/></Suspense>
  </Provider>
}


const Routes = () => {
  const { pathname } = useLocation();
  if (pathname === "/")
    return <ProjectsList/>
  return <PrivateContent>
    <ProjectApp pathname={pathname}/>
  </PrivateContent>
}


// Milestones older versions saved in browsers move to the user's account
const ImportLegacyMilestones = () => {
  useImportLegacyMilestones();
  return null;
}


const ProjectApp = ({ pathname }) => {
  const matched = matchRoutes(routes, pathname);
  if (!matched) return null;
  const { route: { main: Main }, match } = matched;
  return <RouteMatch match={match}>
    <ComparisonProvider>
    <ImportLegacyMilestones/>
    <MilestoneDialogHost/>
    <ManageMilestonesHost/>
    <Layout className={Classes.UI_TEXT}>
      <AppSider/>
      <div style={{width: '100%'}}>
        <AppNavbar/>
        {/* the content area: on its left the sidebar (collapsible), on its right room for a docked side panel (see App.css) */}
        <div className="qa-content-area" style={{paddingLeft: sider_width, minHeight: '100vh', display: 'flex', flexDirection: 'column'}}>
          <Suspense fallback={<EmptyLoading/>}>
            <Main/>
          </Suspense>
          <Footer/>
        </div>
      </div>
    </Layout>
    </ComparisonProvider>
  </RouteMatch>
}


export default App;
