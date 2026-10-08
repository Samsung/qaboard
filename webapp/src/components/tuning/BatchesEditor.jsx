// "Available Tests": edit the shared and private files that define batches of tests
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import axios from "axios";
import { DateTime } from "luxon";
import { CopyToClipboard } from "react-copy-to-clipboard";
import {
  Alert,
  Button,
  ButtonGroup,
  Callout,
  Classes,
  Dialog,
  DialogBody,
  DialogFooter,
  Drawer,
  Icon,
  InputGroup,
  Intent,
  NonIdealState,
  Section,
  SectionCard,
  Spinner,
  Tab,
  Tabs,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import MonacoEditor, { MonacoDiffEditor } from "../MonacoEditor";
import { toaster } from "../../toaster";
import { updateSelected } from "../../actions/selected";
import { updateTuningForm } from "../../actions/tuning";
import { analyzeBatches, newBatchSnippet, unusedBatchName } from "./batches_file";

const { get, post } = axios;


const editor_options = {
  selectOnLineNumbers: true,
  seedSearchStringFromSelection: true,
  renderWhitespace: "all",
  automaticLayout: true, // the editor is hidden while reviewing changes
  scrollBeyondLastLine: false,
  minimap: { enabled: false },
  tabSize: 2,
  insertSpaces: true, // YAML forbids tabs for indentation
};
const diff_options = { readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false } };
const editor_height = "max(420px, calc(100vh - 290px))";

const is_mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
export const SAVE_SHORTCUT = is_mac ? "⌘S" : "Ctrl+S";


// Unsaved changes are kept in the browser, in case you switch views, reload or close the tab
const draft_key = (project, name) => `qaboard:batches-draft:${project}/${name}`;
const loadDraft = (project, name) => {
  try {
    const stored = JSON.parse(localStorage.getItem(draft_key(project, name)));
    return typeof stored?.draft === "string" && typeof stored?.base === "string" ? stored : null;
  } catch {
    return null;
  }
};
const storeDraft = (project, name, doc) => {
  try {
    if (doc.draft === doc.base) localStorage.removeItem(draft_key(project, name));
    else localStorage.setItem(draft_key(project, name), JSON.stringify({ draft: doc.draft, base: doc.base, at: Date.now() }));
  } catch {
    // e.g. private browsing or a full storage: we only lose the drafts' backup
  }
};

// The server returns the file as-is: don't let axios parse it as JSON
const getFile = (project, name) =>
  get("/api/v1/tests/groups", { params: { project, name }, responseType: "text", transformResponse: r => r })
    .then(response => response.data ?? "");

const errorMessage = error => {
  const data = error?.response?.data;
  if (typeof data === "string" && data.length > 0) {
    try {
      const parsed = JSON.parse(data);
      return typeof parsed === "string" ? parsed : parsed?.error ?? data;
    } catch {
      return data;
    }
  }
  return data?.error ?? (error?.response?.status === 401 ? "Please log in again." : error?.message ?? String(error));
};

const relative = date => Date.now() - date.getTime() < 10 * 1000
  ? "just now"
  : DateTime.fromJSDate(date).toRelative({ style: "short" }) ?? "just now";


