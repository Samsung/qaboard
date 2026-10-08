// "What's new": release notes pop up on load when there are new ones,
// and can be opened anytime from the sidebar, the footer, the projects list, or https://qa/#whats-new
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import styled from "styled-components";
import posthog from "posthog-js";
import {
  Button,
  Classes,
  Collapse,
  Dialog,
  DialogBody,
  DialogFooter,
  Drawer,
  DrawerSize,
  Icon,
  InputGroup,
  NonIdealState,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import {
  AUDIENCES,
  HASH,
  getLastSeen,
  setLastSeen,
  isPreview,
  lastSeenSlug,
  popupNotes,
  renderHtml,
  resolveLink,
  searchNotes,
  unseenNotes,
} from "./logic";


const ReleaseNotesContext = createContext({
  notes: [],
  hasUnread: false,
  open: () => {},
});
export const useReleaseNotes = () => useContext(ReleaseNotesContext);

const track = (event, properties) => {
  if (posthog.__loaded) posthog.capture(event, properties);
};

// The notes are in their own chunk: they are not needed for the first render.
// They come from website/release-notes/, see webapp/releaseNotes.js
const loadNotes = () => import("virtual:release-notes")
  .then(m => (m.default || m).notes);


export const ReleaseNotesProvider = ({ children, load = loadNotes, popupDelay = 1000 }) => {
  const docs_root = useSelector(state => state.siteConfig?.docs_root) ?? "/";
  const [notes, setNotes] = useState([]);
  // Notes not seen before this page load: they keep their "New" tag until the next one
  const [newSlugs, setNewSlugs] = useState(new Set());
  const [popup, setPopup] = useState([]);
  const [hasUnread, setHasUnread] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(window.location.hash === HASH);

  useEffect(() => {
    let timer;
    let cancelled = false;
    load().then(notes => {
      if (cancelled) return;
      const lastSeen = getLastSeen();
      const to_popup = popupNotes(notes, lastSeen);
      setNotes(notes);
      setNewSlugs(new Set(unseenNotes(notes, lastSeen).map(n => n.slug)));
      setPopup(to_popup);
      setHasUnread(to_popup.length > 0);
      if (to_popup.length > 0 && window.location.hash !== HASH)
        timer = setTimeout(() => {
          // another tab may have shown the notes in the meantime
          if (popupNotes(notes, getLastSeen()).length === 0) return;
          setDialogOpen(true);
          track("release_notes_popup", { slug: to_popup[0].slug });
        }, popupDelay);
    }).catch(error => console.warn("Could not load the release notes", error));
    return () => { cancelled = true; clearTimeout(timer) };
  }, [load, popupDelay]);

  const markSeen = useCallback(() => {
    const newest = lastSeenSlug(notes);
    if (newest) setLastSeen(newest);
    setHasUnread(false);
  }, [notes]);

  const open = useCallback(via => {
    setDialogOpen(false);
    setDrawerOpen(true);
    track("release_notes_open", { via });
  }, []);

  // The link https://qa/#whats-new opens the panel, also from a page already loaded
  useEffect(() => {
    const onHashChange = () => { if (window.location.hash === HASH) open("link") };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [open]);
  useEffect(() => {
    if (drawerOpen && notes.length > 0) markSeen();
  }, [drawerOpen, notes, markSeen]);

  const closeDialog = () => { setDialogOpen(false); markSeen() };
  const closeDrawer = () => {
    setDrawerOpen(false);
    if (window.location.hash === HASH)
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  };

  const context = useMemo(() => ({ notes, hasUnread, open }), [notes, hasUnread, open]);
  return <ReleaseNotesContext.Provider value={context}>
    {children}
    <WhatsNewDialog
      isOpen={dialogOpen}
      notes={popup}
      docs_root={docs_root}
      onClose={closeDialog}
      onSeeAll={() => { markSeen(); open("popup") }}
    />
    <WhatsNewDrawer
      isOpen={drawerOpen}
      notes={notes}
      newSlugs={newSlugs}
      docs_root={docs_root}
      onClose={closeDrawer}
    />
  </ReleaseNotesContext.Provider>
};


// ---------------------------------------------------------------- entry points
const UnreadDot = styled.span`
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00d4ff;
  box-shadow: 0 0 0 2px #252a31;
`;

// An icon button, for the sidebar header
export const WhatsNewButton = ({ via = "button", ...props }) => {
  const { hasUnread, open } = useReleaseNotes();
  return <Tooltip content={hasUnread ? "What's new: new release notes!" : "What's new"}>
    <span style={{ position: "relative", display: "inline-block" }}>
      <Button
        variant="minimal"
        size="small"
        icon="clean"
        aria-label="What's new"
        onClick={() => open(via)}
        {...props}
      />
      {hasUnread && <UnreadDot data-testid="whats-new-unread" />}
    </span>
  </Tooltip>
};

// A text link, for footers
export const WhatsNewLink = ({ via = "link", children = "What's new" }) => {
  const { hasUnread, open } = useReleaseNotes();
  return <a href={HASH} onClick={e => { e.preventDefault(); open(via) }}>
    {children}{hasUnread && <Tag minimal round intent="primary" style={{ marginLeft: 4 }}>new</Tag>}
  </a>
};


// ---------------------------------------------------------------- notes
const HighlightsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(${props => props.$compact ? 220 : 260}px, 1fr));
  gap: 12px;
  margin: 12px 0;
`;

const Card = styled.div`
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid rgba(17, 20, 24, 0.12);
  background: #fff;
  transition: box-shadow 150ms ease, border-color 150ms ease;
  &:hover {
    border-color: rgba(31, 124, 232, 0.5);
    box-shadow: 0 2px 8px rgba(17, 20, 24, 0.08);
  }
  h4 {
    margin: 0 0 4px 0;
    font-size: 14px;
    line-height: 1.3;
  }
  p {
    margin: 0;
    color: #404854;
    line-height: 1.45;
  }
  code {
    font-size: 12px;
    background: rgba(17, 20, 24, 0.06);
    padding: 1px 4px;
    border-radius: 3px;
  }
`;

const IconBubble = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(31, 124, 232, 0.1);
  color: #1f7ce8;
`;

// Highlight descriptions are plain text, with `code` spans
const withCode = text => text.split(/`([^`]+)`/).map((part, idx) => (idx % 2 ? <code key={idx}>{part}</code> : part));

const AudienceTag = ({ audience }) => {
  const a = AUDIENCES[audience];
  if (!a) return null;
  return <Tag minimal round intent={a.intent} style={{ marginBottom: 6 }}>{a.label}</Tag>
};

export const HighlightCard = ({ highlight, docs_root }) => {
  const href = resolveLink(highlight.link, docs_root);
  return <Card>
    <IconBubble><Icon icon={highlight.icon || "star"} size={18} /></IconBubble>
    <div style={{ minWidth: 0 }}>
      <AudienceTag audience={highlight.audience} />
      <h4>{highlight.title}</h4>
      <p>{withCode(highlight.description)}</p>
      {href && <p style={{ marginTop: 6 }}>
        <a href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
          Learn more <Icon icon="arrow-right" size={12} />
        </a>
      </p>}
    </div>
  </Card>
};

const Eyebrow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  h3 {
    margin: 0;
    font-size: 18px;
  }
`;

