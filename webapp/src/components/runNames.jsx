// Runs' names, the same in the run cards, the logs and the tables: their input, or the label of its metadata.
// Batches often run several batches of qaboard.yaml at once (`qa batch a b`): the same image can be an input of several,
// configured differently. When the runs shown come from several batches or databases, their names start with them.
// Users choose it: "auto" (then), "always" or "never" (useRunNameOrigin), from the runs' menus, the View options or Settings.
// In "auto", when all the runs shown have the same input, names show only what differs: their batch or database.
// Hover a run's name for what we know about it: the same menu everywhere (RunInfoMenuItems).
import { createContext, useContext, useMemo } from "react";
import { Classes, Menu } from "@blueprintjs/core";

import { useRunNameOrigin } from "../stores/prefs";
import { LazyHoverPopover } from "./LazyPopover";
import { RunInfoMenuItems } from "./RunInfoMenu";
import { runName } from "./tags";


const is_pipeline = output => output.output_type === "pipeline" || output.test_input_path === "PIPELINE";
// batches' own outputs and pipelines are named after their batch already
const has_origin = output => !!output && output.output_type !== "batch" && output.output_type !== "optim_iteration" && !is_pipeline(output);


// The shortest ends of the databases' paths that tell them apart, e.g. /data/a/images and /data/b/images:
// "a/images" and "b/images". `/` is no database: the inputs' paths are absolute.
export const databaseLabels = databases => {
  const paths = [...new Set(databases)].filter(db => !!db && db !== '/');
  const parts = new Map(paths.map(db => [db, db.replace(/\/+$/, '').split('/').filter(Boolean)]));
  const labels = new Map();
  for (const db of paths) {
    const segments = parts.get(db);
    let n = 1;
    const label = n => segments.slice(-n).join('/');
    while (n < segments.length && paths.some(other => other !== db && parts.get(other).slice(-n).join('/') === label(n)))
      n += 1;
    labels.set(db, label(n) || db);
  }
  return labels;
};


// Where the runs come from: their batches and databases, sorted, and whether they all have the same input
export const runOrigins = outputs => {
  const batches = new Set();
  const databases = new Set();
  const inputs = new Set();
  for (const output of outputs) {
    if (!has_origin(output)) continue;
    if (output.data?.batch) batches.add(output.data.batch);
    if (output.test_input_database && output.test_input_database !== '/') databases.add(output.test_input_database);
    inputs.add(runName(output));
  }
  return { batches: [...batches].sort(), databases: [...databases].sort(), same_input: inputs.size === 1 && outputs.length > 1 };
};

// The runs shown on the page, provided by the commit page. Elsewhere, e.g. in History, runs come from one batch:
// "auto" shows nothing.
export const RunOriginsContext = createContext(null);

// The context's value for these runs. It changes only when their batches or databases change: names don't render again
// when runs are filtered or updated.
export const useRunOriginsValue = outputs => {
  const origins = runOrigins(outputs);
  const key = JSON.stringify(origins);
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ ...origins, database_labels: databaseLabels(origins.databases) }), [key]);
};


// What a run's name starts with: [{ kind: 'batch' | 'database', text, title }]
// mode: "auto" (only what differs between the runs shown), "always" or "never"
export const runOriginParts = (output, origins, mode = 'auto') => {
  if (mode === 'never' || !has_origin(output)) return [];
  const parts = [];
  const batch = output.data?.batch;
  if (batch && (mode === 'always' || (origins?.batches.length ?? 0) > 1))
    parts.push({ kind: 'batch', text: batch, title: `Batch: ${batch}` });
  const database = output.test_input_database;
  if (database && database !== '/' && (mode === 'always' || (origins?.databases.length ?? 0) > 1)) {
    const text = origins?.database_labels?.get(database) ?? databaseLabels([database]).get(database);
    parts.push({ kind: 'database', text, title: `Database: ${database}` });
  }
  return parts;
};

// What a run's name shows: { parts, input }. In "auto", when all the runs shown have the same input and differ by their
// batch or database, the input says nothing: we show only what differs, e.g. "night" and "day".
export const runNameShown = (output, origins, mode = 'auto') => {
  const parts = runOriginParts(output, origins, mode);
  const input = !(mode === 'auto' && origins?.same_input && parts.length > 0);
  return { parts, input };
};

export const useRunNameShown = output => {
  const origins = useContext(RunOriginsContext);
  const mode = useRunNameOrigin();
  return runNameShown(output, origins, mode);
};

// As text, e.g. "night › kitti › frames/0001.png", or "night" when all runs have this input
export const runLabel = (output, { parts, input = true }) => [...parts.map(part => part.text), ...(input ? [runName(output)] : [])].join(' › ');


/**
 * A run's name, after its batch and database when they help tell runs apart. Hover it for what we know about the run,
 * and its History when `commit` has a branch. With hundreds of runs, the menus are only created on hover.
 * `className`: on the hover target, e.g. to truncate the name with CSS.
 */
export const RunName = ({ output, project, commit, type, className, style, hover = true }) => {
  const { parts, input } = useRunNameShown(output);
  // without the input, the batch or database is the name: not muted. Hovering it shows the input.
  const name = <span className={['run-name', className].filter(Boolean).join(' ')} style={style}>
    {parts.map((part, idx) => <span key={part.kind} className={`run-origin run-origin-${part.kind}${input ? ` ${Classes.TEXT_MUTED}` : ''}`} title={input ? part.title : undefined}>
      {part.text}{(input || idx < parts.length - 1) && <span aria-hidden="true"> › </span>}
    </span>)}
    {input && runName(output)}
  </span>;
  if (!hover) return name;
  return <LazyHoverPopover
    className="run-name-target"
    placement="bottom-start"
    content={<Menu><RunInfoMenuItems project={project} commit={commit} output={output} type={type} /></Menu>}
  >
    {name}
  </LazyHoverPopover>;
};