const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
  @media (max-width: 1100px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 6px 0 8px;
  border-bottom: 1px solid rgba(17, 20, 24, 0.15);
  margin-bottom: 8px;
  .bp6-tab-list { align-items: center; }
`;

const Spacer = styled.div`flex: 1 1 auto;`;

const Status = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 13px;
`;

const DirtyDot = styled.span`
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-left: 6px;
  background: #c87619;
  vertical-align: middle;
`;

const EditorFrame = styled.div`
  border: 1px solid rgba(17, 20, 24, 0.15);
  border-radius: 2px;
  overflow: hidden;
`;

const Problems = styled.ul`
  list-style: none;
  margin: 0;
  padding: 4px 0;
  border-top: 1px solid rgba(17, 20, 24, 0.15);
  max-height: 120px;
  overflow: auto;
  font-size: 12px;
`;

const ProblemButton = styled.button`
  all: unset;
  box-sizing: border-box;
  width: 100%;
  padding: 2px 8px;
  cursor: pointer;
  display: flex;
  gap: 6px;
  align-items: baseline;
  &:hover, &:focus-visible { background: rgba(143, 153, 168, 0.15); }
`;

const OutlineList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: calc(100vh - 480px);
  min-height: 120px;
  overflow: auto;
`;

const OutlineRow = styled.li`
  display: flex;
  align-items: center;
  padding-right: 4px;
  border-radius: 2px;
  .actions { visibility: hidden; display: flex; }
  &:hover, &:focus-within { background: rgba(143, 153, 168, 0.15); }
  &:hover .actions, &:focus-within .actions { visibility: visible; }
  .goto {
    all: unset;
    box-sizing: border-box;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 4px 4px 8px;
    cursor: pointer;
  }
  .goto:focus-visible { outline: 2px solid rgba(45, 114, 210, 0.6); outline-offset: -2px; }
  .name {
    flex: 0 1 auto;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overridden .name { text-decoration: line-through; }
  /* the name has priority over the details */
  .meta { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: right; white-space: nowrap; font-size: 12px; }
`;

const TestList = styled.ol`
  margin: 0;
  padding-left: 3em;
  font-size: 13px;
  li { padding: 3px 0; }
  .path { font-family: monospace; margin-right: 6px; word-break: break-all; }
`;


const item_meta = item => {
  if (item.overridden_by) return `replaced, line ${item.overridden_by}`;
  if (item.kind === "alias") return `alias → ${item.targets.join(", ") || "nothing"}`;
  if (item.kind === "setting") return "file setting";
  if (item.kind === "pipeline") return "pipeline";
  if (item.inputs === undefined) return "";
  return `${item.inputs} input${item.inputs === 1 ? "" : "s"}`;
};


/**
 * Lists the tests a batch (or pattern, or alias) resolves to, as `qa batch` would see them on this commit.
 */
function BatchPreview({ project, commit, file_names, batch, onRun, unsaved }) {
  const [query, setQuery] = useState(batch);
  const [state, setState] = useState({ loading: false, tests: null, error: null, message: null });
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(200);
  const request = useRef(0);

  const resolveBatch = useCallback(name => {
    if (!name) return;
    const id = ++request.current;
    setState({ loading: true, tests: null, error: null, message: null });
    setShown(200);
    post("/api/v1/tests/group", { groups: file_names }, { params: { project, name, commit: commit?.id } })
      .then(({ data }) => {
        if (id !== request.current) return;
        setState({ loading: false, tests: data.tests ?? [], error: data.error ?? null, message: data.message ?? null });
      })
      .catch(error => {
        if (id !== request.current) return;
        setState({ loading: false, tests: null, error: errorMessage(error), message: null });
      });
  }, [project, commit?.id, file_names]);

  useEffect(() => {
    if (batch) resolveBatch(batch);
  }, [batch, resolveBatch]);

  const tests = useMemo(() => state.tests ?? [], [state.tests]);
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return tests;
    return tests.filter(t => `${t.input_path} ${JSON.stringify(t.configurations)}`.toLowerCase().includes(f));
  }, [tests, filter]);
  const nb_inputs = useMemo(() => new Set(tests.map(t => t.input_path)).size, [tests]);

  return <div className={Classes.DRAWER_BODY}>
      <div style={{ padding: "16px 20px" }}>
        <form onSubmit={e => { e.preventDefault(); resolveBatch(query.trim()); }} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <InputGroup
            fill
            leftIcon="search"
            placeholder="A batch, an alias, or a pattern like nightly-*"
            value={query}
            onValueChange={setQuery}
            aria-label="Batch to check"
          />
          <Button type="submit" text="Check" intent={Intent.PRIMARY} disabled={!query.trim()} loading={state.loading} />
        </form>

        {unsaved.length > 0 && <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 12 }}>
          This uses the saved files: your unsaved changes to {unsaved.join(" and ")} are not included.
        </Callout>}

        {state.message && <Callout intent={Intent.WARNING} title="This commit's batch files could not be read" style={{ marginBottom: 12 }}>
          Only the shared and private files are used.{" "}
          <span className={Classes.TEXT_MUTED}>{state.message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}</span>
        </Callout>}

        {state.error && <Callout intent={Intent.DANGER} title="Could not list the tests" style={{ marginBottom: 12 }}>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{state.error}</pre>
        </Callout>}

        {state.loading && <Spinner size={30} />}

        {state.tests !== null && !state.loading && (tests.length === 0
          ? !state.error && <NonIdealState
              icon="search"
              title="No tests"
              description={<>No batch matches <code>{query}</code> on this commit. Check its name, or save the file that defines it.</>}
            />
          : <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong>{tests.length} test{tests.length === 1 ? "" : "s"}</strong>
              <span className={Classes.TEXT_MUTED}>on {nb_inputs} input{nb_inputs === 1 ? "" : "s"}</span>
              <Spacer />
              <Button icon="play" text="Run…" onClick={() => onRun(query.trim())} />
            </div>
            {tests.length > 10 && <InputGroup
              size="small"
              leftIcon="filter"
              placeholder="Filter inputs and configurations"
              value={filter}
              onValueChange={setFilter}
              style={{ marginBottom: 8 }}
              rightElement={filter ? <Tag minimal>{filtered.length}</Tag> : undefined}
            />}
            <TestList>
              {filtered.slice(0, shown).map((t, idx) => <li key={idx}>
                <span className="path">{t.input_path}</span>
                {(t.configurations ?? []).map((c, c_idx) =>
                  <Tag key={c_idx} minimal intent={Intent.PRIMARY} style={{ marginRight: 4, marginBottom: 2 }}>
                    {typeof c === "string" ? c : JSON.stringify(c)}
                  </Tag>
                )}
              </li>)}
            </TestList>
            {filtered.length > shown && <Button variant="minimal" size="small" icon="more" text={`Show ${Math.min(500, filtered.length - shown)} more`} onClick={() => setShown(shown + 500)} />}
          </>
        )}
      </div>
    </div>;
}


/**
 * Edits the shared and private files that define batches of tests.
 * Props: project, commit, config, git, available_tests_files ({gr: "extra-batches", usr: user_name}), docs_root, dispatch
 */
export function BatchesEditor({ project, commit, config, git, available_tests_files, docs_root, dispatch }) {
  // the object is new at each render of the commit page: depend on the names, or we'd reload the files all the time
  const private_name = available_tests_files?.usr;
  const shared_name = available_tests_files?.gr;
  const files = useMemo(() => [
    private_name && { id: "usr", name: private_name, label: "Private", icon: "lock", help: "Only you can see and edit it." },
    shared_name && { id: "gr", name: shared_name, label: "Shared", icon: "people", help: "Everyone can see and edit it." },
  ].filter(Boolean), [private_name, shared_name]);
  const file_names = useMemo(() => files.map(f => f.name).reverse(), [files]); // later files override earlier ones

  const [selected, setSelected] = useState(files[0]?.id);
  // per file name: {status: loading|ready|error, base: last saved content, draft, saving, saveError, savedAt, restoredAt, loadError}
  const [docs, setDocs] = useState({});
  const [reviewing, setReviewing] = useState(false);
  const [conflict, setConflict] = useState(null); // {name, server}
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [preview, setPreview] = useState({ isOpen: false, batch: "", id: 0 }); // batch: "" for an empty search
  const [outlineFilter, setOutlineFilter] = useState("");
  const [, setNow] = useState(0); // refreshes "saved 1 min ago"
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  const file = files.find(f => f.id === selected) ?? files[0];
  const doc = file ? docs[file.name] : undefined;
  const dirty = !!doc && doc.status === "ready" && doc.draft !== doc.base;
  const dirty_files = files.filter(f => docs[f.name]?.status === "ready" && docs[f.name].draft !== docs[f.name].base);

  const updateDoc = useCallback((name, update) => setDocs(prev => {
    const current = prev[name] ?? {};
    return { ...prev, [name]: { ...current, ...(typeof update === "function" ? update(current) : update) } };
  }), []);

  const load = useCallback(name => {
    updateDoc(name, { status: "loading", loadError: null });
    getFile(project, name)
      .then(content => {
        const stored = loadDraft(project, name);
        const restored = stored && stored.draft !== content;
        updateDoc(name, {
          status: "ready",
          // keep what the draft was based on: if the file changed since, saving it will warn about the conflict
          base: restored ? stored.base : content,
          draft: restored ? stored.draft : content,
          restoredAt: restored ? new Date(stored.at) : null,
          serverChanged: restored && stored.base !== content,
        });
      })
      .catch(error => updateDoc(name, { status: "error", loadError: errorMessage(error) }));
  }, [project, updateDoc]);

  useEffect(() => {
    files.forEach(f => load(f.name));
  }, [files, load]);

  // Backup the drafts. Not debounced: we'd lose the last changes when the page is closed right after
  useEffect(() => {
    Object.entries(docs).forEach(([name, d]) => { if (d.status === "ready") storeDraft(project, name, d) });
  }, [docs, project]);

  // Warn before leaving the page with unsaved changes
  const has_dirty = dirty_files.length > 0;
  useEffect(() => {
    if (!has_dirty) return;
    const onBeforeUnload = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [has_dirty]);

  useEffect(() => {
    const interval = setInterval(() => setNow(n => n + 1), 15 * 1000);
    return () => clearInterval(interval);
  }, []);

  const analysis = useMemo(() => analyzeBatches(doc?.draft ?? ""), [doc?.draft]);
  const errors = analysis.problems.filter(p => p.severity === "error");
  const warnings = analysis.problems.filter(p => p.severity === "warning");

  // Show the problems in the editor
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(model, "batches", analysis.problems.map(p => ({
      severity: p.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: p.message,
      startLineNumber: p.line,
      startColumn: p.column,
      endLineNumber: p.endLine,
      endColumn: p.endColumn,
    })));
  }, [analysis, file?.name, doc?.status]);

  const goToLine = (line, column = 1) => {
    const editor = editorRef.current;
    if (!editor) return;
    setReviewing(false);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  };

  const write = useCallback((name, content) => {
    updateDoc(name, { saving: true, saveError: null });
    return post("/api/v1/tests/groups", { project, groups: content }, { params: { project, name } })
      .then(() => {
        updateDoc(name, { saving: false, base: content, savedAt: new Date(), restoredAt: null, serverChanged: false });
      })
      .catch(error => {
        const message = errorMessage(error);
        updateDoc(name, { saving: false, saveError: message });
        toaster.show({ message: `Could not save ${name}.yml: ${message}`, intent: Intent.DANGER, icon: "error" });
      });
  }, [project, updateDoc]);

  const save = useCallback(() => {
    if (!file || !doc || doc.status !== "ready" || doc.saving || doc.draft === doc.base) return;
    const { name } = file;
    const content = doc.draft;
    updateDoc(name, { saving: true, saveError: null });
    // Don't overwrite changes someone else saved while we were editing
    getFile(project, name)
      .catch(() => doc.base) // we'll know soon enough if the server is unreachable
      .then(server => {
        if (server !== doc.base) {
          updateDoc(name, { saving: false });
          setConflict({ name, server, label: file.label });
          return;
        }
        return write(name, content);
      });
  }, [file, doc, project, updateDoc, write]);

  const discard = () => {
    if (!file || !doc) return;
    const { name } = file;
    const { draft } = doc;
    updateDoc(name, d => ({ draft: d.base, saveError: null, restoredAt: null }));
    setReviewing(false);
    toaster.show({
      message: `Discarded your changes to ${name}.yml`,
      icon: "trash",
      action: { text: "Undo", icon: "undo", onClick: () => updateDoc(name, { draft }) },
    });
  };

  // Ctrl/Cmd+S saves
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    const onKeyDown = e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault(); // the browser's "Save page as..."
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const onChange = value => {
    if (!file || doc?.status !== "ready") return;
    updateDoc(file.name, { draft: value ?? "" });
  };

  const addBatch = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    setReviewing(false);
    const name = unusedBatchName(analysis.items);
    const text = model.getValue();
    const snippet = newBatchSnippet(text, name);
    const last_line = model.getLineCount();
    const last_column = model.getLineMaxColumn(last_line);
    // as an edit, so that it can be undone
    editor.executeEdits("new-batch", [{
      range: { startLineNumber: last_line, startColumn: last_column, endLineNumber: last_line, endColumn: last_column },
      text: snippet,
    }]);
    const line = model.getLineCount() - 3;
    editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 + name.length });
    editor.revealLineInCenter(line);
    editor.focus();
  };

  const openPreview = batch => setPreview(p => ({ isOpen: true, batch, id: p.id + 1 }));

  const run = batch => {
    dispatch(updateTuningForm(project, { selected_group: batch }));
    dispatch(updateSelected(project, { selected_views: "tuning" }));
  };

  if (files.length === 0)
    return <NonIdealState icon="lock" title="Log in to edit batches" />;

  // Where batches come from
  let commit_files = config?.inputs?.batches ?? config?.inputs?.groups ?? []; // .groups for backward compat
  if (!Array.isArray(commit_files)) commit_files = [commit_files];
  // we allow python-syntax formatting with project/subproject
  const project_repo = git?.path_with_namespace ?? "";
  const subproject = project.slice(project_repo.length + 1);
  commit_files = commit_files.map(f => {
    const subproject_parts = subproject.split("/");
    const project_parts = project.split("/");
    // FIXME: call utils.fill_template, with a twist to replace "\${key}" with ${key},
    //        but not trivial since those are to be interpreted as python Pathlib...
    return f.replace("{project.name}", project_parts[project_parts.length - 1])
            .replace("{subproject.parts[0]}", subproject_parts[0])
            .replace("{subproject}", subproject);
  });
  const database = config?.inputs?.database;
  const database_path = database?.windows ?? database?.linux ?? (typeof database === "string" ? database : null);

  const outline_filter = outlineFilter.trim().toLowerCase();
  const outline = analysis.items.filter(i => !outline_filter || i.name.toLowerCase().includes(outline_filter));
  const nb_batches = analysis.items.filter(i => i.kind !== "setting").length;
  const ready = doc?.status === "ready";

  let status;
  if (!doc || doc.status === "loading")
    status = <Status className={Classes.TEXT_MUTED}><Spinner size={14} /> Loading…</Status>;
  else if (doc.status === "error")
    status = <Status><Icon icon="error" intent={Intent.DANGER} /> Could not load</Status>;
  else if (doc.saving)
    status = <Status className={Classes.TEXT_MUTED}><Spinner size={14} /> Saving…</Status>;
  else if (doc.saveError)
    status = <Tooltip content={doc.saveError}><Status><Icon icon="error" intent={Intent.DANGER} /> Not saved</Status></Tooltip>;
  else if (dirty)
    status = <Status><Icon icon="dot" color="#c87619" /> Unsaved changes</Status>;
  else if (doc.savedAt)
    status = <Status className={Classes.TEXT_MUTED}><Icon icon="tick-circle" intent={Intent.SUCCESS} /> Saved {relative(doc.savedAt)}</Status>;
  else
    status = <Status className={Classes.TEXT_MUTED}><Icon icon="tick" /> No changes</Status>;

  return <>
    <Toolbar>
      <Tabs id="batches-files" selectedTabId={file.id} onChange={id => { setSelected(id); setReviewing(false); setOutlineFilter(""); }}>
        {files.map(f => {
          const d = docs[f.name];
          const f_dirty = d?.status === "ready" && d.draft !== d.base;
          return <Tab
            key={f.id}
            id={f.id}
            icon={f.icon}
            title={<Tooltip content={<span><code>{f.name}.yml</code>. {f.help}</span>} placement="bottom">
              <span>{f.label}{f_dirty && <DirtyDot aria-label="unsaved changes" title="Unsaved changes" />}</span>
            </Tooltip>}
          />;
        })}
      </Tabs>
      <Spacer />
      {ready && (errors.length > 0 || warnings.length > 0) && <ButtonGroup variant="minimal">
        {errors.length > 0 && <Button size="small" icon="error" intent={Intent.DANGER} text={`${errors.length} error${errors.length === 1 ? "" : "s"}`} onClick={() => goToLine(errors[0].line, errors[0].column)} />}
        {warnings.length > 0 && <Button size="small" icon="warning-sign" intent={Intent.WARNING} text={`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`} onClick={() => goToLine(warnings[0].line, warnings[0].column)} />}
      </ButtonGroup>}
      <span aria-live="polite">{status}</span>
      {dirty && <>
        <Button
          variant="minimal"
          icon={reviewing ? "edit" : "changes"}
          text={reviewing ? "Back to editing" : "Review changes"}
          onClick={() => setReviewing(!reviewing)}
        />
        <Button variant="minimal" icon="undo" text="Discard" onClick={() => setConfirmDiscard(true)} />
      </>}
      <Tooltip content={<span>Save <Tag minimal>{SAVE_SHORTCUT}</Tag></span>} placement="bottom" disabled={!dirty}>
        <Button
          intent={Intent.PRIMARY}
          icon="floppy-disk"
          text="Save"
          disabled={!dirty}
          loading={!!doc?.saving}
          onClick={save}
        />
      </Tooltip>
    </Toolbar>

    <Layout>
      <div>
        {doc?.restoredAt && dirty && <Callout intent={doc.serverChanged ? Intent.WARNING : Intent.PRIMARY} icon="history" style={{ marginBottom: 8 }}>
          Restored the changes you didn't save, from {relative(doc.restoredAt)}.
          {doc.serverChanged && " Someone saved this file since: review the changes before saving."}{" "}
          <ButtonGroup variant="minimal" style={{ marginLeft: 4 }}>
            <Button size="small" intent={Intent.PRIMARY} icon="changes" text="Review" onClick={() => setReviewing(true)} />
            <Button size="small" intent={Intent.PRIMARY} icon="undo" text="Discard" onClick={() => setConfirmDiscard(true)} />
          </ButtonGroup>
        </Callout>}
        {doc?.saveError && <Callout intent={Intent.DANGER} title={`Could not save ${file.name}.yml`} icon="error" style={{ marginBottom: 8 }}>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{doc.saveError}</pre>
        </Callout>}
        {doc?.status === "error"
          ? <NonIdealState
              icon="error"
              title={`Could not load ${file.name}.yml`}
              description={doc.loadError}
              action={<Button icon="refresh" text="Retry" onClick={() => load(file.name)} />}
            />
          : <EditorFrame>
              {/* Each file has its own model (path): switching tabs keeps the undo history and the cursor */}
              <div style={{ display: reviewing ? "none" : undefined }}>
                {ready
                  ? <MonacoEditor
                      height={editor_height}
                      language="yaml"
                      path={`${file.name}.yml`}
                      options={editor_options}
                      value={doc.draft}
                      onChange={onChange}
                      editorDidMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; }}
                    />
                  : <div style={{ height: editor_height, display: "flex", alignItems: "center", justifyContent: "center" }}><Spinner /></div>}
              </div>
              {reviewing && ready && <MonacoDiffEditor
                height={editor_height}
                language="yaml"
                original={doc.base}
                value={doc.draft}
                options={diff_options}
              />}
              {ready && analysis.problems.length > 0 && !reviewing && <Problems aria-label="Problems">
                {analysis.problems.slice(0, 20).map((p, idx) => <li key={idx}><ProblemButton type="button" onClick={() => goToLine(p.line, p.column)}>
                  <Icon icon={p.severity === "error" ? "error" : "warning-sign"} intent={p.severity === "error" ? Intent.DANGER : Intent.WARNING} size={12} />
                  <span className={Classes.TEXT_MUTED}>Line {p.line}</span>
                  <span>{p.message}</span>
                </ProblemButton></li>)}
              </Problems>}
            </EditorFrame>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Section
          compact
          icon="properties"
          title="Batches"
          subtitle={ready ? `${nb_batches} in ${file.name}.yml` : undefined}
          rightElement={<Tooltip content="Add a batch from an example" placement="top">
            <Button size="small" variant="minimal" icon="add" text="New" aria-label="New batch" disabled={!ready} onClick={addBatch} />
          </Tooltip>}
        >
          <SectionCard padded={false}>
            {analysis.items.length > 8 && <div style={{ padding: "8px 8px 4px" }}>
              <InputGroup size="small" leftIcon="filter" placeholder="Filter batches" value={outlineFilter} onValueChange={setOutlineFilter} />
            </div>}
            {ready && analysis.items.length === 0
              ? <div style={{ padding: 12 }} className={Classes.TEXT_MUTED}>
                  No batches yet. Click <strong>New</strong> to start from an example.
                </div>
              : <OutlineList aria-label="Batches">
                {outline.map((item, idx) => <OutlineRow key={`${item.kind}-${item.name}-${idx}`}>
                  <button
                    type="button"
                    className={`goto ${item.overridden_by ? `overridden ${Classes.TEXT_MUTED}` : ""}`}
                    onClick={() => goToLine(item.line)}
                    title={`${item.name}: ${item_meta(item) || item.kind}. Go to line ${item.line}`}
                  >
                    <Icon
                      icon={item.kind === "alias" ? "link" : item.kind === "setting" ? "cog" : item.kind === "pipeline" ? "flow-linear" : "th-list"}
                      size={12}
                      className={Classes.TEXT_MUTED}
                    />
                    <span className={`name ${item.kind === "setting" ? Classes.TEXT_MUTED : ""}`}>{item.name}</span>
                    <span className={`meta ${Classes.TEXT_MUTED}`}>{item_meta(item)}</span>
                  </button>
                  {item.kind !== "setting" && <span className="actions">
                    <Tooltip content="List its tests" placement="top">
                      <Button size="small" variant="minimal" icon="eye-open" aria-label={`List the tests in ${item.name}`} onClick={() => openPreview(item.name)} />
                    </Tooltip>
                    <Tooltip content="Run it on this commit…" placement="top">
                      <Button size="small" variant="minimal" icon="play" aria-label={`Run ${item.name}`} onClick={() => run(item.name)} />
                    </Tooltip>
                  </span>}
                </OutlineRow>)}
              </OutlineList>}
          </SectionCard>
          <SectionCard>
            <Button fill size="small" alignText="left" icon="search" text="Check any batch or pattern…" onClick={() => openPreview("")} />
          </SectionCard>
        </Section>

        <Section compact icon="layers" title="Where batches come from" collapsible collapseProps={{ defaultIsOpen: true }}>
          <SectionCard>
            <ol className={Classes.LIST} style={{ marginTop: 0, paddingLeft: 20 }}>
              {files.map(f => <li key={f.id}>
                <Icon icon={f.icon} size={12} /> <strong>{f.label}</strong>{" "}
                <code>{f.name}.yml</code>. <span className={Classes.TEXT_MUTED}>{f.help}</span>
              </li>)}
              <li>
                <strong>This commit</strong>{commit_files.length === 0 && <span className={Classes.TEXT_MUTED}>: no <code>inputs.batches</code> in qaboard.yaml</span>}
                {commit_files.length > 0 && <ul style={{ paddingLeft: 16 }}>
                  {commit_files.map(f => <li key={f}>
                    {git?.web_url && commit?.id
                      ? <a href={`${git.web_url}/tree/${commit.id}/${f}`} target="_blank" rel="noopener noreferrer">{f}</a>
                      : <code>{f}</code>}
                  </li>)}
                </ul>}
              </li>
            </ol>
            <p className={Classes.TEXT_MUTED} style={{ marginBottom: 0 }}>
              When a batch is defined in several places, the first one in this list wins.
            </p>
          </SectionCard>
          {database_path && <SectionCard>
            <div className={Classes.TEXT_MUTED} style={{ marginBottom: 4 }}>Relative input paths start from</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <code style={{ wordBreak: "break-all" }}>{database_path}</code>
              <CopyToClipboard text={database_path} onCopy={() => toaster.show({ message: "Copied!", intent: Intent.SUCCESS, timeout: 1500 })}>
                <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the path" />
              </CopyToClipboard>
            </div>
          </SectionCard>}
          <SectionCard>
            <a href={`${docs_root ?? ""}docs/batches-running-on-multiple-inputs`} target="_blank" rel="noopener noreferrer">
              <Icon icon="manual" size={12} /> Syntax of batch files
            </a>
          </SectionCard>
        </Section>
      </div>
    </Layout>

    <Drawer
      isOpen={preview.isOpen}
      onClose={() => setPreview(p => ({ ...p, isOpen: false }))}
      size={640}
      icon="list-detail-view"
      title="Which tests run?"
    >
      <BatchPreview
        key={preview.id}
        project={project}
        commit={commit}
        file_names={file_names}
        batch={preview.batch}
        onRun={batch => { setPreview(p => ({ ...p, isOpen: false })); run(batch); }}
        unsaved={dirty_files.map(f => f.label)}
      />
    </Drawer>

    <Alert
      isOpen={confirmDiscard}
      icon="undo"
      intent={Intent.DANGER}
      cancelButtonText="Keep editing"
      confirmButtonText="Discard changes"
      onCancel={() => setConfirmDiscard(false)}
      onConfirm={() => { setConfirmDiscard(false); discard(); }}
    >
      <p>Discard your unsaved changes to <code>{file.name}.yml</code>?</p>
    </Alert>

    <Dialog
      isOpen={!!conflict}
      onClose={() => setConflict(null)}
      title={`${conflict?.label ?? ""} batches changed since you started editing`}
      icon="warning-sign"
      style={{ width: "min(1100px, 90vw)" }}
    >
      {conflict && <>
        <DialogBody>
          <p>Someone saved <code>{conflict.name}.yml</code> after you opened it. Left: the saved file. Right: your version.</p>
          <EditorFrame>
            <MonacoDiffEditor height="50vh" language="yaml" original={conflict.server} value={docs[conflict.name]?.draft ?? ""} options={diff_options} />
          </EditorFrame>
        </DialogBody>
        <DialogFooter actions={<>
          <Button text="Keep editing" onClick={() => {
            // what's saved is now the reference: "Review changes" shows the differences
            updateDoc(conflict.name, { base: conflict.server, serverChanged: false });
            setConflict(null);
          }} />
          <Button text="Use the saved file" icon="import" onClick={() => {
            const { draft } = docs[conflict.name] ?? {};
            updateDoc(conflict.name, { base: conflict.server, draft: conflict.server, restoredAt: null, serverChanged: false });
            toaster.show({
              message: `Loaded the saved ${conflict.name}.yml`,
              action: { text: "Undo", icon: "undo", onClick: () => updateDoc(conflict.name, { draft }) },
            });
            setConflict(null);
          }} />
          <Button intent={Intent.DANGER} icon="floppy-disk" text="Overwrite with mine" onClick={() => {
            const { name } = conflict;
            setConflict(null);
            write(name, docs[name]?.draft ?? "");
          }} />
        </>}>
          <span className={Classes.TEXT_MUTED}>Tip: copy what you need from the left before choosing.</span>
        </DialogFooter>
      </>}
    </Dialog>
  </>;
}
