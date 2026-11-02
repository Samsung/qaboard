// Pages that don't exist: typos, projects that were renamed or deleted, old links to the app's pages.
// QA-Board compares new results to a reference, so the 404 compares this URL to the page users expected, the way the
// image viewer compares images in its wipe mode (image-viewer/ImageViewer.jsx). Users can drag the divider: there is
// nothing on this URL's side.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Classes, Colors, Icon, Intent } from "@blueprintjs/core";
import styled from "styled-components";

import { PageShell } from "../components/PageShell";
import { SideLabel } from "../components/SideLabel";
import { MetricTag } from "../components/metrics";
import { LinkButton } from "../access/NoProjectAccess";
import { SubprojectsCard } from "../explore/SubprojectsCard";
import { path_segments } from "../explore/tree";
import { useProjects } from "../hooks";
import { project_url } from "../selection";
import { side_color } from "../sideColors";


const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// what the comparison's metric says, in qaboard.yaml's terms
const pages_metric = { key: 'pages', label: 'Pages found', short_label: 'pages', description: 'at this URL.', scale: 1, suffix: '', smaller_is_better: false, target: 1 };

const Page = styled.div`
  max-width: 720px;
  margin: 4vh auto 0;

  h1 {
    margin: 0 0 8px;
  }
  .qa-404-code {
    display: block;
    font-size: 72px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -2px;
    color: var(--qa-text-muted);
  }
  .qa-404-url {
    overflow-wrap: anywhere;
  }
  .qa-404-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 20px 0 24px;
  }
`;

// --wipe: where the divider is, from the left
const Stage = styled.div`
  position: relative;
  height: clamp(180px, 40vw, 280px);
  overflow: hidden;
  border: 1px solid var(--qa-border);
  border-radius: 4px;
  user-select: none;
  /* phones still scroll the page */
  touch-action: pan-y;
  cursor: col-resize;

  .qa-404-pane {
    position: absolute;
    inset: 0;
  }
  /* no pixels: the transparency checkerboard */
  .qa-404-new {
    background: repeating-conic-gradient(color-mix(in srgb, var(--qa-text) 7%, var(--qa-surface)) 0 25%, var(--qa-surface) 0 50%) 0 0 / 20px 20px;
  }
  .qa-404-reference {
    clip-path: inset(0 0 0 var(--wipe));
  }
  /* at first the expected page covers everything, then the wipe uncovers this URL's side */
  &.qa-404-intro .qa-404-reference {
    transition: clip-path 900ms cubic-bezier(0.3, 0, 0.2, 1);
  }
  &.qa-404-intro .qa-404-wipe {
    transition: left 900ms cubic-bezier(0.3, 0, 0.2, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    &.qa-404-intro .qa-404-reference, &.qa-404-intro .qa-404-wipe {
      transition: none;
    }
  }
  /* the labels' tint, on the theme's background rather than on the images */
  .qa-404-label {
    position: absolute;
    top: 8px;
    z-index: 3;
    display: flex;
    border-radius: 11px;
    background: var(--qa-surface);
  }
  .qa-404-wipe {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--wipe);
    z-index: 4;
    width: 16px;
    margin-left: -8px;
    touch-action: none;
  }
  .qa-404-wipe::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 7px;
    width: 2px;
    background: #fff;
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
  }
  .qa-404-wipe:focus-visible {
    outline: 2px solid var(--qa-intent-primary);
  }
  .qa-404-handle {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #fff;
    color: #1c2127;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
    transform: translate(-50%, -50%);
  }
`;

// A QA-Board page as users remember it: the sidebar, a title, commits with their metrics
const Ghost = styled.div`
  display: flex;
  height: 100%;
  background: var(--qa-background);

  .qa-ghost-sider {
    flex: 0 0 22%;
    padding: 14px 10px;
    background: var(--qa-sider-background);
  }
  .qa-ghost-content {
    flex: 1;
    min-width: 0;
    padding: 14px 16px;
  }
  .qa-ghost-line {
    height: 8px;
    margin: 0 0 10px;
    border-radius: 4px;
    background: var(--qa-border);
  }
  .qa-ghost-sider .qa-ghost-line {
    background: rgba(255, 255, 255, 0.18);
  }
  .qa-ghost-avatar {
    width: 28px;
    height: 28px;
    margin: 0 0 16px;
    border-radius: 4px;
    background: var(--qa-side-1);
    opacity: 0.6;
  }
  .qa-ghost-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    padding: 8px;
    border-radius: 3px;
    background: var(--qa-surface);
  }
  .qa-ghost-row .qa-ghost-line {
    margin: 0;
  }
  .qa-ghost-dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--qa-border);
  }
  .qa-ghost-tag {
    flex: none;
    width: 30px;
    height: 12px;
    border-radius: 6px;
    background: var(--qa-border);
  }
`;

