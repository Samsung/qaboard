// What the server used to list the tests in a batch (POST /api/v1/tests/group):
// what may be wrong, where the batch is defined, and the batch files it read
import React from "react";
import styled from "styled-components";
import { Callout, Classes, Colors, Icon, Intent, Tooltip } from "@blueprintjs/core";


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


// Where a batch file comes from, from the source the server gives ("commit" or "qaboard").
// Submissions recorded before the server gave it are guessed from the names of QA-Board's files.
const guessSource = (path, context) => {
  const names = [context.shared, context.user, context.owner].filter(Boolean).map(name => `${name}.yml`);
  return names.includes(path) ? "qaboard" : "commit";
};

// Paths from qaboard.yaml can be absolute: those are not in the repository
const in_repository = path => !!path && !/^([/\\~]|[a-zA-Z]:)/.test(path) && !path.split("/").includes("..");

/**
 * The files that define batches, from [{name, files, sources?}] (QA-Board's API), in the order `qa batch` reads them.
 * Returns [{path, source, batches: the batches the file defines, wins: those defined in earlier files too}].
 * When several files define a batch, like for `qa batch`, the last one wins.
 */
export const definitionsFiles = (definitions, context = {}) => {
  const files = new Map();
  for (const definition of definitions ?? []) {
    const paths = definition.files ?? [];
    paths.forEach((path, idx) => {
      const source = definition.sources?.[idx] ?? guessSource(path, context);
      const key = `${source}:${path}`;
      if (!files.has(key)) files.set(key, { path, source, batches: [], wins: [] });
      const file = files.get(key);
      if (!file.batches.includes(definition.name)) file.batches.push(definition.name);
      if (paths.length > 1 && idx === paths.length - 1 && !file.wins.includes(definition.name)) file.wins.push(definition.name);
    });
  }
  return [...files.values()];
};

/**
 * How to show a batch file, and where it links to.
 * `context`: {shared: the name of the shared file, user: the user's name (their private file), owner: who started the
 * batch (their private file), repoFileUrl: path => its page on the git server at the commit, onOpen: ({file, batch}) => shows
 * one of QA-Board's files}
 */
export const batchFileInfo = (file, context = {}) => {
  if (file.source === "qaboard") {
    const name = file.path.replace(/\.ya?ml$/, "");
    const open = context.onOpen ? () => context.onOpen({ file: name, batch: file.batches?.[0] }) : undefined;
    if (name === context.shared)
      return { icon: "people", label: "Shared batches", short: "the shared batches", hint: "Open in Available Tests", onClick: open };
    if (name === context.user)
      return { icon: "lock", label: "Your private batches", short: "your private batches", hint: "Open in Available Tests", onClick: open };
    return { icon: "lock", label: `${name}'s private batches`, short: `${name}'s private batches`, hint: `Only ${name} can see this file.` };
  }
  const href = in_repository(file.path) ? context.repoFileUrl?.(file.path) : undefined;
  return { icon: "document", label: file.path, short: file.path, code: true, hint: href ? "Open in the repository, at this commit" : undefined, href };
};

const Chip = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 20px;
  padding: 0 6px;
  border: 0;
  border-radius: 2px;
  background: rgba(143, 153, 168, 0.15);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  vertical-align: middle;
  text-decoration: none;
  cursor: ${props => props.as === "span" ? "default" : "pointer"};
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label.code {
    font-family: var(--bp-typography-family-mono, monospace);
  }
  .${Classes.ICON} {
    flex: none;
    color: ${Colors.GRAY1};
  }
  .${Classes.DARK} & .${Classes.ICON} {
    color: ${Colors.GRAY4};
  }
  /* not the color of links: they look like the other files */
  &&, &&:hover {
    color: inherit;
    text-decoration: none;
  }
  &[href]:hover, &:is(button):hover {
    background: rgba(143, 153, 168, 0.3);
  }
  &:focus-visible {
    outline: 2px solid rgba(45, 114, 210, 0.6);
    outline-offset: 1px;
  }
`;

const Sources = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: 13px;
`;

/**
 * A batch file: a link to it in the repository, or in Available Tests.
 */
