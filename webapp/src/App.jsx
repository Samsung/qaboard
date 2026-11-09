import { Suspense, lazy, useEffect } from "react";
import { unstable_HistoryRouter as HistoryRouter, useLocation } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { Classes } from "@blueprintjs/core";

import { StyleSheetManager } from "styled-components";
import isPropValid from "@emotion/is-prop-valid";

import { history, matchRoutes, RouteMatch } from "./router";
import { queryClient, persistOptions, onCacheRestored } from "./api/queryClient";
import { siteConfigQuery, userQuery } from "./api/queries";
import { installLoginHandler } from "./components/authentication/login";
import { toaster } from "./toaster";
import { ComparisonProvider, useSelected } from "./hooks";
import { initSentry, initPostHog, initUsage, setUser } from "./analytics";
import { PageViews } from "./usePageViews";
import { Layout } from "./components/layout";
import ExplorePage from "./explore/ExplorePage";
import HomePage from "./home/HomePage";
import { useRecordProjectView } from "./explore/views";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { PageErrorFallback, error_tab_title } from "./components/ErrorFallback";
import { PageShell } from "./components/PageShell";
import EmptyLoading from "./components/EmptyLoading";
import Footer from "./components/Footer";
import { ThemeSync } from "./theme";
import { PrefsSync } from "./stores/prefsSync";

import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
// include blueprint-icons.css for icon font support
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";

import "./App.css";

import { routes, matchAppRoute } from './routes'
import { ReleaseNotesProvider } from "./releaseNotes/ReleaseNotes"
import { HelpSheetProvider } from "./components/HelpSheet"
import { CommandPaletteProvider } from "./palette/CommandPalette"
import PrivateContent from "./components/authentication/PrivateContent"
import AppSider, { sider_width } from './AppSider'
import AppNavbar from './AppNavbar'
import { MilestoneDialogHost } from "./milestones/MilestoneDialog"
import { ManageMilestonesHost } from "./milestones/ManageMilestones"
import { useImportLegacyMilestones } from "./milestones/hooks"
import { ProjectAccessGate } from "./access/NoProjectAccess"
import { ProjectNotFoundGate } from "./notFound/ProjectNotFoundGate"

// In development, inspect queries and their cache: https://tanstack.com/query/latest/docs/framework/react/devtools
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then(m => ({ default: m.ReactQueryDevtools })))
  : () => null;

// Like styled-components@5: don't forward unknown props to DOM elements
// https://styled-components.com/docs/faqs#shouldforwardprop-is-no-longer-provided-by-default
const shouldForwardProp = (prop, target) => typeof target !== "string" || isPropValid(prop);

// Asks users to log in when the server answers 401, once for all actions
installLoginHandler(queryClient, toaster);

const route_name = pathname => (matchAppRoute(pathname) ?? matchRoutes(routes, pathname))?.route.path ?? pathname;



// Monitoring and analytics, once we know the site's configuration. Errors say who they happened to.
const Analytics = () => {
  const { data: config } = useQuery(siteConfigQuery);
  const { data: user } = useQuery(userQuery);
  useEffect(() => {
    if (!config) return;
    initSentry(config, route_name);
    initPostHog(config);
    initUsage(config);
  }, [config]);
  useEffect(() => setUser(user), [user]);
  return null;
}

// Errors are caught as close as possible to where they happen, so that the rest keeps working:
// in viewers (viewers/OutputViewer.jsx), in projects' pages (the sidebar and navbar still work), in the other pages,
// and as a last resort, here, around everything.
const appFallback = props => <PageErrorFallback {...props} scope="app"/>;
const pageFallback = props => <PageShell tab_title={error_tab_title(props.error)}><PageErrorFallback {...props}/></PageShell>;
const projectPageFallback = props => <PageErrorFallback {...props}/>;


