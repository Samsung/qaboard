// The home page's building blocks: its cards, their loading and error states, and the rows of batches
import { Button, Classes, Icon } from "@blueprintjs/core";
import styled from "styled-components";

import { Link } from "../router";
import { path_segment } from "../selection";
import { errorMessage } from "../api/http";
import { batch_name, batch_url, OriginTag } from "../BatchList";
import { Time } from "../settings/format";


const SectionCard = styled.section`
  && { padding: 12px 16px; margin-bottom: 16px; }
  > header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 12px;
    margin-bottom: 4px;
  }
  > header h2 {
    margin: 0;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
`;

// A card with a heading. `id` names it for screen readers and links
export const Section = ({ id, title, icon, extra, children, ...props }) => <SectionCard className={Classes.CARD} aria-labelledby={`home-${id}`} data-testid={`home-${id}`} {...props}>
  <header>
    <h2 id={`home-${id}`} className={Classes.HEADING}>{icon && <Icon icon={icon} className={Classes.TEXT_MUTED}/>}{title}</h2>
    {extra}
  </header>
  {children}
</SectionCard>;

export const Rows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

export const Row = styled.li`
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--qa-border);
  &:last-child { border-bottom: none; }
  .qa-home-meta { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: center; font-size: 13px; min-width: 0; }
  .qa-home-title { font-weight: 600; overflow-wrap: anywhere; }
  /* one line: what's long (branches, messages) is cut, the full text on hover */
  .qa-home-sub { display: flex; gap: 8px; align-items: center; font-size: 12px; min-width: 0; overflow: hidden; white-space: nowrap; margin-top: 2px; }
  .qa-home-sub > * { flex: none; }
  .qa-home-sub > .qa-home-cut { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .qa-home-side { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; }
  @media (max-width: 560px) {
    grid-template-columns: 20px minmax(0, 1fr);
    .qa-home-side { grid-column: 2; justify-content: flex-start; }
  }
`;

// Placeholder rows while a list loads: the page doesn't jump when it arrives
export const SkeletonRows = ({ count = 3, label }) => <Rows aria-busy="true" aria-label={label}>
  {Array.from({ length: count }, (_, i) => <Row key={i}>
    <span className={Classes.SKELETON} style={{ width: 16, height: 16 }}/>
    <div>
      <div className={Classes.SKELETON} style={{ width: '45%', height: 14, marginBottom: 6 }}/>
      <div className={Classes.SKELETON} style={{ width: '70%', height: 12 }}/>
    </div>
    <span className={Classes.SKELETON} style={{ width: 60, height: 18 }}/>
  </Row>)}
</Rows>;

export const LoadError = ({ what, error, onRetry }) => <div role="alert" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 0' }}>
  <Icon icon="error" intent="danger"/>
  <span>Could not load {what}: <span className={Classes.TEXT_MUTED}>{errorMessage(error)}</span></span>
  <Button size="small" icon="refresh" text="Retry" onClick={onRetry}/>
</div>;

export const Empty = ({ children }) => <p className={Classes.TEXT_MUTED} style={{ margin: '6px 0' }}>{children}</p>;

export const ProjectLink = ({ project }) => <Link to={`/${path_segment(project)}`} className={Classes.TEXT_MUTED} style={{ overflowWrap: 'anywhere' }}>{project}</Link>;

// A batch: its label, project and commit, when it last ran. `icon` says how it went, `children` go on the right.
export const BatchRow = ({ batch, icon, show_user = false, link = batch_url(batch.project, batch), children }) => {
  const { commit } = batch;
  const message = (commit?.message ?? '').split('\n')[0];
  return <Row>
    {icon}
    <div style={{ minWidth: 0 }}>
      <div className="qa-home-meta">
        <Link to={link} className="qa-home-title" title={batch.label}>{batch_name(batch)}</Link>
        <ProjectLink project={batch.project}/>
        {batch.origin && batch.origin !== 'ci' && <OriginTag origin={batch.origin}/>}
      </div>
      <div className={`qa-home-sub ${Classes.TEXT_MUTED}`}>
        {show_user && batch.user_name && <span><Icon icon="person" size={12}/> {batch.user_name}</span>}
        {batch.latest_output_datetime && <Time iso={batch.latest_output_datetime}/>}
        {commit?.branch && <span className="qa-home-cut" title={commit.branch} style={{ maxWidth: '45%' }}><Icon icon="git-branch" size={12}/> {commit.branch}</span>}
        {message && <span className="qa-home-cut" title={commit.message}>{message}</span>}
      </div>
    </div>
    <div className="qa-home-side">{children}</div>
  </Row>;
};