const NoteHeader = ({ note, isNew }) => <Eyebrow>
  <h3>{note.title}</h3>
  {note.version && <Tag minimal round icon="tag">v{note.version}</Tag>}
  {isNew && <Tag round intent="primary">New</Tag>}
  {isPreview(note) && <Tooltip content="This period isn't over: more changes will be added">
    <Tag minimal round icon="time">In progress</Tag>
  </Tooltip>}
</Eyebrow>;

const Description = styled.p`
  font-size: 15px;
  line-height: 1.5;
  color: #1c2127;
  margin: 8px 0 0 0;
`;

const Details = styled.div`
  line-height: 1.55;
  h2 {
    font-size: 15px;
    margin: 18px 0 6px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(17, 20, 24, 0.1);
  }
  h3 {
    font-size: 14px;
    margin: 12px 0 4px 0;
  }
  ul {
    padding-left: 20px;
    margin: 4px 0;
  }
  li {
    margin: 3px 0;
  }
  code {
    font-size: 12px;
    background: rgba(17, 20, 24, 0.06);
    padding: 1px 4px;
    border-radius: 3px;
  }
  img {
    max-width: 100%;
  }
`;

const NoteSection = styled.section`
  padding: 20px 24px;
  border-bottom: 1px solid rgba(17, 20, 24, 0.1);
`;

