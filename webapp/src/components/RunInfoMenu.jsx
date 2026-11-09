// What we know about a run, as menu items: where its input is, who ran it, how long it took... and a link to the
// input's History. The same everywhere: hovering runs' names (see RunName), and in their menus (see RunMenuButton),
// in the run cards, the logs and the tables.
import { Classes, MenuDivider, MenuItem } from "@blueprintjs/core";
import { DateTime } from 'luxon';

import { SubmittedByMenuItem } from './SubmittedBy'
import { humanFileSize, humanElapsedTime } from "../viewers/bit_accuracy/utils";
import { history } from "../router"
import { date_range_from_query, parse_query, path_segment, stringify_query } from "../selection";
import { linux_to_windows } from '../utils'
import { hasPathMappings } from '../utils/paths'
import { copyWithToast } from "../utils/clipboard"
import { usePrefsStore, useRunNameOrigin } from "../stores/prefs"


const on_copy = text => () => copyWithToast(text, {
  message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
})

// History shows the last 3 days by default: for older commits, it starts 3 days before the commit, to show it
// and the commits before it
const history_from = (commit, query) => {
  const date = DateTime.fromISO(commit?.authored_datetime ?? '', { zone: 'utc' }).toLocal().minus({ days: 3 }).startOf('day');
  if (!date.isValid) return query.from;
  const [from] = date_range_from_query(query);
  return date.toJSDate() < from ? date.toISODate() : query.from;
};

// The results of this input over time, filtered to show only this input
export const history_location = (project, commit, output, type, search) => {
  // https://stackoverflow.com/a/6969486
  const filter = output.test_input_path?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const query = parse_query(search);
  return {
    pathname: `/${path_segment(project)}/history/${path_segment(commit?.branch ?? '')}`,
    search: stringify_query({
      ...query,
      from: history_from(commit, query),
      filter,
      filter_ref: filter,
      show_bit_accuracy: type === 'bit_accuracy',
    }),
  };
}

// The run's input over time, on the History page
export const RunHistoryMenuItem = ({ project, commit, output, type }) => {
  const location = history_location(project, commit, output, type, window.location.search);
  const go = e => {
    // let the browser open new tabs/windows
    if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    // the URL may have changed since we rendered
    history.push(history_location(project, commit, output, type, window.location.search));
  };
  return <MenuItem
    icon="history"
    text="History"
    label="this input over time"
    href={`${location.pathname}${location.search ? `?${location.search.replace(/^\?/, '')}` : ''}`}
    htmlTitle="See this input's results over time"
    onClick={go}
  />;
};

// How long the run took, e.g. "2min3s"
export const runTime = output => output?.metrics?.compute_time !== undefined && output?.metrics?.compute_time !== null
  ? humanElapsedTime(output.metrics.compute_time)
  : null;

// Whether runs' names start with their batch and database: chosen where users see them, also in Settings and the View options
export const run_name_origin_options = [
  { value: 'auto', label: 'When runs differ', description: 'when the runs shown come from several batches or databases. If they all have the same input, only those' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];
export const RunNameOriginMenuItem = () => {
  const origin = useRunNameOrigin();
  const setOrigin = usePrefsStore(state => state.setRunNameOrigin);
  return <MenuItem icon="label" text="Batch & database in names" label={run_name_origin_options.find(o => o.value === origin)?.label}>
    {run_name_origin_options.map(option => <MenuItem
      key={option.value}
      roleStructure="listoption"
      selected={origin === option.value}
      text={option.label}
      htmlTitle={option.description}
      onClick={() => setOrigin(option.value)}
    />)}
  </MenuItem>;
};

export const RunInfoMenuItems = ({ project, commit, output, type, history: with_history = true }) => {
  const has_metadata = !!output.test_input_metadata && (Object.keys(output.test_input_metadata).length > 0)
  const has_label = has_metadata && !!output.test_input_metadata.label
  const runtime = runTime(output);
  return <>
    {with_history && !!output.test_input_path && !!commit?.branch && <RunHistoryMenuItem project={project} commit={commit} output={output} type={type} />}
    {!!output.data?.batch && <>
      <MenuDivider key={"Batch"} title="Batch" />
      <MenuItem key="batch" text={output.data.batch} icon="group-objects" onClick={on_copy(output.data.batch)} />
    </>}
    {!!output.test_input_database && <>
      <MenuDivider key={"Database"} title="Database" />
      <MenuItem key="database-linux" text={output.test_input_database} icon="duplicate" onClick={on_copy(output.test_input_database)} />
      {hasPathMappings() && <MenuItem key="database-windows" text={linux_to_windows(output.test_input_database)} icon="duplicate" onClick={on_copy(linux_to_windows(output.test_input_database))} />}
    </>}
    {!!output.test_input_path && <>
      <MenuDivider key={"Input path"} title="Input path" />
      <MenuItem key="input-linux" text={output.test_input_path} icon="duplicate" onClick={on_copy(output.test_input_path)} />
    </>}
    {has_metadata && <>
      <MenuDivider key={"Properties"} title="Properties" />
      { has_label && <MenuItem text={output.test_input_path} icon="document" />}
      <MenuItem key="metadata" text="Metadata" icon="info-sign">
        <pre>{JSON.stringify(output.test_input_metadata, null, 2)}</pre>
      </MenuItem>
    </>}
    <MenuDivider key={"Output-Info"} title="Run Info" />
    <SubmittedByMenuItem key="user" data={output.data} />
    {!!runtime && <MenuItem key="compute-time" text={runtime} label="compute time" icon="stopwatch" />}
    {!!output.created_date && <MenuItem
      key="created-date"
      text={<span title={output.created_date}> {DateTime.fromISO(output.created_date, { zone: 'utc' }).toRelative()}</span>}
      label="created"
      icon="calendar"
    />}
    {!!output?.data?.storage && <MenuItem key="storage" text={humanFileSize(output.data.storage, true)} label="storage" icon="folder-close" />}
    {(!!output.data?.batch || (!!output.test_input_database && output.test_input_database !== '/')) && <>
      <MenuDivider key="display" title="Display" />
      <RunNameOriginMenuItem />
    </>}
  </>;
};
