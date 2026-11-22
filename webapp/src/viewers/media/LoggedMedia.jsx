// What a run logged at its steps besides numbers (run.log() in Python, qaboard/media.py): images, audio, video,
// tables, histograms, texts... One step slider for all the keys, each key showing its items at the greatest step <= the
// selected one, next to the reference run's at the same step. While the run goes on, new steps show up.
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Callout, Classes, Icon, InputGroup, Slider, Tag, Tooltip } from "@blueprintjs/core";

import { fileQuery } from "../../api/queries";
import { useLabels } from "../../hooks";
import { plot_color } from "../../sideColors";
import { useIsDark } from "../../theme";
import { OutputViewer } from "../OutputViewer";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { useMediaContext } from "./context";
import ImageGrid from "./ImageGrid";
import { boxRegions, groupKeys, itemAt, nextStep, parseMedia, snap } from "./media";

const LoadableTableView = lazy(() => import('./TableView'));
const LoadableHistogramView = lazy(() => import('./HistogramView'));

// Running runs append to media.jsonl as they go, like series
const REFRESH_INTERVAL = 10 * 1000;
// Keys are drawn one after the other: runs that log many show the first ones, and the others on demand
const SHOWN_AT_FIRST = 12;
const FILTER_FROM = 8;

export const KIND_ICONS = {
  image: 'media', video: 'video', audio: 'music', table: 'th', histogram: 'timeline-bar-chart',
  text: 'align-left', html: 'code', plotly: 'chart', file: 'document',
};

const useMediaIndex = (output, path, fileUrl) => {
  const url = fileUrl(output, path);
  const query = useQuery({
    ...fileQuery(url, { is_running: output?.is_running, responseType: 'text' }),
    refetchInterval: output?.is_running ? REFRESH_INTERVAL : false,
  });
  const model = query.data !== undefined ? parseMedia(typeof query.data === 'string' ? query.data : '') : null;
  return { url, query, model };
};

// The slider over the logged steps: its value is the position of the step, so that arrows move between steps
const StepSlider = ({ steps, step, onChange, onRelease }) => {
  const position = Math.max(0, steps.indexOf(step));
  const label_step = Math.max(1, Math.ceil((steps.length - 1) / 6));
  return <span style={{ flex: '1 1 260px', minWidth: 200, maxWidth: 560, padding: '0 10px' }}>
    <Slider
      min={0}
      max={steps.length - 1}
      stepSize={1}
      labelStepSize={label_step}
      labelRenderer={(i, options) => options?.isHandleTooltip ? `step ${steps[i]}` : String(steps[i])}
      value={position}
      onChange={i => onChange(steps[i])}
      onRelease={i => onRelease(steps[i])}
      handleHtmlProps={{ 'aria-label': 'Step', 'aria-valuetext': `step ${step}` }}
    />
  </span>;
};

