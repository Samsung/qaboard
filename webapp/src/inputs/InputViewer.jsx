// An input full screen: the image viewer on its file (or the server's preview when browsers can't decode it),
// previous / next with the arrows, and the runs of the project that used it.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import styled from "styled-components";
import { AnchorButton, Button, Checkbox, Classes, Colors, Icon, NonIdealState, Overlay2, Spinner, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

import { Link } from "../router";
import { errorMessage } from "../api/http";
import { is_typing } from "../components/HelpSheet";
import { copyWithToast } from "../utils/clipboard";
import { path_segment, stringify_query } from "../selection";
import { inputQuery, input_name, input_file_url, thumbnail_url, is_browser_image, database_label } from "./api";

const InputImage = lazy(() => import("./InputImage"));


const Shell = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: ${Colors.BLACK};
  color: ${Colors.LIGHT_GRAY5};
  outline: none;

  .qa-viewer-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
    min-width: 0;
  }
  /* a path wraps between its folders, a folder too long for a line anywhere */
  .qa-path-part {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .qa-viewer-title {
    font-family: var(--qa-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-viewer-body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .qa-viewer-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .qa-viewer-stage {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    min-height: 0;
  }
  .qa-viewer-image {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qa-viewer-image > * {
    width: 100%;
  }
  .qa-viewer-arrow.${Classes.BUTTON} {
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 22px;
  }
  .qa-viewer-keys {
    display: flex;
    gap: 18px;
    justify-content: center;
    padding: 4px 16px 10px;
    font-size: 12px;
    flex-wrap: wrap;
  }
  .qa-viewer-aside {
    flex: 0 0 340px;
    max-width: 40vw;
    overflow-y: auto;
    background: ${Colors.DARK_GRAY1};
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-sizing: border-box;
  }
  .qa-viewer-aside h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${Colors.GRAY4};
  }
  dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: ${Colors.GRAY4};
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .qa-viewer-runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .qa-viewer-runs a {
    display: flex;
    flex-direction: column;
    padding: 6px 8px;
    border-radius: 3px;
    color: inherit;
    text-decoration: none;
  }
  .qa-viewer-runs a:hover, .qa-viewer-runs a:focus-visible {
    background: rgba(255, 255, 255, 0.06);
  }
  .qa-viewer-run-line {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    font-size: 13px;
  }
  .qa-viewer-run-line code {
    color: ${Colors.BLUE5};
  }
  .qa-viewer-run-meta {
    font-size: 12px;
    color: ${Colors.GRAY4};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .qa-viewer-body {
      flex-direction: column;
      overflow-y: auto;
    }
    .qa-viewer-aside {
      flex: none;
      max-width: none;
      border-left: 0;
    }
  }
`;

// Whether an image loads: 'loading', 'ok' or 'error'
const useImageStatus = url => {
  const [status, setStatus] = useState({ url: null, status: 'loading' });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const image = new Image();
    image.onload = () => alive && setStatus({ url, status: 'ok' });
    image.onerror = () => alive && setStatus({ url, status: 'error' });
    image.src = url;
    return () => {
      alive = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);
  return !url ? 'error' : status.url === url ? status.status : 'loading';
};

// The file when browsers decode its format and it loads, else the server's preview
const InputPicture = ({ input }) => {
  const browser_image = is_browser_image(input.path);
  const file = browser_image ? input_file_url(input) : null;
  const file_status = useImageStatus(file);
  const use_preview = !browser_image || file_status === 'error';
  // the largest the server makes
  const preview = use_preview ? thumbnail_url(input, 1024) : null;
  const preview_status = useImageStatus(preview);
  const status = use_preview ? preview_status : file_status;
  if (status === 'loading') return <Spinner size={32} aria-label="Loading the image"/>;
  if (status === 'error') return <NonIdealState
    className={Classes.DARK}
    icon="media"
    title="No preview"
    description={<>The server has no decoder for this file{input.path?.includes('.') ? ` (.${input.path.split('.').pop()})` : ''}, or can't read it. Sites add decoders for their formats: see <em>Thumbnails</em> in the admin docs.</>}
  />;
  const url = use_preview ? preview : file;
  return <Suspense fallback={<Spinner size={32}/>}>
    <InputImage
      key={url}
      syncKey={`input-${input.id}`}
      image={{ url, label: input_name(input), href: use_preview ? input_file_url(input) : url }}
      notice={use_preview ? <Tag minimal icon="info-sign" title="Browsers can't decode this format: the server decoded it into a JPEG (1024 pixels at most)">preview</Tag> : undefined}
    />
  </Suspense>;
};

const full_date = date => date ? DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_MED) : '';
const relative = date => date ? DateTime.fromISO(date).toRelative() : '';

// The commit page, on the run's batch, filtered on the input
export const run_location = (project, run, input) => `/${path_segment(project)}/commit/${path_segment(run.commit)}?${stringify_query({
  batch: run.batch && run.batch !== 'default' ? run.batch : undefined,
  filter: input?.path || undefined,
})}`;

const Runs = ({ project, input, onNavigate }) => {
  const { data, isPending, error } = useQuery(inputQuery(project, input.id));
  if (isPending) return <p className={Classes.SKELETON}>Loading the runs that used it</p>;
  if (error) return <p style={{ color: Colors.RED5 }}>Could not load its runs: {errorMessage(error)}</p>;
  const runs = data?.runs ?? [];
  if (runs.length === 0) return <p className={Classes.TEXT_MUTED}>No runs of this project used it, or they were deleted.</p>;
  return <ul className="qa-viewer-runs" aria-label="Runs that used it">
    {runs.map(run => <li key={run.id}>
      <Link to={run_location(run.project || project, run, data)} onClick={onNavigate}>
        <span className="qa-viewer-run-line">
          <code>{String(run.commit ?? '').slice(0, 8)}</code>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.batch || 'default'}</span>
          {run.is_failed && <Tag minimal intent="danger">failed</Tag>}
          {run.deleted && <Tag minimal>deleted</Tag>}
        </span>
        <span className="qa-viewer-run-meta" title={full_date(run.created_date)}>
          {[run.project !== project ? run.project : null, run.branch, run.user, run.origin, relative(run.created_date)].filter(Boolean).join(' · ')}
        </span>
      </Link>
    </li>)}
  </ul>;
};

const Key = ({ children }) => <kbd className={Classes.KEY}>{children}</kbd>;

// `count`, `item_at(index)`, `loadMore`: the inputs users browse (see usePagedInputs). `index`: the one shown.
// `selected` / `onToggleSelected`: to (un)select it from here.
export const InputViewer = ({ project, count, item_at, loadMore, index, onIndexChange, onClose, selected, onToggleSelected, context }) => {
  const input = item_at(index);
  const has_previous = index > 0;
  const has_next = index < count - 1;
  const previous = () => has_previous && onIndexChange(index - 1);
  const next = () => {
    if (!has_next) return;
    if (!item_at(index + 1)) loadMore?.();
    onIndexChange(index + 1);
  };
  useEffect(() => {
    // the next inputs before users get there
    if (has_next && !item_at(Math.min(count - 1, index + 5))) loadMore?.();
  });
  useEffect(() => {
    const onKeyDown = event => {
      if (event.defaultPrevented || is_typing(event.target) || event.target.closest?.('[role="slider"], [role="menu"], [role="listbox"]')) return;
      if (event.key === 'ArrowLeft' && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        previous();
      } else if (event.key === 'ArrowRight' && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const name = input ? input_name(input) : '';
  const shell = useRef(null);
  return <Overlay2
    childRef={shell}
    isOpen
    onClose={onClose}
    canEscapeKeyClose
    hasBackdrop={false}
    autoFocus
    enforceFocus
    usePortal
    className={Classes.DARK}
    transitionDuration={0}
  >
    <Shell ref={shell} role="dialog" aria-modal="true" aria-label={input ? `${name}, ${index + 1} of ${count}` : 'Input'} className={Classes.DARK} tabIndex={-1}>
      <header className="qa-viewer-header">
        <Button icon="cross" text={<>Close <Key>Esc</Key></>} onClick={onClose} aria-label="Close the viewer"/>
        <span className="qa-viewer-title" title={input?.path}>{name || <span className={Classes.SKELETON}>loading</span>}</span>
        <span className={Classes.TEXT_MUTED} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
          {context ? `${context} · ` : ''}{(index + 1).toLocaleString()} of {count.toLocaleString()}
        </span>
        <span style={{ flex: 1 }}/>
        {!!onToggleSelected && input && <Checkbox style={{ margin: 0 }} checked={!!selected} onChange={() => onToggleSelected(index)} label="Selected"/>}
        {input && <Tooltip content="Copy the input's path">
          <Button icon="duplicate" text="Copy path" variant="minimal" onClick={() => copyWithToast(input.path, { what: 'the path' })}/>
        </Tooltip>}
        {input && <AnchorButton icon="download" text="File" variant="minimal" href={input_file_url(input)} target="_blank" rel="noopener noreferrer" title="Open the input's file"/>}
      </header>
      <div className="qa-viewer-body">
        <div className="qa-viewer-main">
          <div className="qa-viewer-stage">
            <Button className="qa-viewer-arrow" icon="chevron-left" size="large" aria-label="Previous input" disabled={!has_previous} onClick={previous}/>
            <div className="qa-viewer-image">
              {input ? <InputPicture key={input.id} input={input}/> : <Spinner size={32} aria-label="Loading the input"/>}
            </div>
            <Button className="qa-viewer-arrow" icon="chevron-right" size="large" aria-label="Next input" disabled={!has_next} onClick={next}/>
          </div>
          <div className={`qa-viewer-keys ${Classes.TEXT_MUTED}`}>
            <span><Key>←</Key> <Key>→</Key> previous / next</span>
            <span><Key>f</Key> full screen, <Key>+</Key> <Key>−</Key> zoom, <Key>a</Key> histogram</span>
            <span><Key>Esc</Key> back to the grid</span>
          </div>
        </div>
        {input && <aside className="qa-viewer-aside" aria-label="About this input">
          <section>
            <h2>Details</h2>
            <dl>
              <dt>Path</dt><dd><code>{input.path.split(/(?<=[/\\])/).map((part, i) => <span key={i} className="qa-path-part">{part}</span>)}</code></dd>
              {!!input.database && <><dt>Database</dt><dd title={input.database}><Icon icon="database" size={12}/> {database_label(input.database)}</dd></>}
              {input.runs !== undefined && <><dt>Runs</dt><dd>{input.runs}</dd></>}
              {!!input.first_run_at && <><dt>First used</dt><dd title={full_date(input.first_run_at)}>{relative(input.first_run_at)}</dd></>}
              {!!input.last_run_at && <><dt>Last used</dt><dd title={full_date(input.last_run_at)}>{relative(input.last_run_at)}</dd></>}
            </dl>
          </section>
          <section>
            <h2>Used in runs</h2>
            <Runs project={project} input={input} onNavigate={onClose}/>
          </section>
        </aside>}
      </div>
    </Shell>
  </Overlay2>;
};