const App = ({ persist = true }) => {
  // Tests don't have IndexedDB: they don't persist the cache
  const Provider = persist ? PersistQueryClientProvider : QueryClientProvider;
  const providerProps = persist ? { client: queryClient, persistOptions, onSuccess: onCacheRestored } : { client: queryClient };
  return <Provider {...providerProps}>
    <ThemeSync/>
    <PrefsSync/>
    {/* outside the error boundary: pages that fail before we know the site's configuration are still reported */}
    <Analytics/>
    <PageErrorBoundary name="app" fallback={appFallback}>
      <StyleSheetManager shouldForwardProp={shouldForwardProp}>
        <ReleaseNotesProvider>
          <HelpSheetProvider>
            <HistoryRouter history={history}>
              {/* Ctrl+K on every page: projects, app pages, Home and Explore */}
              <CommandPaletteProvider>
                {/* usage analytics: which pages people look at */}
                <PageViews/>
                <PageErrorBoundary name="routes" fallback={pageFallback}>
                  <Routes/>
                </PageErrorBoundary>
              </CommandPaletteProvider>
            </HistoryRouter>
          </HelpSheetProvider>
        </ReleaseNotesProvider>
      </StyleSheetManager>
    </PageErrorBoundary>
    <Suspense><ReactQueryDevtools buttonPosition="bottom-left"/></Suspense>
  </Provider>
}


// A new server, without accounts: its first admin comes first (login/SetupPage.jsx). Not from the sign-in page, that
// says so itself, nor from `qa auth login`'s page.
const setup_exempt = ['/setup', '/login', '/device'];

const SetupRedirect = () => {
  useEffect(() => { history.replace('/setup'); }, []);
  return <EmptyLoading/>;
}

const Routes = () => {
  const { pathname } = useLocation();
  const { data: config } = useQuery(siteConfigQuery);
  if (config?.setup_required && !setup_exempt.includes(pathname))
    return <SetupRedirect/>
  if (pathname === "/")
    return <RootPage/>
  // settings, admin...: they check by themselves who users are
  const app_page = matchAppRoute(pathname);
  if (app_page) {
    const { route: { main: Main }, match } = app_page;
    return <RouteMatch match={match}>
      <Suspense fallback={<EmptyLoading/>}>
        <Main/>
      </Suspense>
    </RouteMatch>
  }
  return <PrivateContent>
    <ProjectApp pathname={pathname}/>
  </PrivateContent>
}


// Signed-in users get their home page, the others Explore (also at /projects)
const RootPage = () => {
  const { data: user, isPending } = useQuery(userQuery);
  // we don't flash Explore while we don't know who users are
  if (isPending)
    return <EmptyLoading/>
  return user?.is_logged ? <HomePage/> : <ExplorePage/>
}


// Milestones older versions saved in browsers move to the user's account
const ImportLegacyMilestones = () => {
  useImportLegacyMilestones();
  return null;
}

// Which projects people look at: Explore fades the others
const RecordProjectView = () => {
  const { project } = useSelected();
  useRecordProjectView(project);
  return null;
}

const ProjectApp = ({ pathname }) => {
  const matched = matchRoutes(routes, pathname);
  if (!matched) return null;
  const { route: { main: Main }, match } = matched;
  return <RouteMatch match={match}>
    {/* projects that don't exist get a 404, without the project's sidebar */}
    <ProjectNotFoundGate>
    <ComparisonProvider>
    <ImportLegacyMilestones/>
    <RecordProjectView/>
    <MilestoneDialogHost/>
    <ManageMilestonesHost/>
    <Layout className={Classes.UI_TEXT}>
      <AppSider/>
      <div style={{width: '100%'}}>
        <AppNavbar/>
        {/* the content area: on its left the sidebar (collapsible), on its right room for a docked side panel (see App.css) */}
        <div className="qa-content-area" style={{paddingLeft: sider_width, minHeight: '100vh', display: 'flex', flexDirection: 'column'}}>
          {/* projects users can't see say whom to ask */}
          <ProjectAccessGate>
            <PageErrorBoundary fallback={projectPageFallback}>
              <Suspense fallback={<EmptyLoading/>}>
                <Main/>
              </Suspense>
            </PageErrorBoundary>
          </ProjectAccessGate>
          <Footer/>
        </div>
      </div>
    </Layout>
    </ComparisonProvider>
    </ProjectNotFoundGate>
  </RouteMatch>
}


export default App;
