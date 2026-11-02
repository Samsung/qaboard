import { Component } from "react";
import { captureException } from "../analytics";

// Renders fallback({ error, componentStack }) instead of children that failed to render, and reports the error to Sentry.
// Like Sentry's ErrorBoundary, without downloading Sentry when it's not used. Error boundaries can only be classes.
export class ErrorBoundary extends Component {
  state = { error: null, componentStack: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, { componentStack }) {
    this.setState({ componentStack });
    captureException(error, { contexts: { react: { componentStack } } });
  }

  render() {
    const { error, componentStack } = this.state;
    return error ? this.props.fallback({ error, componentStack }) : this.props.children;
  }
}
