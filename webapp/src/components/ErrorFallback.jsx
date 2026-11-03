// What users see when a page or a viewer crashes: what happened in plain words, a way back to where they were,
// whether the maintainers know (Sentry), and how to tell them more. The details are there for those who want them.
// The app's own boundary is outside the router: nothing here needs it, links go through `history`.
import { useEffect, useRef, useState } from "react";
import { AnchorButton, Button, Callout, Classes, Collapse, Icon, Intent, Tag, TextArea } from "@blueprintjs/core";
import styled from "styled-components";

import { captureFeedback, reportsErrors } from "../analytics";
import { ErrorBoundary, useLocationKey } from "./ErrorBoundary";
import { errorDetails, isChunkError, reportUrl } from "../errors";
import { useSiteConfig } from "../hooks";
import { history } from "../router";
import { app_title, usePageTitle } from "../pageTitle";
import { copyText } from "../utils/clipboard";


const Page = styled.div`
  max-width: 720px;
  margin: 4vh auto 40px;
  padding: 0 16px;

  h1 {
    margin: 12px 0 8px;
  }
  h1:focus {
    outline: none;
  }
  .qa-error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 20px 0;
  }
  .qa-error-reported {
    display: flex;
    gap: 10px;
    margin: 0 0 16px;
    padding: 12px 14px;
    border: 1px solid var(--qa-border);
    border-radius: 4px;
    background: var(--qa-surface);
  }
  .qa-error-reported p {
    margin: 0 0 4px;
  }
`;

// like the logs of a failed run
const Details = styled.div`
  margin-top: 8px;
  border: 1px solid var(--qa-border);
  border-radius: 4px;
  background: var(--qa-surface-alt, var(--qa-surface));

  pre {
    margin: 0;
    padding: 10px 12px;
    max-height: 320px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: none;
    box-shadow: none;
  }
  .qa-error-details-bar {
    display: flex;
    justify-content: flex-end;
    padding: 4px;
    border-bottom: 1px solid var(--qa-border);
  }
`;


// What the fallbacks share: whether the error was reported, the details, where to report it
const useErrorReport = ({ error, componentStack, eventId }) => {
  const config = useSiteConfig();
  const reported = !!eventId && reportsErrors(config);
  const details = errorDetails({ error, componentStack, eventId: reported ? eventId : null });
  const report_href = reportUrl(config.support_url, {
    subject: `[QA-Board] ${String(error).slice(0, 80)}`,
    body: `What I was doing:\n\n\n---\n${details}`,
  });
  return { reported, details, report_href };
};


const ReportButton = ({ text = 'Report the problem', ...props }) =>
  <AnchorButton icon="chat" text={text} target="_blank" rel="noopener noreferrer" {...props}/>;


const TechnicalDetails = ({ details, small }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return <div>
    <Button
      variant="minimal"
      size={small ? 'small' : undefined}
      icon={open ? 'chevron-down' : 'chevron-right'}
      text="Technical details"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    />
    <Collapse isOpen={open}>
      <Details>
        <div className="qa-error-details-bar">
          <Button
            size="small"
            variant="minimal"
            icon={copied ? 'tick' : 'duplicate'}
            text={copied ? 'Copied' : 'Copy'}
            onClick={async () => setCopied(await copyText(details))}
          />
        </div>
        <pre>{details}</pre>
      </Details>
    </Collapse>
  </div>;
};


// Users add what they were doing to the error's event in Sentry
const Feedback = ({ eventId, contact }) => {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  if (sent)
    return <p style={{ marginTop: 8 }}><Icon icon="tick" intent={Intent.SUCCESS}/> Thanks! Your note was added to the report.</p>;
  const send = event => {
    event.preventDefault();
    if (message.trim()) setSent(captureFeedback(message.trim(), eventId));
  };
  return <form onSubmit={send} style={{ marginTop: 8 }}>
    <label htmlFor={`qa-error-feedback-${eventId}`} className={Classes.TEXT_MUTED} style={{ display: 'block', marginBottom: 4 }}>
      What were you doing? It helps them fix it (optional).
    </label>
    <TextArea
      id={`qa-error-feedback-${eventId}`}
      fill
      rows={2}
      value={message}
      onChange={event => setMessage(event.target.value)}
      placeholder="e.g. I opened the image viewer on two batches"
    />
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <Button type="submit" size="small" icon="send-message" text="Send" disabled={!message.trim()}/>
      {contact}
    </div>
  </form>;
};


// Back where users came from in the app, else the projects. The router's history also works without the router.
const can_go_back = () => (window.history.state?.idx ?? 0) > 0;


// What the browser's tab says: "Something went wrong · QA-Board"
export const error_tab_title = error => isChunkError(error) ? 'New version' : 'Something went wrong';

