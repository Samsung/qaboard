// The cheat sheet: keyboard shortcuts, QA-Board's words, the filter syntax and links to the docs.
// Press "?" anywhere (except while typing), or click the help button in the sidebar.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AnchorButton, Button, Classes, Dialog, DialogBody, DialogFooter, HTMLTable } from "@blueprintjs/core";
import styled from "styled-components";

import { useSiteConfig } from "../hooks";
import { useReleaseNotes } from "../releaseNotes/ReleaseNotes";

const HelpSheetContext = createContext({ open: () => {}, isOpen: false });
export const useHelpSheet = () => useContext(HelpSheetContext);

// Typing "?" in a text box, a select or an editor (Monaco types in a textarea) must type it
export const is_typing = target => target instanceof Element
  && !!target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"]');

export const HelpSheetProvider = ({ children }) => {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (is_typing(event.target)) return;
      event.preventDefault();
      setOpen(is_open => !is_open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const value = useMemo(() => ({ open, isOpen }), [open, isOpen]);
  return <HelpSheetContext.Provider value={value}>
    {children}
    <HelpSheet isOpen={isOpen} onClose={() => setOpen(false)}/>
  </HelpSheetContext.Provider>;
};


const Columns = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
  gap: 8px 32px;
  h4 {
    margin: 14px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--qa-text-muted);
  }
  h4:first-child {
    margin-top: 0;
  }
  table {
    width: 100%;
  }
  td:first-child {
    white-space: nowrap;
    width: 1%;
    padding-right: 12px;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
  }
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0;
  }
`;

const Kbd = ({ children }) => <kbd className={Classes.KEY}>{children}</kbd>;

const Doc = ({ page, children }) => {
  const { docs_root } = useSiteConfig();
  return <a href={`${docs_root}docs/${page}`} target="_blank" rel="noopener noreferrer">{children}</a>;
};

const shortcuts = [
  { title: "Everywhere", keys: [
    [<Kbd key="?">?</Kbd>, "Open or close this cheat sheet"],
    [<Kbd key="esc">Esc</Kbd>, "Close dialogs and menus"],
    [<><Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>Enter</Kbd></>, "Pick an item in the batch selector or filter suggestions"],
  ]},
  { title: "Image and text viewers", keys: [
    [<Kbd key="t">t</Kbd>, "Swap new and reference in place, in all the viewers"],
    [<Kbd key="h">h</Kbd>, "Hide or show the new/reference labels"],
    [<Kbd key="c">c</Kbd>, "Select a region of an image (after clicking it), Enter to see its histogram"],
  ]},
  { title: "Videos (hover or click a player)", keys: [
    [<Kbd key="space">Space</Kbd>, "Play or pause"],
    [<><Kbd>←</Kbd> <Kbd>→</Kbd></>, "Previous or next frame; with Shift, one second"],
    [<><Kbd>[</Kbd> <Kbd>]</Kbd></>, "Slower or faster"],
    [<><Kbd>+</Kbd> <Kbd>−</Kbd> <Kbd>0</Kbd></>, "Zoom in, zoom out, fit"],
    [<><Kbd>1</Kbd>–<Kbd>4</Kbd></>, "Side by side, wipe, toggle... when comparing"],
    [<><Kbd>t</Kbd> <Kbd>h</Kbd> <Kbd>m</Kbd></>, "Swap, hide labels, mute"],
  ]},
  { title: "Available Tests", keys: [
    [<><Kbd>Ctrl</Kbd> <Kbd>S</Kbd></>, "Save the batches file (⌘ S on macOS)"],
  ]},
];

const HelpSheet = ({ isOpen, onClose }) => {
  const { docs_root, support_url } = useSiteConfig();
  const { open: openReleaseNotes } = useReleaseNotes();
  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title="Cheat sheet"
    icon="help"
    style={{ width: 860, maxWidth: 'calc(100vw - 32px)' }}
  >
    <DialogBody>
      <Columns>
        <div>
          {shortcuts.map(({ title, keys }) => <div key={title}>
            <h4>{title}</h4>
            <HTMLTable compact>
              <tbody>
                {keys.map(([key, what], idx) => <tr key={idx}><td>{key}</td><td>{what}</td></tr>)}
              </tbody>
            </HTMLTable>
          </div>)}
          <p className={Classes.TEXT_MUTED} style={{ marginTop: 10 }}>Shortcuts are ignored while you type in a text box.</p>
        </div>
        <div>
          <h4>Words</h4>
          <dl>
            <dt>Run</dt><dd>Your code from one commit, on one input, with one configuration and platform. It has output files, metrics and a log.</dd>
            <dt>Batch</dt><dd>Runs of the same commit, with a label. <strong>CI</strong> is the batch your CI runs; tuning experiments get their own. <Doc page="batches-running-on-multiple-inputs">Batches</Doc></dd>
            <dt>New, reference</dt><dd>Results are always compared: each run with the reference's run of the same input. <Doc page="references-and-milestones">References</Doc></dd>
            <dt>Milestone</dt><dd>A commit and batch you keep as a reference: a release, a benchmark.</dd>
            <dt>Target</dt><dd>A metric's goal, from your metrics file: tables and the Summary color runs that meet it. <Doc page="computing-quantitative-metrics">Metrics</Doc></dd>
            <dt>Artifacts</dt><dd>The build your CI saved for a commit, so you can run it again from the web app. <Doc page="storage/artifacts">Artifacts</Doc></dd>
          </dl>
          <h4>Filtering runs</h4>
          <p>
            <code>night indoor</code> both words, <code>-night</code> excludes, <code>2X5|GW1</code> regular expression,{" "}
            <code>threshold:0.5</code> tuning parameter, <code>failed</code>, <code>running</code>, <code>id:1234</code>.{" "}
            <Doc page="user-guide/finding-results#filter-syntax">Filter syntax</Doc>
          </p>
          <h4>Searching commits</h4>
          <p>
            Words match the hash, message, committer, branch or batches. <code>branch:</code>, <code>committer:</code>,{" "}
            <code>batch:</code>, <code>message:</code> and <code>id:</code> look at one field. <Doc page="user-guide/finding-results#searching-commits">Searching commits</Doc>
          </p>
        </div>
      </Columns>
    </DialogBody>
    <DialogFooter actions={<>
      {support_url && <AnchorButton variant="minimal" icon="chat" text="Ask for help" href={support_url} target="_blank" rel="noopener noreferrer"/>}
      <Button variant="minimal" icon="clean" text="What's new" onClick={() => { onClose(); openReleaseNotes('cheat-sheet'); }}/>
      <AnchorButton intent="primary" icon="manual" text="User guide" href={`${docs_root}docs/user-guide/overview`} target="_blank" rel="noopener noreferrer"/>
    </>}>
      <span className={Classes.TEXT_MUTED}>Hover almost anything for an explanation.</span>
    </DialogFooter>
  </Dialog>;
};
