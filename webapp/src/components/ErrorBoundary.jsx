import { Component, useSyncExternalStore } from "react";
import { captureException } from "../analytics";
import { isChunkError, reloadForNewVersion } from "../errors";
import { history } from "../router";

const changed = (a = [], b = []) => a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

// Renders fallback({ error, componentStack, eventId, retry, retries }) instead of children that failed to render, and
// reports the error to Sentry. Like Sentry's ErrorBoundary, without downloading Sentry when it's not used. Error boundaries
// can only be classes.
// - name: which boundary caught the error (app, page, viewer...), a tag of Sentry's events
// - resetKeys: when one changes, e.g. the page users go to, the children render again
// - retry(): renders the children again; retries: how many times users tried since the error
// After a deploy, pages that load a chunk of the previous version reload once, without reporting anything.
export class ErrorBoundary extends Component {
  state = { error: null, componentStack: null, eventId: null, retries: 0, reloading: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, { componentStack }) {
    if (isChunkError(error) && reloadForNewVersion()) {
      this.setState({ reloading: true });
      return;
    }
    const eventId = captureException(error, { contexts: { react: { componentStack } }, tags: { error_boundary: this.props.name ?? 'unknown' } });
    this.setState({ componentStack, eventId });
  }

  componentDidUpdate(prevProps, prevState) {
    // not when the error happened while rendering for the new keys
    if (prevState.error && this.state.error && changed(prevProps.resetKeys, this.props.resetKeys))
      // oxlint-disable-next-line react/no-did-update-set-state -- only once the keys changed, like react-error-boundary
      this.setState({ error: null, componentStack: null, eventId: null, retries: 0 });
  }

  retry = () => this.setState(({ retries }) => ({ error: null, componentStack: null, eventId: null, retries: retries + 1 }));

  render() {
    const { error, componentStack, eventId, retries, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading) return null;
    return this.props.fallback({ error, componentStack, eventId, retries, retry: this.retry });
  }
}


// The page's path, also outside the router: the app's boundary is around it
export const usePathname = () => useSyncExternalStore(history.listen, () => history.location.pathname);

// The page and what's selected on it (the query string, see selection.js)
export const useLocationKey = () => useSyncExternalStore(history.listen, () => history.location.pathname + history.location.search);

// Errors on a page are forgotten once users go to another page
export const PageErrorBoundary = ({ name = 'page', fallback, children }) => {
  const pathname = usePathname();
  return <ErrorBoundary name={name} resetKeys={[pathname]} fallback={fallback}>{children}</ErrorBoundary>;
};