// scope: 'page' (in the app, whose sidebar and navbar still work) or 'app' (nothing else renders)
export const PageErrorFallback = ({ error, componentStack, eventId, retry, retries = 0, scope = 'page' }) => {
  const { reported, details, report_href } = useErrorReport({ error, componentStack, eventId });
  const heading = useRef(null);
  const stale = isChunkError(error);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  usePageTitle(app_title(error_tab_title(error)));
  // screen readers say what happened, keyboards start from here
  useEffect(() => heading.current?.focus(), []);

  // trying again re-renders the page; when it failed again, reloading also loads its data and code again
  const reload = () => window.location.reload();
  const try_again = stale || retries > 0
    ? <Button intent={Intent.PRIMARY} icon="repeat" text="Reload the page" onClick={reload}/>
    : <Button intent={Intent.PRIMARY} icon="refresh" text="Try again" onClick={retry}/>;
  const back = can_go_back()
    ? <Button icon="arrow-left" text="Go back" onClick={() => history.back()}/>
    : <Button icon="projects" text="All projects" onClick={() => history.push('/projects')}/>;

  const title = stale ? 'QA-Board was updated' : scope === 'app' ? 'QA-Board crashed' : 'This page crashed';
  const lead = stale
    ? "This page needs parts of the new version that your browser couldn't load. Reloading the page usually fixes it."
    : <>It's a bug in QA-Board, not something you did.{scope === 'page' && ' The rest of the app still works.'}{' '}
        What you selected is in the URL: reloading brings you back here.</>;

  return <Page>
    <Tag minimal large intent={stale ? Intent.PRIMARY : Intent.DANGER} icon={stale ? 'updated' : 'error'}>{stale ? 'New version' : 'Failed'}</Tag>
    <h1 ref={heading} tabIndex={-1} className={Classes.HEADING}>{title}</h1>
    <p className={Classes.TEXT_MUTED}>{lead}</p>
    {offline && <Callout compact intent={Intent.WARNING} icon="offline" style={{ marginTop: 12 }}>
      You seem to be offline: check your connection, then reload the page.
    </Callout>}

    <div className="qa-error-actions">
      {try_again}
      {back}
      {!reported && <ReportButton href={report_href}/>}
    </div>

    {reported && !stale && <div className="qa-error-reported">
      <Icon icon="tick-circle" intent={Intent.SUCCESS} style={{ marginTop: 2 }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p><strong>The QA-Board maintainers were notified.</strong></p>
        <p className={Classes.TEXT_MUTED}>The error was reported automatically, with your username: they may get in touch.</p>
        <Feedback eventId={eventId} contact={<ReportButton href={report_href} variant="minimal" size="small" text="Contact them"/>}/>
      </div>
    </div>}
    {!reported && !stale && <p className={Classes.TEXT_MUTED}>
      Please tell the QA-Board maintainers, they'll want to fix it: <strong>Report the problem</strong> sends them the details below.
    </p>}

    <TechnicalDetails details={details}/>
  </Page>;
};


// In the page: a viewer, a section, an editor... The rest of the page still works.
export const InlineErrorFallback = ({ error, componentStack, eventId, retry, retries = 0, title, description }) => {
  const { reported, details, report_href } = useErrorReport({ error, componentStack, eventId });
  return <Callout compact intent={Intent.DANGER} icon="error" style={{ margin: '5px 0' }} title={title}>
    <p style={{ margin: '4px 0 8px' }}>
      {description} It's a bug in QA-Board, not something you did.
      {reported && ' The maintainers were notified.'}
    </p>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {retries > 0
        ? <Button size="small" icon="repeat" text="Reload the page" onClick={() => window.location.reload()}/>
        : <Button size="small" icon="refresh" text="Try again" onClick={retry}/>}
      <ReportButton href={report_href} variant="minimal" size="small"/>
    </div>
    <TechnicalDetails details={details} small/>
  </Callout>;
};

// In a run's card: the other viewers, cards and the page still work
export const ViewerErrorFallback = ({ path, ...props }) => <InlineErrorFallback
  {...props}
  title={path ? <>Could not show <code>{path}</code></> : 'Could not show this file'}
  description="The viewer crashed. The other files and runs still show."
/>;

// A part of a page, e.g. a view of the commit page. It renders again when the URL changes, e.g. users select another batch.
export const SectionErrorBoundary = ({ name = 'section', title, description = 'The rest of the page still works.', children }) => {
  const location = useLocationKey();
  return <ErrorBoundary
    name={name}
    resetKeys={[location]}
    fallback={props => <InlineErrorFallback {...props} title={title ? `Could not show ${title}` : 'This part of the page crashed'} description={description}/>}
  >
    {children}
  </ErrorBoundary>;
};
