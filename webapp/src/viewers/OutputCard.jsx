import { Fragment, memo, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useInView } from 'react-intersection-observer'
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
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
  PopoverNext,
  Menu,
  PopoverInteractionKind,
} from "@blueprintjs/core";

import { OutputViewer } from "./OutputViewer";
import { config_visualizations } from "./controls";
import { MetricsTags } from "../components/metrics";
import { OutputTags, StatusTag, RunBadges, style_skeleton } from '../components/tags'
import { RunInfoMenuItems } from '../components/RunInfoMenu'

import { updateSelected } from "../hooks";
import { http, errorMessage } from "../api/http";
import { output_files_stale_time, invalidateOutputFiles } from "../api/queries";
import { at_most, is_same_data } from '../utils'
import { is_image } from "./images/utils"
import {
  parseVisualizationOptions,
  calculateOptionValues,
  configureOption,
  generateViewPaths,
  optionLabel,
  resolveOptionValue,
} from "../utils/dynamicOptions"


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
  const views = config_visualizations(outputs);
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


const SlimCard = styled(Card)`
  overflow: "auto";
`;

// The button is in the full screen element, to exit too. No tooltips in there: they show outside of it.
const FullScreenableSlimCard = ({ updateFullscreen, className, style, children }) => {
  const handle = useFullScreenHandle();
  return <SlimCard compact className={className} style={style}>
    <FullScreen handle={handle} onChange={state => updateFullscreen(state)}>
      <div style={{position: "relative"}}>
        <div style={{position: "absolute", right: "0px", top: "0px", zIndex: 1}}>
          <Button
            size="small"
            variant="minimal"
            icon={handle.active ? "minimize" : "fullscreen"}
            aria-label={handle.active ? "Exit full screen" : "Full screen"}
            title={handle.active ? "Exit full screen (Esc)" : "Full screen: this run's visualizations. Images have their own, in their toolbar"}
            onClick={handle.active ? handle.exit : handle.enter}
          />
        </div>
      </div>
      {children}
    </FullScreen>
  </SlimCard>
}


// Long paths are cut, the tags after them stay on the line
const run_path_style = {
  display: 'inline-block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
};

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
    type={type}
    style={{marginLeft: '5px', marginRight: '5px'}}
  />

  let run_path = `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
  if (output.output_type === "pipeline" || output.test_input_path === "PIPELINE") {
    run_path = <span>{output.data.batch} <span className={Classes.TEXT_MUTED}>(pipeline)</span></span>
  }
  if (has_label) {
    run_path = output.test_input_metadata.label
  }
  const popover_content = <Menu>
    <RunInfoMenuItems project={project} commit={commit} output={output} type={type} />
  </Menu>
  return <>
    <h5 className={Classes.HEADING} style={style} >
      {prefix}
      {tags_first && viewable && tags}
      {output.output_type !== "batch" && !viewable ?
        <span key="batch-info" style={run_path_style}>{run_path}</span> : <PopoverNext hoverCloseDelay={1000} interactionKind={PopoverInteractionKind.HOVER} content={popover_content}>
        <span key="batch-info" style={run_path_style}>{run_path}</span>
      </PopoverNext>}
      {!tags_first && viewable && tags}
    </h5>
    <p style={{maxWidth: '600px'}}>
      <RunBadges output={output}></RunBadges>
    </p>
  </>
}



const condensed_header_style = {
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.6,
};

const option_style = {
  marginBottom: '8px',
  padding: '8px',
  backgroundColor: 'var(--qa-surface-alt)',
  borderRadius: '3px',
  border: '1px solid var(--qa-border)'
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
// PathHeader sets its opacity, higher on hover
const unlink_button_style = {
  minHeight: '16px',
  minWidth: '16px',
  padding: '2px',
};

const PathHeader = styled.div`
  font-size: 12px;
  color: var(--qa-text-muted);
  margin-bottom: 8px;
  border-bottom: 1px solid var(--qa-border);
  font-family: monospace;
  background-color: var(--qa-surface-alt);
  padding: 4px 8px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: background-color 0.2s ease-out;
  &:hover {
    background-color: var(--qa-hover);
  }
  .${Classes.BUTTON} {
    opacity: 0.6;
    transition: opacity 0.2s ease-out;
  }
  .${Classes.BUTTON}:hover, .${Classes.BUTTON}:focus-visible {
    opacity: 1;
  }
