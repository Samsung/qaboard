// The home page's right column: what's new, the user's storage, and docs for what they haven't tried yet
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, Icon, Tag } from "@blueprintjs/core";

import { Link } from "../router";
import { useSiteConfig } from "../hooks";
import { useReleaseNotes } from "../releaseNotes/ReleaseNotes";
import { isPreview, resolveLink } from "../releaseNotes/logic";
import { overviewQuery } from "../storage/api";
import { formatBytes } from "../storage/format";
import { learn } from "./logic";
import { Section } from "./parts";


const list_style = { listStyle: 'none', margin: 0, padding: 0 };
const item_style = { display: 'flex', gap: 10, padding: '7px 0', alignItems: 'flex-start' };

// The latest note's highlights, the panel has the rest
export const WhatsNew = () => {
  const { notes, hasUnread, open } = useReleaseNotes();
  const { docs_root } = useSiteConfig();
  const note = notes[0];
  if (!note) return null;
  return <Section
    id="whats-new"
    title={<>What's new{hasUnread && <Tag minimal round intent="primary">new</Tag>}</>}
    icon="clean"
    extra={isPreview(note) ? <Tag minimal round icon="time" title="This period isn't over: more changes will be added">In progress</Tag> : undefined}
  >
    <div className={Classes.TEXT_MUTED} style={{ fontSize: 13 }}>{note.title}</div>
    <ul style={list_style}>
      {note.highlights.slice(0, 3).map(highlight => {
        const href = resolveLink(highlight.link, docs_root);
        return <li key={highlight.title} style={item_style}>
          <Icon icon={highlight.icon || "star"} style={{ color: 'var(--qa-link)', marginTop: 2 }}/>
          {href
            ? <a href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{highlight.title}</a>
            : <span>{highlight.title}</span>}
        </li>;
      })}
    </ul>
    <Button size="small" variant="outlined" icon="list" text="See all changes" onClick={() => open("home")} style={{ marginTop: 4 }}/>
  </Section>;
};

// How much the user's runs take, when the server measures it. Nothing to say otherwise.
export const YourStorage = () => {
  const { data: overview, isError } = useQuery({ ...overviewQuery({ scope: 'me' }), retry: false });
  if (isError || !overview?.totals?.runs) return null;
  const biggest = overview.projects?.[0];
  return <Section id="storage" title="Your storage" icon="database">
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '4px 0' }}>
      <span style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatBytes(overview.totals.bytes)}</span>
      <span className={Classes.TEXT_MUTED}>in {overview.totals.runs.toLocaleString('en-US')} runs</span>
    </div>
    {biggest && overview.totals.projects > 1 && <div className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`} style={{ overflowWrap: 'anywhere' }}>
      The biggest: {biggest.project_id}, {formatBytes(biggest.bytes)}
    </div>}
    <p style={{ margin: '8px 0 2px' }}>
      <Link to="/storage">See it and clean up <Icon icon="arrow-right" size={12}/></Link>
    </p>
  </Section>;
};

// usage: {has_batches, has_webapp, has_running}
export const Learn = ({ usage }) => {
  const { docs_root } = useSiteConfig();
  const links = learn(usage);
  return <Section id="learn" title="Learn" icon="learning">
    <ul style={list_style}>
      {links.map(link => <li key={link.id} style={{ ...item_style, flexDirection: 'column', gap: 0 }}>
        <a href={`${docs_root}${link.path}`}>{link.title} <Icon icon="arrow-right" size={12}/></a>
        <span className={`${Classes.TEXT_MUTED} ${Classes.TEXT_SMALL}`}>{link.description}</span>
      </li>)}
    </ul>
    <p style={{ margin: '6px 0 2px' }}><a href={`${docs_root}docs/user-guide/overview`} className={Classes.TEXT_SMALL}>The user guide</a></p>
  </Section>;
};