export function BatchFileChip({ file, context, list = false }) {
  const info = batchFileInfo(file, context);
  const batches = file.batches ?? [];
  const tooltip = <div style={{ maxWidth: 360 }}>
    {info.code ? <code>{file.path}</code> : <span><strong>{info.label}</strong> <span className={Classes.TEXT_MUTED}>({file.path})</span></span>}
    {list && batches.length > 0 && <div style={{ marginTop: 4 }}>
      Defines {listed(batches)}.
    </div>}
    {info.hint && <div className={Classes.TEXT_MUTED} style={{ marginTop: 4 }}>{info.hint}</div>}
  </div>;
  const content = <>
    <Icon icon={info.icon} size={12} />
    <span className={`label${info.code ? " code" : ""}`}>{info.label}</span>
    {info.href && <Icon icon="share" size={10} />}
  </>;
  const props = info.href
    ? { href: info.href, target: "_blank", rel: "noopener noreferrer" }
    : info.onClick ? { as: "button", type: "button", onClick: info.onClick } : { as: "span" };
  return <Tooltip content={tooltip} placement="top" hoverOpenDelay={300} compact>
    <Chip {...props} aria-label={info.href || info.onClick ? `${info.label}. ${info.hint}` : undefined}>{content}</Chip>
  </Tooltip>;
}

// a, b, c and 4 more
const listed = (names, max = 4) => {
  const shown = names.slice(0, names.length > max + 1 ? max : names.length).map(name => <code key={name}>{name}</code>);
  const rest = names.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  return parts.map((part, idx) => <React.Fragment key={idx}>
    {idx > 0 && (idx === parts.length - 1 ? " and " : ", ")}{part}
  </React.Fragment>);
};

/**
 * Where the batch is defined, or the batches its alias or pattern stands for: "Defined in qa/batches.yaml".
 * Batches are often split into many batches, usually all in one file: we list the files, not the batches.
 * When several files define a batch, like for `qa batch`, the last one wins: we say which.
 * `context`: links to the files, see batchFileInfo.
 */
export function BatchDefinitions({ definitions, context = {}, style }) {
  const files = definitionsFiles(definitions, context);
  if (!files.length) return null;
  const several = files.length > 1;
  const overriding = files.filter(f => f.wins.length > 0);
  return <Sources style={style} aria-label="Where the batch is defined">
    {/* the spaces are for screen readers and copies: the layout spaces the items */}
    <span className={Classes.TEXT_MUTED}>Defined in</span>{" "}
    {files.map((file, idx) => <React.Fragment key={`${file.source}:${file.path}`}>
      {idx > 0 && idx === files.length - 1 && <><span className={Classes.TEXT_MUTED}>and</span>{" "}</>}
      <span style={{ display: "inline-flex", alignItems: "baseline", maxWidth: "100%" }}>
        <BatchFileChip file={file} context={context} list={several} />
        {idx < files.length - 2 && <span className={Classes.TEXT_MUTED}>,</span>}
      </span>{" "}
    </React.Fragment>)}
    {overriding.map(file => {
      const info = batchFileInfo(file, context);
      return <Tooltip
        key={`${file.source}:${file.path}`}
        compact
        placement="top"
        content={<div style={{ maxWidth: 360 }}>Defined in several files: like for <code>qa batch</code>, the last one wins.</div>}
      >
        <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, borderBottom: "1px dotted currentColor", cursor: "help" }}>
          <Icon icon="layers" size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
          {info.code ? <code>{file.path}</code> : info.short} override{info.code ? "s" : ""} {listed(file.wins, 2)}
        </span>
      </Tooltip>;
    })}
  </Sources>;
}


/**
 * The batch files the server read, in order: when several define a batch, the last one wins.
 * `labels` names QA-Board's own files, e.g. {"extra-batches.yml": "Shared"}. `repoFileUrl` links the commit's files to the git server.
 */
export function BatchFiles({ files, labels = {}, repoFileUrl }) {
  if (!files?.length) return null;
  return <ol aria-label="Batch files" style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
    {files.map((f, idx) => {
      const status = file_status[f.status] ?? file_status.invalid;
      return <li key={idx} style={{ marginBottom: 4, wordBreak: "break-word" }}>
        <Icon icon={status.icon} intent={status.intent} size={12} style={{ marginRight: 4 }} />
        {f.source === "commit" && f.status !== "missing" && in_repository(f.path) && repoFileUrl
          ? <a href={repoFileUrl(f.path)} target="_blank" rel="noopener noreferrer" title="Open in the repository, at this commit"><code>{f.path}</code></a>
          : <code title={f.location ?? undefined}>{f.path}</code>}
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
