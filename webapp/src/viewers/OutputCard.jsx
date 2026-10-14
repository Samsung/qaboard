import { Fragment, memo, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useInView } from 'react-intersection-observer'
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from 'luxon';
import { FullScreen, useFullScreenHandle } from "react-full-screen";

import styled from "styled-components";
import {
  Classes,
  Intent,
  Card,
  Tag,
  Slider,
  HTMLSelect,
  Tooltip,
  Button,
  Popover,
  Menu,
  MenuItem,
  MenuDivider,
  PopoverInteractionKind,
} from "@blueprintjs/core";

import { OutputViewer } from "./OutputViewer";
import { MetricsTags } from "../components/metrics";
import { OutputTags, ExtraParametersTags, StatusTag, RunBadges, style_skeleton } from '../components/tags'
import { humanFileSize, humanElapsedTime } from "./bit_accuracy/utils";

import { Link, history } from "../router"
import { http, errorMessage } from "../api/http";
import { output_files_stale_time, invalidateOutputFiles } from "../api/queries";
import { parse_query, path_segment, stringify_query } from "../selection";
import { linux_to_windows, is_same_data } from '../utils'
import { is_image } from "./images/utils"
import { copyWithToast } from "../utils/clipboard"
import {
  parseVisualizationOptions,
  calculateOptionValues,
  configureOption,
  generateViewPaths,
  resolveOptionValue,
} from "../utils/dynamicOptions"


const on_copy = text => () => copyWithToast(text, {
  message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
})


const manifest_url = (output, { refresh = false } = {}) => (output?.is_running || refresh)
  ? `/api/v1/output/${output?.id}/manifest/${refresh ? '?refresh=true' : ''}`
  : `${output?.output_dir_url}/manifest.outputs.json`;

// The manifest lists all the files created by a run, with their size and hash.
// Many components need it: the cache lets them share it, and new outputs often share the same reference.
const manifestQuery = output => {
  const url = manifest_url(output);
  return queryOptions({
    queryKey: ['manifest', url],
    queryFn: async ({ signal }) => {
      const { data } = await http.get(url, { signal });
      if (typeof data !== 'string') return data;
      // The manifest is sometimes corrupt, e.g. when a running output updates it while it ends.
      // We ask the server to regenerate it.
      const { data: refreshed } = await http.get(manifest_url(output, { refresh: true }), { signal });
      if (typeof refreshed === 'string') throw new Error('Corrupt output manifest.');
      return refreshed;
    },
    enabled: !!output?.output_dir_url,
    // the files of finished outputs don't change
    staleTime: output?.is_running ? 0 : output_files_stale_time,
    refetchInterval: output?.is_running ? 30 * 1000 : false,
  });
};

const empty_manifest = {};
const no_options = {};


// The options in the visualizations' paths (e.g. :frame/output.jpg), and their values in the manifest
const compute_options = (outputs, manifest) => {
  if (!manifest) return { options: {}, parse_errors: [], should_register: false };
  const views = [...(outputs?.visualizations ?? []), ...(outputs?.detailed_views ?? [])];
  const manifest_paths = Object.keys(manifest);
  // We expect files for the visualizations but the manifest is empty: maybe the output is still running.
  // We register empty options for now, and again when the manifest is updated.
  if (manifest_paths.length === 0)
    return { options: {}, parse_errors: [], should_register: views.some(view => view.path) };

  const { options, parseErrors } = parseVisualizationOptions(views);
  const configured = {};
  for (const [name, option] of Object.entries(options)) {
    try {
      const values = calculateOptionValues(option, manifest_paths);
      if (values.length > 0)
        configured[name] = configureOption(option, values);
    } catch (error) {
      console.warn(`Failed to configure option ${name}:`, error);
    }
  }
  return { options: configured, parse_errors: parseErrors, should_register: true };
}


const error_html = error => {
  const data = error.response?.data;
  return typeof data === 'string' && data ? data : errorMessage(error);
}


const SlimCard = styled(Card)`
  overflow: "auto";
`;

const FullScreenableSlimCard = ({ updateFullscreen, className, style, children }) => {
  const handle = useFullScreenHandle();
  return <SlimCard compact className={className} style={style}>
    <div style={{position: "relative"}}>
      <Tag title="Enter Full Screen" style={{position: "absolute", right: "0px", top: "0px"}} icon="fullscreen" interactive minimal onClick={handle.enter}/>
    </div>
    <FullScreen handle={handle} onChange={state => updateFullscreen(state)}>
      {children}
    </FullScreen>
  </SlimCard>
}


