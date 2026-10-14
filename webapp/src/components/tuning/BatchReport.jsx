// What the server used to list the tests in a batch (POST /api/v1/tests/group):
// what may be wrong, where the batch is defined, and the batch files it read
import React from "react";
import { Callout, Classes, Colors, Icon, Intent } from "@blueprintjs/core";


// `qa save-artifacts` => <code>qa save-artifacts</code>
const withCode = text => String(text).split(/`([^`]+)`/).map((part, idx) => idx % 2 ? <code key={idx}>{part}</code> : part);

const file_status = {
  ok: { icon: "tick", intent: Intent.SUCCESS, text: ({ batches }) => batches === undefined ? "read" : `${batches} batch${batches === 1 ? "" : "es"}` },
  empty: { icon: "minus", intent: Intent.NONE, text: () => "empty" },
  missing: { icon: "error", intent: Intent.DANGER, text: ({ source }) => source === "commit" ? "not in the commit's artifacts" : "not found" },
  invalid: { icon: "error", intent: Intent.DANGER, text: ({ error }) => error ?? "could not be read" },
};


/**
 * What the server says may be wrong with the batch files, or why a batch has no tests.
 */
export function BatchWarnings({ warnings, title, style }) {
  if (!warnings?.length) return null;
  return <Callout intent={Intent.WARNING} icon="warning-sign" title={title} style={style}>
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {warnings.map((warning, idx) => <li key={idx} style={{ wordBreak: "break-word", marginBottom: 2 }}>{withCode(warning)}</li>)}
    </ul>
  </Callout>;
}


/**
 * Where the batch (or the batches its alias or pattern stands for) is defined.
 */
export function BatchDefinitions({ definitions, style }) {
  if (!definitions?.length) return null;
  const shown = definitions.slice(0, 5);
  return <p className={Classes.TEXT_MUTED} style={style}>
    {shown.map((d, idx) => <React.Fragment key={idx}>
      {idx > 0 && "; "}<code>{d.name}</code> is defined in <code>{d.file}</code>
    </React.Fragment>)}
    {definitions.length > shown.length && `, and ${definitions.length - shown.length} more`}.
  </p>;
}


/**
 * The batch files the server read, in order: when several define a batch, the last one wins.
 * `labels` names QA-Board's own files, e.g. {"extra-batches.yml": "Shared"}.
 */
export function BatchFiles({ files, labels = {} }) {
  if (!files?.length) return null;
  return <ol aria-label="Batch files" style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
    {files.map((f, idx) => {
      const status = file_status[f.status] ?? file_status.invalid;
      return <li key={idx} style={{ marginBottom: 4, wordBreak: "break-word" }}>
        <Icon icon={status.icon} intent={status.intent} size={12} style={{ marginRight: 4 }} />
        <code title={f.location ?? undefined}>{f.path}</code>
        {labels[f.path] && <span className={Classes.TEXT_MUTED}> ({labels[f.path]})</span>}
        {": "}
        {status.intent === Intent.DANGER
          ? <span style={{ color: Colors.RED3 }}>{status.text(f)}</span>
          : <span className={Classes.TEXT_MUTED}>{status.text(f)}</span>}
        {f.status === "missing" && f.location && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
          Looked for <code>{f.location}</code>
        </div>}
      </li>;
    })}
  </ol>;
}