const ReleaseNote = ({ note, isNew, expanded, docs_root }) => {
  const [showDetails, setShowDetails] = useState(expanded);
  useEffect(() => setShowDetails(expanded), [expanded]);
  const html = useMemo(() => renderHtml(note.html, docs_root), [note.html, docs_root]);
  return <NoteSection id={`release-note-${note.slug}`}>
    <NoteHeader note={note} isNew={isNew} />
    <Description>{note.description}</Description>
    {note.highlights.length > 0 && <HighlightsGrid $compact>
      {note.highlights.map((h, idx) => <HighlightCard key={idx} highlight={h} docs_root={docs_root} />)}
    </HighlightsGrid>}
    {!!html && <>
      <Button
        variant="minimal"
        size="small"
        icon={showDetails ? "chevron-down" : "chevron-right"}
        text={showDetails ? "Hide details" : "All changes"}
        onClick={() => setShowDetails(!showDetails)}
        style={{ marginLeft: -8 }}
      />
      <Collapse isOpen={showDetails} keepChildrenMounted>
        <Details dangerouslySetInnerHTML={{ __html: html }} />
      </Collapse>
    </>}
  </NoteSection>
};


// ---------------------------------------------------------------- dialog & drawer
export const WhatsNewDialog = ({ isOpen, notes, docs_root, onClose, onSeeAll }) => {
  // A single popup even after a long absence: the latest notes only
  const shown = notes.slice(0, 2);
  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title="What's new in QA-Board"
    icon="clean"
    style={{ width: 720, maxWidth: "calc(100vw - 40px)" }}
  >
    <DialogBody useOverflowScrollContainer>
      {shown.map((note, idx) => <div key={note.slug} style={{ marginTop: idx > 0 ? 24 : 0 }}>
        <NoteHeader note={note} />
        <Description>{note.description}</Description>
        {/* the older notes stay short, their highlights are in the panel */}
        {idx === 0 && <HighlightsGrid>
          {note.highlights.map((h, i) => <HighlightCard key={i} highlight={h} docs_root={docs_root} />)}
        </HighlightsGrid>}
      </div>)}
      {notes.length > shown.length && <p className={Classes.TEXT_MUTED}>
        And {notes.length - shown.length} more release notes since your last visit.
      </p>}
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="See all changes" icon="list" onClick={onSeeAll} />
      <Button intent="primary" text="Got it" onClick={onClose} autoFocus />
    </>}>
      <span className={Classes.TEXT_MUTED}>Find them again with the <Icon icon="clean" size={12} /> button in the sidebar.</span>
    </DialogFooter>
  </Dialog>
};

export const WhatsNewDrawer = ({ isOpen, notes, newSlugs, docs_root, onClose }) => {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => searchNotes(notes, query), [notes, query]);
  return <Drawer
    isOpen={isOpen}
    onClose={onClose}
    title="What's new"
    icon="clean"
    size={DrawerSize.STANDARD}
    style={{ minWidth: 420, maxWidth: "100vw" }}
  >
    <div style={{ padding: "12px 24px", borderBottom: "1px solid rgba(17, 20, 24, 0.1)" }}>
      <InputGroup
        leftIcon="search"
        placeholder="Search the release notes..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        round
        rightElement={query ? <Button variant="minimal" icon="cross" aria-label="Clear" onClick={() => setQuery("")} /> : undefined}
      />
    </div>
    <div className={Classes.DRAWER_BODY} style={{ background: "#f6f7f9" }}>
      {notes.length === 0 && <NonIdealState icon="clean" title="No release notes yet" />}
      {notes.length > 0 && filtered.length === 0 && <NonIdealState icon="search" title="No matching release notes" />}
      {filtered.map((note, idx) => <ReleaseNote
        key={note.slug}
        note={note}
        isNew={newSlugs.has(note.slug)}
        expanded={!!query || idx === 0}
        docs_root={docs_root}
      />)}
    </div>
  </Drawer>
};