// One key: what it logged at the step, and the reference's
const MediaKey = ({ name, kind, model_new, model_ref, step, output_new, output_ref, viewer_props, names, colors, onStep }) => {
  const { Viewer: CustomViewer } = useMediaContext();
  const Viewer = CustomViewer ?? OutputViewer;
  const [selected, setSelected] = useState(null);
  const at_new = itemAt(model_new, name, step);
  const at_ref = model_ref ? itemAt(model_ref, name, step) : { step: null, items: [] };
  const items_ref = at_ref.items;
  const ref_of = item => items_ref.find(ref => (ref.index ?? 0) === (item.index ?? 0));
  const viewer = (item, ref) => <Viewer
    {...viewer_props}
    key={item.index ?? 0}
    output_new={output_new}
    output_ref={ref ? output_ref : undefined}
    path={item.path}
    path_ref={ref?.path}
    boxes={kind === 'image' ? boxRegions(item) : undefined}
  />;

  let content;
  if (at_new.step === null) {
    content = <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Not logged yet at step {step}.</span>;
  } else if (kind === 'histogram') {
    content = <LoadableHistogramView entry_new={model_new.keys[name]} entry_ref={model_ref?.keys[name]} step={at_new.step} step_ref={at_ref.step} onStep={onStep} colors={colors} names={names}/>;
  } else if (kind === 'table') {
    content = <LoadableTableView item_new={at_new.items[0]} item_ref={items_ref[0]} output_new={output_new} output_ref={output_ref} names={names}/>;
  } else if (kind === 'image' && (at_new.items.length > 1 || items_ref.length > 1)) {
    const opened = selected !== null ? at_new.items.find(item => (item.index ?? 0) === selected) : null;
    content = <>
      <ImageGrid items_new={at_new.items} items_ref={items_ref} output_new={output_new} output_ref={output_ref} names={names} colors={colors} selected={opened ? selected : null} onSelect={setSelected}/>
      {opened && <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <strong>#{selected}</strong>{opened.caption && <span>{opened.caption}</span>}
          <Button size="small" variant="minimal" icon="cross" aria-label="Close the image" onClick={() => setSelected(null)}/>
        </div>
        {viewer(opened, ref_of(opened))}
      </div>}
    </>;
  } else {
    content = at_new.items.map(item => {
      const ref = ref_of(item);
      return <div key={item.index ?? 0}>
        {item.path ? viewer(item, ref) : <span className={Classes.TEXT_MUTED}>No file.</span>}
        {(item.caption || ref?.caption) && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
          {item.caption}{ref?.caption && ref.caption !== item.caption && <> ({names.ref}: {ref.caption})</>}
        </div>}
      </div>;
    });
  }

  return <section aria-label={name} data-testid="media-key" style={{ marginBottom: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}>
      <Icon icon={KIND_ICONS[kind] ?? 'document'} size={12} title={kind}/>
      <strong style={{ overflowWrap: 'anywhere' }}>{name}</strong>
      {at_new.step !== null && at_new.step !== step && <Tag minimal size="small">logged at step {at_new.step}</Tag>}
      {model_ref && at_new.step !== null && (at_ref.step === null
        ? <Tag minimal size="small" icon="info-sign">not in {names.ref}</Tag>
        : at_ref.step !== at_new.step && <Tag minimal size="small">{names.ref}: step {at_ref.step}</Tag>)}
    </div>
    <Suspense fallback={<ViewerLoading height={120}/>}>{content}</Suspense>
  </section>;
};

// media_step: the step chosen for all the runs' cards (controls.media_step, in the URL), onControlsChange tells the
// page. Without it, e.g. in a preview, the card has its own. By default: the last step, also while the run goes on.
// The other props are the card's, for the viewers of the items: the visual controls, config, fullscreen...
const LoggedMedia = ({ output_new, output_ref, path = 'media.jsonl', path_ref, labels: labels_, media_step, onControlsChange, style, manifests, name: _name, automatic: _automatic, id: _id, ...props }) => {
  const { fileUrl } = useMediaContext();
  const labels = useLabels(labels_);
  const is_dark = useIsDark();
  const [own_step, setOwnStep] = useState(undefined);
  // while the slider is dragged
  const [preview, setPreview] = useState(undefined);
  const [filter, setFilter] = useState('');
  const [show_all, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());

  const compared = !!output_ref && output_ref.id !== output_new?.id;
  const index_new = useMediaIndex(output_new, path, fileUrl);
  const index_ref = useMediaIndex(compared ? output_ref : undefined, path_ref ?? path, fileUrl);

  if (index_new.query.isError) return <ViewerError path={path} error={index_new.query.error}/>;
  if (!index_new.url || index_new.query.isPending || (index_ref.url && index_ref.query.isPending)) return <ViewerLoading height={style?.height}/>;

  const model_new = index_new.model;
  // without the reference's media (or an error), we show the new run's alone
  const model_ref = compared && index_ref.query.isSuccess ? index_ref.model : null;
  const steps = model_new.steps;
  const keys = Object.keys(model_new.keys);
  if (keys.length === 0)
    return <Callout compact icon="info-sign">{output_new?.is_running ? "The run hasn't logged media yet." : 'The run logged no media.'}</Callout>;

  const chosen = onControlsChange ? media_step : own_step;
  const wanted = preview ?? chosen ?? steps.at(-1);
  // the selected step, among the run's: a step chosen on another card snaps to this run's
  const step = snap(steps, wanted) ?? steps[0];
  const choose = value => {
    setPreview(undefined);
    if (onControlsChange) onControlsChange({ media_step: value });
    else setOwnStep(value);
  };
  // on the toolbar's buttons: arrows move between the logged steps, as on the slider's handle
  const onKeyDown = e => {
    if (e.target.closest?.(`.${Classes.SLIDER}`) || e.target.closest?.('input')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    choose(nextStep(steps, step, e.key === 'ArrowRight' ? 1 : -1));
  };

  const names = { new: labels?.new ?? 'new', ref: labels?.reference ?? 'reference' };
  const colors = {
    new: labels?.colors?.new ? plot_color(labels.colors.new, is_dark) : '#2d72d2',
    ref: labels?.colors?.reference ? plot_color(labels.colors.reference, is_dark) : '#738091',
  };
  const needle = filter.trim().toLowerCase();
  const matching = needle ? keys.filter(key => key.toLowerCase().includes(needle)) : keys;
  const groups = groupKeys(matching);
  // the keys shown: the first ones, in the groups' order
  let budget = show_all ? Infinity : SHOWN_AT_FIRST;
  const shown_groups = groups.map(({ group, keys }) => {
    const shown = collapsed.has(group) ? [] : keys.slice(0, Math.max(0, budget));
    budget -= shown.length;
    return { group, keys, shown };
  });
  const hidden = shown_groups.reduce((n, { group, keys, shown }) => n + (collapsed.has(group) ? 0 : keys.length - shown.length), 0);
  const toggle = group => setCollapsed(collapsed => {
    const next = new Set(collapsed);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  // what the viewers of the items get from the card: the visual controls, the manifests...
  const viewer_props = { ...props, labels: labels_, manifests, style, onControlsChange };
  const following = chosen === undefined && preview === undefined;
  const key_props = { model_new, model_ref, step, output_new, output_ref: compared ? output_ref : undefined, viewer_props, names, colors, onStep: choose };

  return <div data-testid="logged-media">
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '6px 0 14px' }} onKeyDown={onKeyDown}>
      {output_new?.is_running && <Tag minimal intent="primary" icon="pulse">Live</Tag>}
      <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
        Step <strong data-testid="media-step">{step}</strong>
        {wanted !== step && <span className={Classes.TEXT_MUTED}> (chosen: {wanted})</span>}
      </span>
      {steps.length > 1 && <>
        <Button size="small" variant="minimal" icon="chevron-left" aria-label="Previous step" disabled={step === steps[0]} onClick={() => choose(nextStep(steps, step, -1))}/>
        <StepSlider steps={steps} step={step} onChange={setPreview} onRelease={choose}/>
        <Button size="small" variant="minimal" icon="chevron-right" aria-label="Next step" disabled={step === steps.at(-1)} onClick={() => choose(nextStep(steps, step, 1))}/>
        <Tooltip content="Show the last step, and follow the run while it logs more" compact>
          <Button size="small" variant="minimal" icon="fast-forward" active={following} onClick={() => choose(undefined)} text="Latest"/>
        </Tooltip>
      </>}
      <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
        {keys.length} {keys.length === 1 ? 'key' : 'keys'}, {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        {compared && !model_ref?.items.length && <>, nothing logged in {names.ref}</>}
      </span>
      {keys.length > FILTER_FROM && <InputGroup size="small" leftIcon="search" placeholder="Filter keys" aria-label="Filter keys" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 160 }}/>}
    </div>
    {shown_groups.map(({ group, keys, shown }) => {
      const items = shown.map(key => <MediaKey key={key} name={key} kind={model_new.keys[key].kind} {...key_props}/>);
      if (!group) return <div key="">{items}</div>;
      const is_collapsed = collapsed.has(group);
      return <div key={group} style={{ marginBottom: 8 }}>
        <Button variant="minimal" size="small" icon={is_collapsed ? 'chevron-right' : 'chevron-down'} onClick={() => toggle(group)} aria-expanded={!is_collapsed} style={{ fontWeight: 600 }}>
          {group} <span className={Classes.TEXT_MUTED}>({keys.length})</span>
        </Button>
        {!is_collapsed && <div style={{ paddingLeft: 12, borderLeft: '1px solid rgba(128, 128, 128, 0.25)', marginLeft: 8, paddingTop: 4 }}>{items}</div>}
      </div>;
    })}
    {hidden > 0 && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
      Show the {hidden} other keys
    </Button>}
    {needle && matching.length === 0 && <span className={Classes.TEXT_MUTED}>No key matches "{filter}".</span>}
  </div>;
};

export default LoggedMedia;