`;


const OutputCard = memo(function OutputCard(props) {
  const {
    project, commit, config, metrics, type, output_new, output_ref, files_filter, no_header,
    show_all_files, hide_runs_without_files, expand_all, color_blind_friendly,
    onRegisterOutputOptions, onToggleDynamicOptionSync, onControlsChange, labels,
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

  const views = config_visualizations(config?.outputs);
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
      const option_label = isNaN(name) ? optionLabel(name) : option.pattern;
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
              <Tooltip content={`Use the ${option_label} chosen in the view options for all runs`}>
                <Button icon="link" variant="minimal" size="small" onClick={() => onToggleDynamicOptionSync(name)} style={sync_button_style}>
                  Same for all runs
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
      // so that projects that switched their images from BMP to PNG can still compare with older references.
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
          <PathHeader className="path-header">
            <span style={{ flex: 1, marginRight: '8px' }}>{path}</span>
            {relevant_synced.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {relevant_synced.map(option_name => (
                  <Tooltip
                    key={option_name}
                    content={`${optionLabel(option_name)}: the same for all runs, set in the View options. Click to choose it per run.`}
                    position="top"
                  >
                    <Button
                      icon="unlink"
                      variant="minimal"
                      size="small"
                      aria-label={`Choose ${optionLabel(option_name)} per run`}
                      onClick={() => onToggleDynamicOptionSync?.(option_name)}
                      style={unlink_button_style}
                    />
                  </Tooltip>
                ))}
              </div>
            )}
          </PathHeader>
        )}
        {has_same_data && <div><Tooltip content="The new and reference files have the same hash">
          <Tag style={{marginTop: "5px"}} minimal icon="duplicate">Identical to the reference</Tag>
        </Tooltip></div>}
        <OutputViewer
          key={key}
          id={key}
          output_new={output_new}
          output_ref={(ref_available && show_ref_if_available) ? output_ref : undefined}
          manifests={manifests}
          {...view}
          {...controls}
          onControlsChange={onControlsChange}
          path={path}
          path_ref={path_ref}
          style={{ ...style, ...view.style }}
          fullscreen={fullscreen}
          config={config}
          labels={labels}
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
      files_loading={query_new.isLoading}
      config={config}
      style={style}
      show_all_files={show_all_files}
      hide_runs_without_files={hide_runs_without_files}
      expand_all={expand_all}
      color_blind_friendly={color_blind_friendly}
      files_filter={files_filter}
      labels={labels}
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
    // as wide as the page allows, up to outputs.style.width in qaboard.yaml, else 1500px
    width: at_most(style.width || '1500px'),
    // wider when a viewer needs it, e.g. a plot wider than outputs.style.width: it would spill out of the card
    minWidth: 'min-content',
    marginBottom: "250px !important",
  }
  const maybe_style_skeleton = output_new.is_running ? style_skeleton : {};

  return <div style={container_style} className="output-card" data-output-id={output_new.id} ref={in_view_ref}>
    <FullScreenableSlimCard
      updateFullscreen={setFullscreen}
      className="output-card"
      style={{
        ...maybe_style_skeleton,
        paddingBottom: !viewable ? "100px" : undefined,
        minHeight: type !== 'bit_accuracy' ? "400px" : undefined,
      }}
    >
      {error.new && <span key="error-new">
        <Tooltip content={<span>{errorMessage(error.new)}</span>}>
          <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Could not list the run's files</Tag>
        </Tooltip>
        <Button size="small" variant="minimal" icon="refresh" text="Retry" onClick={() => query_new.refetch()}/>
      </span>}
      {error.reference && <span key="error-ref">
        <Tooltip content={<span>{errorMessage(error.reference)}</span>}>
          <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Could not list the reference's files</Tag>
        </Tooltip>
        <Button size="small" variant="minimal" icon="refresh" text="Retry" onClick={() => query_ref.refetch()}/>
      </span>}
      {error.parse && <Tooltip key="error-parse" content={<>
        <ul>{error.parse.map(e => <li key={e.path}><strong>{e.path}:</strong> {e.message}</li>)}</ul>
        Check <code>outputs.visualizations</code> in qaboard.yaml
      </>}>
        <Tag style={{ margin: '5px' }} intent={Intent.DANGER}>Invalid visualization path</Tag>
      </Tooltip>}
      {error.registration && <Tooltip key="error-registration" content={<span>{error.registration}</span>}>
        <Tag style={{ margin: '5px' }} intent={Intent.WARNING}>Could not read the visualization options</Tag>
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
      {/* History shows cards as hover previews, without a logs view */}
      {output_new.is_failed && (no_header
        ? <Tag key="new-failed" intent={Intent.DANGER}>Failed</Tag>
        : <Button key="new-failed" size="small" variant="minimal" intent={Intent.DANGER} icon="error" text="Failed: see the logs" onClick={() => updateSelected({ selected_views: 'logs' })}/>
      )}
      {output_ref?.is_failed && <Tag key="ref-failed" intent={Intent.WARNING}>Reference failed</Tag>}
      {output_new.deleted && <Tag key="new-deleted" intent={Intent.DANGER}>Deleted</Tag>}
      {output_ref?.deleted && <Tag key="ref-deleted" intent={Intent.WARNING}>Reference deleted</Tag>}
      {content}
    </FullScreenableSlimCard>
  </div>
})


export { OutputCard };
