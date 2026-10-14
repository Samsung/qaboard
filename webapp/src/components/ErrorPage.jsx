import { Callout, Intent, Button } from "@blueprintjs/core";
import { Container } from "./layout";


const ErrorPage = ({ error, info, support_url }) => {
  const subject = encodeURIComponent("[qa] bug report");
  const error_str = String(error);
  const componentStack = info?.componentStack;
  const body = encodeURIComponent(`URL: ${document.URL}\nerror: ${error_str}\ncomponentStack: ${componentStack}`);
  // QABOARD_SUPPORT_URL can be an email (mailto:) or e.g. an issue tracker
  const support = support_url || "https://github.com/Samsung/qaboard/issues";
  const report_url = support.startsWith("mailto:") ? `${support}?subject=${subject}&body=${body}` : support;
  return <Container>
    <Callout intent={Intent.DANGER} title="Sorry, something went wrong!">
      <p>Try refreshing the page..?</p>
      <p><a href={report_url} rel="noopener noreferrer" target="_blank"><Button>Report the bug</Button></a></p>
      <p><code style={{ whiteSpace: 'pre-wrap' }}>{error_str}</code></p>
      {componentStack && <p><code style={{ whiteSpace: 'pre-wrap' }}>{componentStack}</code></p>}
    </Callout>
  </Container>;
};

export default ErrorPage;