// The results of this input over time, filtered to show only this input
const history_location = (project, commit, output, type, search) => {
  // https://stackoverflow.com/a/6969486
  const filter = output.test_input_path?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    pathname: `/${path_segment(project)}/history/${path_segment(commit?.branch ?? '')}`,
    search: stringify_query({
      ...parse_query(search),
      filter,
      filter_ref: filter,
      show_bit_accuracy: type === 'bit_accuracy',
    }),
  };
}

const OutputHeader = ({ project, commit, output, output_ref, type, manifests, style, prefix, viewable, tags_first=false }) => {
  const has_metadata = !!output.test_input_metadata && (Object.keys(output.test_input_metadata).length > 0)
  const has_label = has_metadata && !!output.test_input_metadata.label
  const tags = <OutputTags
    output={output}
    project={project}
    output_ref={output_ref}
    mismatch={output.reference_mismatch}
    manifests={manifests}
    commit={commit}
    style={{marginLeft: '5px', marginRight: '5px'}}
  />

  const go_to_history = e => {
    // let the browser open new tabs/windows
    if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    // the URL may have changed since we rendered
    history.push(history_location(project, commit, output, type, window.location.search));
  }

  let run_path = `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
  if (output.output_type === "pipeline" || output.test_input_path === "PIPELINE") {
    run_path = <span>{output.data.batch} <span className={Classes.TEXT_MUTED}>(pipeline)</span></span>
  }
  if (has_label) {
    run_path = output.test_input_metadata.label
  }
  const popover_content = <Menu>
    {!!output.data?.batch && <>
      <MenuDivider key={"Batch"} title="Batch" />
      <MenuItem key="batch" text={output.data.batch} icon="group-objects" onClick={on_copy(output.data.batch)} />
    </>}
    {!!output.test_input_database && <>
      <MenuDivider key={"Database"} title="Database" />
      <MenuItem key="database-linux" text={output.test_input_database} icon="duplicate" onClick={on_copy(output.test_input_database)} />
      <MenuItem key="database-windows" text={linux_to_windows(output.test_input_database)} icon="duplicate" onClick={on_copy(linux_to_windows(output.test_input_database))} />
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
    <MenuDivider key={"Output-Info"} title="Output Info" />
    {!!output?.metrics?.compute_time && <MenuItem key="compute-time" text={humanElapsedTime(output.metrics.compute_time)} icon="stopwatch" />}
    <MenuItem
      key="created-date"
      text={<span title={output.created_date}> {DateTime.fromISO(output.created_date, { zone: 'utc' }).toRelative()}</span>}
      icon="calendar"
    />
    {!!output?.data?.storage && <MenuItem key="storage" text={humanFileSize(output.data.storage, true)} icon="folder-close" />}
  </Menu>
  return <>
    <h5 className={Classes.HEADING} style={style} >
      {prefix}
      {tags_first && viewable && tags}
      {output.output_type !== "batch" && !viewable ?
        <span key="batch-info">{run_path}</span> : <Popover hoverCloseDelay={1000} interactionKind={PopoverInteractionKind.HOVER} content={popover_content}>
        <span key="batch-info">
          <Link
            to={history_location(project, commit, output, type, window.location.search)}
            onClick={go_to_history}
            style={{ color: 'inherit' }}
          >
            {run_path}
          </Link>
        </span>
      </Popover>}
      {!tags_first && viewable && tags}
    </h5>
    <p style={{maxWidth: '600px'}}>
      <RunBadges output={output}></RunBadges>
      <ExtraParametersTags parameters={output.extra_parameters} />
    </p>
  </>
}



const condensed_header_style = {
  fontSize: ".7rem",
  fontWeight: 500,
  letterSpacing: "-1px",
  lineHeight: 1.6,
};

const option_style = {
  marginBottom: '8px',
  padding: '8px',
  backgroundColor: '#f5f8fa',
  borderRadius: '3px',
  border: '1px solid #e1e8ed'
};

const fallback_style = {
  marginBottom: '4px',
  whiteSpace: 'normal',
};

const sync_button_style = {
  minHeight: '16px',
  minWidth: '16px',
  padding: '2px',
  opacity: 0.6,
  transition: 'opacity 0.2s ease-out'
};

const path_header_style = {
  fontSize: '12px',
  color: '#5c7080',
  marginBottom: '8px',
  borderBottom: '1px solid #e1e8ed',
  fontFamily: 'monospace',
  backgroundColor: '#f5f8fa',
  padding: '4px 8px',
  borderRadius: '3px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  transition: 'all 0.2s ease-out'
};


const OutputCard = memo(function OutputCard(props) {
  const {
    project, commit, config, metrics, type, output_new, output_ref, files_filter, no_header,
    show_all_files, hide_runs_without_files, expand_all, color_blind_friendly,
    onRegisterOutputOptions, onToggleDynamicOptionSync,
  } = props;
  const controls = props.controls ?? {};
  const sync_prefs = controls.dynamic_options_sync ?? no_options;
  const synced_values = controls.dynamic_options ?? no_options;

  // We wait until the card comes into view to fetch the output manifest and render the viewers
  const { ref: in_view_ref, inView } = useInView({ triggerOnce: true, rootMargin: '100%', skip: !!props.viewable, fallbackInView: true });
  const viewable = !!props.viewable || inView;
  const [fullscreen, setFullscreen] = useState(false);
  // values selected in this card for the options that are not synced across outputs
  const [local_selected, setLocalSelected] = useState({});
  const [registration_error, setRegistrationError] = useState();

  // When a run that was redone finishes, its files changed
  const queryClient = useQueryClient();
  const was_pending = useRef(output_new?.is_pending);
  useEffect(() => {
    if (was_pending.current && !output_new?.is_pending && output_new?.output_dir_url)
      invalidateOutputFiles(queryClient, output_new.output_dir_url);
    was_pending.current = output_new?.is_pending;
  }, [queryClient, output_new?.is_pending, output_new?.output_dir_url]);

  const has_output_dir = !!output_new?.output_dir_url;
  const query_new = useQuery({ ...manifestQuery(output_new), enabled: viewable && has_output_dir });
  const query_ref = useQuery({ ...manifestQuery(output_ref), enabled: viewable && has_output_dir && !!output_ref?.output_dir_url });
  // like before, outputs whose manifest can't be fetched are shown without files
  const manifest_new = query_new.data ?? (query_new.isError ? empty_manifest : undefined);
  const manifest_ref = query_ref.data ?? (query_ref.isError ? empty_manifest : undefined);
  const manifests = useMemo(() => ({ new: manifest_new, reference: manifest_ref }), [manifest_new, manifest_ref]);

  // Without onRegisterOutputOptions (e.g. on the History page), we don't show options
  const outputs_config = config?.outputs;
  const with_options = !!onRegisterOutputOptions;
  const { options, parse_errors, should_register } = useMemo(
    () => compute_options(outputs_config, with_options ? manifest_new : undefined),
    [outputs_config, manifest_new, with_options],
  );

  // The parent shows controls for the options shared by the outputs
  const register = useEffectEvent((output_id, options, manifest) => {
    if (!onRegisterOutputOptions) return;
    try {
      onRegisterOutputOptions(output_id, options, manifest);
    } catch (error) {
      console.error('Failed to register options for output:', output_id, error);
      setRegistrationError(`Option registration failed: ${error.message}`);
    }
  });
  const output_id = output_new?.id;
  useEffect(() => {
    // it only sets state when the parent fails to register the options
    // oxlint-disable-next-line react/set-state-in-effect
    if (should_register) register(output_id, options, manifest_new);
  }, [should_register, output_id, options, manifest_new]);

  // For each option, the value we show. Options are synced across outputs unless users unlink them,
  // then each card starts from the synced value. Runs may not have the value: we show the closest.
  const shown_options = useMemo(() => {
    const shown = {};
    for (const [name, option] of Object.entries(registration_error ? {} : options)) {
      const synced = sync_prefs[name] !== false;
      const synced_value = [].concat(synced_values[name] ?? [])[0];
      const wanted = synced ? synced_value : (local_selected[name] ?? synced_value);
      shown[name] = { ...option, synced, wanted, ...resolveOptionValue(option, wanted) };
    }
    return shown;
  }, [options, registration_error, sync_prefs, synced_values, local_selected]);
  const selected_options = useMemo(() => Object.fromEntries(
    Object.entries(shown_options).filter(([, option]) => option.value !== undefined).map(([name, option]) => [name, [option.value]])
  ), [shown_options]);

  const setSelectedOption = name => e => {
    let selected = e?.target ? e.target.value : e;
    if (shown_options[name]?.type === 'slider')
      selected = shown_options[name].toRaw[selected];
    setLocalSelected(local_selected => ({ ...local_selected, [name]: selected }));
  }


  if (!output_new || (output_new.is_pending && !output_new.is_running))
    return <span key="loading" />

  const style = {
    ...config?.outputs?.style,
    ...props.style,
  }
  const error = { new: query_new.error, reference: query_ref.error, parse: parse_errors.length > 0 ? parse_errors : undefined, registration: registration_error };

  const views = config?.outputs?.visualizations ?? [];
  const is_shown = view => (!view.default_hidden && controls.show?.[view.name] !== false) || controls.show?.[view.name] === true;

  // we display the input for each option before the first visualization that uses it
  const already_shown_options = new Set();
  const render_view = (view, idx) => {
    if (!is_shown(view))
      return <span key={idx} />

    const view_options = Object.entries(shown_options).filter(([, option]) => option.views?.includes(view.name));
    // inputs for unsynced options, and why we don't show the selected value, come before the first visualization that uses the option
    const new_options = view_options.filter(([name]) => !already_shown_options.has(name));
    new_options.forEach(([name]) => already_shown_options.add(name));

    const options_inputs = new_options.map(([name, option]) => {
      const option_key = `option-${name}`;
      const option_label = isNaN(name) ? name : option.pattern;
      const not_found = !option.exact && option.value !== undefined && <Tag minimal intent={Intent.WARNING} icon="info-sign" style={fallback_style}>
        {option_label} <strong>{option.wanted}</strong> isn't in this run, showing <strong>{option.value}</strong>
      </Tag>;
      if (option.synced || option.values.length === 0)
        return not_found ? <div key={option_key}>{not_found}</div> : <Fragment key={option_key} />;

      return (
        <div key={option_key} style={option_style}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: '500', flex: 1 }}>{option_label}</span>
            {onToggleDynamicOptionSync && (
              <Tooltip content="Link this option: all outputs will use the value from the controls panel">
                <Button icon="link" minimal small onClick={() => onToggleDynamicOptionSync(name)} style={sync_button_style}>
                  unlinked
                </Button>
              </Tooltip>
            )}
          </div>
          {not_found}
          {option.type === 'slider' ? (
            <Slider
              value={parseFloat(option.value)}
              min={option.min}
              max={option.max}
              onChange={setSelectedOption(name)}
              labelStepSize={Math.max(1, Math.pow(10, Math.floor(Math.log10(option.max - option.min))))}
              showTrackFill
            />
          ) : (
            <HTMLSelect
              disabled={option.values.length === 1}
              options={option.values}
              value={option.value}
              onChange={setSelectedOption(name)}
              fill
              small
            />
          )}
        </div>
      );
    });

    const paths = generateViewPaths(view, selected_options, manifests);
    const relevant_synced = view_options.filter(([, option]) => option.synced).map(([name]) => name);

    const show_ref_if_available = controls.show_reference === undefined || controls.show_reference || is_image(view);
    const viewers = paths.map((path, path_idx) => {
      const key = `${idx}-${path_idx}`;
      let new_available = path === undefined || !!manifest_new?.[path];
      // if the file doesn't exist, try TIFF
      if (!new_available && path?.endsWith('.png'))
        new_available = !!manifest_new?.[path.replace(/\.png$/i, '.tiff')];
      if (!new_available)
        return <span key={key}/>

      // For the reference: only fallback if the exact file doesn't exist
      let path_ref = path;
      let ref_available = path === undefined || !!manifest_ref?.[path];
      // Fallback for ref: if file doesn't exist, try TIFF then BMP (old behavior for PNG)
      // we changed the output format in HW_ALG from bmp to png in May 2024
      // but we still want to compare results across branches - for some time at least.
      if (path?.endsWith('.png') && !ref_available) {
        const tiff_path = path.replace(/\.png$/i, '.tiff');
        const bmp_path = path.replace(/\.png$/, '.bmp');
        if (manifest_ref?.[tiff_path]) {
          path_ref = tiff_path;
          ref_available = true;
        } else if (manifest_ref?.[bmp_path]) {
          path_ref = bmp_path;
          ref_available = true;
        }
      }
      // Image viewers say it themselves. When a run is compared with itself it's obvious.
      const has_same_data = !is_image(view) && output_ref?.id !== output_new.id && is_same_data(path, manifest_new?.[path], manifest_ref?.[path_ref])
      return <div key={key} id={key}>
        {(paths.length > 1 || relevant_synced.length > 0) && (
          <div
            className="path-header"
            style={path_header_style}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = '#e8f4f8';
              e.currentTarget.style.borderColor = '#bfccd6';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = '#f5f8fa';
              e.currentTarget.style.borderColor = '#e1e8ed';
            }}
          >
            <span style={{ flex: 1, marginRight: '8px' }}>{path}</span>
            {relevant_synced.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {relevant_synced.map(option_name => (
                  <Tooltip
                    key={option_name}
                    content={`Unlink "${option_name}" to choose its value in each output`}
                    position="top"
                  >
                    <Button
                      icon="unlink"
                      minimal
                      small
                      onClick={() => onToggleDynamicOptionSync?.(option_name)}
                      style={sync_button_style}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; }}
                    />
                  </Tooltip>
                ))}
                <span style={{ fontSize: '10px', color: '#106ba3', fontWeight: '500', marginLeft: '4px' }}>
                  linked
                </span>
              </div>
            )}
          </div>
        )}
        {has_same_data && <div><Tag style={{marginTop: "5px"}} minimal icon="duplicate">same-data-compared</Tag></div>}
        <OutputViewer
          key={key}
          id={key}
          output_new={output_new}
          output_ref={(ref_available && show_ref_if_available) ? output_ref : undefined}
          manifests={manifests}
          {...view}
          {...controls}
          path={path}
          path_ref={path_ref}
          style={{ ...style, ...view.style }}
          fullscreen={fullscreen}
          config={config}
        />
      </div>
    })
    return <Fragment key={idx}>
      {options_inputs}
      {viewers}
    </Fragment>
  }

  let content;
  if (!viewable) {
    content = <span key="none-viewable"/>
  } else if (type === 'bit_accuracy') {
    content = <OutputViewer
      key="bit-accuracy"
      type="files/bit-accuracy"
      {...controls}
      controls={controls}
      output_new={output_new}
      output_ref={output_ref}
      manifests={manifests}
      config={config}
      style={style}
      show_all_files={show_all_files}
      hide_runs_without_files={hide_runs_without_files}
      expand_all={expand_all}
      color_blind_friendly={color_blind_friendly}
      files_filter={files_filter}
    />
  } else {
    const { main_metrics, available_metrics } = metrics ?? {};
    content = <>
      <MetricsTags
        key="content-metrics-tags"
        selected_metrics={main_metrics}
        available_metrics={available_metrics}
        metrics_new={output_new.metrics ?? {}}
        metrics_ref={output_ref?.metrics && output_ref.id !== output_new.id ? output_ref.metrics : {}}
      />
      {views.map(render_view)}
    </>
  }

  const container_style = {
    flex: "0 0 auto",
    // without outputs.style.width in qaboard.yaml: as wide as the page allows, up to 1500px
    width: style.width || 'min(1500px, 100%)',
    marginBottom: "250px !important",
  }
  const maybe_style_skeleton = output_new.is_running ? style_skeleton : {};

  return <div style={container_style} className="output-card" ref={in_view_ref}>
    <FullScreenableSlimCard
      updateFullscreen={setFullscreen}
      className="output-card"
      style={{
        ...maybe_style_skeleton,
        paddingBottom: !viewable ? "100px" : undefined,
        minHeight: type !== 'bit_accuracy' ? "400px" : undefined,
      }}
    >
      {error.new && <Tooltip key="error-new" content={<span dangerouslySetInnerHTML={{ __html: error_html(error.new) }} />}>
        <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Download error @new</Tag>
      </Tooltip>}
      {error.reference && <Tooltip key="error-ref" content={<span dangerouslySetInnerHTML={{ __html: error_html(error.reference) }} />}>
        <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Download error @reference</Tag>
      </Tooltip>}
      {error.parse && <Tooltip key="error-parse" content={<ul>{error.parse.map(e => <li key={e.path}><strong>{e.path}:</strong> {e.message}</li>)}</ul>}>
        <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Parsing Error</Tag>
      </Tooltip>}
      {error.registration && <Tooltip key="error-registration" content={<span>{error.registration}</span>}>
        <Tag style={{ margin: '5px' }} intent={Intent.WARNING}>Registration Error</Tag>
      </Tooltip>}

      {!no_header && <OutputHeader
        key="header"
        project={project}
        commit={commit}
        output={output_new}
        output_ref={output_ref}
        viewable={viewable}
        manifests={manifests}
        type={type}
        style={condensed_header_style}
        prefix={output_new.is_running && <StatusTag output={output_new} style={{ marginRight: '5px' }}/>}
      />}
      {output_new.is_failed && <Tag key="new-failed" intent={Intent.DANGER}>Failed</Tag>}
      {output_ref?.is_failed && <Tag key="ref-failed" intent={Intent.WARNING}>Reference Failed</Tag>}
      {output_new.deleted && <Tag key="new-deleted" intent={Intent.DANGER}>Deleted</Tag>}
      {output_ref?.deleted && <Tag key="ref-deleted" intent={Intent.WARNING}>Reference deleted</Tag>}
      {content}
    </FullScreenableSlimCard>
  </div>
})


export { OutputCard };