// the commits' messages, and how their metrics changed
const ghost_rows = [['55%', Colors.GREEN3], ['40%', Colors.GREEN3], ['62%', Colors.RED3], ['48%', Colors.GREEN3]];

const GhostPage = () => <Ghost aria-hidden="true">
  <div className="qa-ghost-sider">
    <div className="qa-ghost-avatar"/>
    {['80%', '65%', '72%', '50%'].map((width, i) => <div key={i} className="qa-ghost-line" style={{ width }}/>)}
  </div>
  <div className="qa-ghost-content">
    <div className="qa-ghost-line" style={{ width: '35%', height: 12, marginBottom: 16 }}/>
    {ghost_rows.map(([width, color], i) => <div key={i} className="qa-ghost-row">
      <span className="qa-ghost-dot"/>
      <div className="qa-ghost-line" style={{ width, flex: 'none' }}/>
      <span style={{ flex: 1 }}/>
      <span className="qa-ghost-tag"/>
      <span className="qa-ghost-tag" style={{ background: color, opacity: 0.5 }}/>
    </div>)}
  </div>
</Ghost>;


// This URL (new, on the left) vs the page users expected (reference, on the right), like the image viewer's wipe
const Comparison = () => {
  // at first the expected page covers everything
  const [wipe, setWipe] = useState(0);
  const [intro, setIntro] = useState(true);
  const intro_timer = useRef(null);
  const stage = useRef(null);
  const dragging = useRef(false);
  useEffect(() => {
    intro_timer.current = setTimeout(() => setWipe(0.5), 400);
    return () => clearTimeout(intro_timer.current);
  }, []);
  // once users move the divider, it follows them right away
  const takeOver = () => {
    clearTimeout(intro_timer.current);
    setIntro(false);
  };
  const moveTo = event => {
    const rect = stage.current.getBoundingClientRect();
    setWipe(clamp((event.clientX - rect.left) / rect.width, 0, 1));
  };
  const stop = () => { dragging.current = false; };
  return <figure style={{ margin: 0 }}>
    <Stage
      ref={stage}
      className={intro ? 'qa-404-intro' : undefined}
      style={{ '--wipe': `${100 * wipe}%` }}
      onPointerDown={event => {
        takeOver();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragging.current = true;
        moveTo(event);
      }}
      onPointerMove={event => dragging.current && moveTo(event)}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      <div className="qa-404-pane qa-404-new"/>
      <div className="qa-404-pane qa-404-reference"><GhostPage/></div>
      <span className="qa-404-label" style={{ left: 8 }}>
        <SideLabel color={side_color(0).css} fallback="new" label="this URL" editable={false}/>
      </span>
      <span className="qa-404-label" style={{ right: 8 }}>
        <SideLabel color={side_color(1).css} fallback="reference" label="the page you expected" editable={false}/>
      </span>
      <div
        className="qa-404-wipe"
        role="separator"
        aria-orientation="vertical"
        aria-label="Wipe"
        aria-valuenow={Math.round(100 * wipe)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onKeyDown={event => {
          const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key];
          if (!step) return;
          event.preventDefault();
          takeOver();
          setWipe(w => clamp(w + step, 0, 1));
        }}
      >
        <div className="qa-404-handle"><Icon icon="arrows-horizontal" size={14}/></div>
      </div>
    </Stage>
    <figcaption style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <MetricTag metrics_new={{ pages: 0 }} metrics_ref={{ pages: 1 }} metric_info={pages_metric}/>
      <span className={Classes.TEXT_MUTED}>Re-running won't help.</span>
    </figcaption>
  </figure>;
};


// project: what the URL would be a project's page of, e.g. "group/repo/typo" for /group/repo/typo/commits
export const NotFoundPage = ({ project }) => {
  const { pathname } = useLocation();
  const { data: projects } = useProjects();
  // e.g. group/repo for group/repo/typo
  const closest = project && path_segments(project, projects).slice(0, -1).findLast(segment => segment.is_project)?.path;
  useEffect(() => {
    document.title = 'Page not found - QA-Board';
  }, []);
  return <PageShell>
    <Page>
      <h1 className={Classes.HEADING}>
        <span className="qa-404-code">404</span>
        Page not found
      </h1>
      <p className={Classes.TEXT_MUTED}>
        There's no page or project at <code className="qa-404-url">{pathname}</code>.
      </p>
      <div className="qa-404-actions">
        {closest && <LinkButton to={project_url(closest)} intent={Intent.PRIMARY} icon="git-repo" text={`Open ${closest}`}/>}
        <LinkButton to="/projects" intent={closest ? Intent.NONE : Intent.PRIMARY} icon="projects" text="All projects"/>
      </div>
      {/* /group lists the projects below it */}
      {project && <SubprojectsCard project={project}/>}
      <Comparison/>
    </Page>
  </PageShell>;
};

export default NotFoundPage;
