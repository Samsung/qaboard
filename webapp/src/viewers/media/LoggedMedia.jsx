// What a run logged at its steps besides numbers (run.log() in Python, qaboard/media.py): images, audio, video,
// tables, histograms, texts... Design: docs/design/logged-media.md.
// - one timeline for all the keys, sticky: a tick per logged step, the run's main series behind, the reference's steps
// - each key shows its items at the greatest step <= the selected one, next to the reference's same samples (matched by
//   id, else caption, else position), and says so when an item comes from another step
// - the step is the same for all the cards of the page (controls.media_step, in the URL), the key and sample users are
//   on, and the evolution strip, are the card's (controls.media_focus, with the run's id): the address shares them
// While the run goes on, new steps show up.
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useInView } from "react-intersection-observer";
import { Button, ButtonGroup, Callout, Classes, Dialog, DialogBody, Icon, InputGroup, Tag, Tooltip } from "@blueprintjs/core";

import { fileQuery } from "../../api/queries";
import { useLabels } from "../../hooks";
import { plot_color } from "../../sideColors";
import { useIsDark } from "../../theme";
import { usePrefsStore } from "../../stores/prefs";
import { OutputViewer } from "../OutputViewer";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { parse_series, sorted_keys } from "../series/series";
import { runFileUrl, useMediaContext } from "./context";
import { KIND_ICONS } from "./kinds";
import ImageGrid, { slotSize } from "./ImageGrid";
import BoxControls from "./BoxControls";
import Timeline from "./Timeline";
import { boxRegions, formatStep, groupKeys, itemAt, matchItem, nextStep, parseMedia, sampleKey, snap, summary } from "./media";
import { useWidth } from "./useWidth";

const LoadableTableView = lazy(() => import('./TableView'));
const LoadableHistogramView = lazy(() => import('./HistogramView'));
const LoadableEvolutionStrip = lazy(() => import('./EvolutionStrip'));

export { KIND_ICONS };

// Running runs append to media.jsonl as they go, like series
const REFRESH_INTERVAL = 10 * 1000;
const FILTER_FROM = 6;
// cards at least that wide show the contents on the side
const WIDE = 900;
const no_pins = {};
const no_steps = [];
const text_of = data => typeof data === 'string' ? data : '';
const selector = (name, value) => `[data-${name}=${JSON.stringify(value)}]`;

const useRunFile = (output, path, fileUrl, options = {}) => {
  const url = path ? fileUrl(output, path) : undefined;
  return useQuery({
    ...fileQuery(url, { is_running: output?.is_running, responseType: 'text' }),
    refetchInterval: output?.is_running ? REFRESH_INTERVAL : false,
    ...options,
  });
};

// The run's series, to draw one behind the timeline: the loss by default
const useSeries = (output, manifest, fileUrl) => {
  const exists = path => manifest ? !!manifest[path] : fileUrl !== runFileUrl && !!fileUrl(output, path);
  const path = ['series.json', 'series.jsonl'].find(exists);
  const query = useRunFile(output, path, fileUrl);
  if (!query.data) return null;
  try {
    return parse_series(query.data);
  } catch {
    return null;
  }
};
export const defaultSeries = names => names.find(name => /(^|[/_.])loss$/i.test(name)) ?? names.find(name => /loss/i.test(name)) ?? names[0] ?? null;

const HELP = [
  ['← →', 'previous / next logged step'],
  ['↑ ↓', 'previous / next sample of the key'],
  ['space', 'the reference on top / the new run on top'],
  ['e', 'the sample across the steps (evolution strip)'],
  ['f', 'open the sample in the image viewer'],
  ['Esc', 'close'],
  ['?', 'this help'],
];

const EmptyState = ({ running }) => <Callout compact icon="media" title={running ? "The run hasn't logged media yet" : 'The run logged no media'}>
  Log images, audio, tables... at a step, and they show here, next to the reference run's:
  <pre style={{ margin: '6px 0 0', fontSize: 12 }}>{`run.log({"val/samples": [qaboard.Image(img, caption=name, id=name) for img, name in batch]}, step=step)
run.log({"weights/fc1": qaboard.Histogram(model.fc1.weight)}, step=step)`}</pre>
</Callout>;

// Keys are drawn when they come near the screen: runs log dozens. Until then, a placeholder of about their size.
const Lazy = ({ height, children }) => {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '600px', fallbackInView: true });
  return <div ref={ref} style={inView ? undefined : { minHeight: height }}>{inView && children}</div>;
};

const estimated_height = (entry, ref) => {
  if (entry.kind === 'histogram') return 280;
  if (entry.kind === 'table') return 360;
  if (entry.kind === 'image') {
    const items = entry.by_step.get(entry.steps.at(-1));
    const slot = slotSize(items[0], null, items.length === 1 ? 300 : 150);
    return 60 + (ref ? 2 : 1) * slot.height * Math.ceil(items.length / 5);
  }
  return 200;
};

// One key: what it logged at the step, and the reference's
const MediaKey = props => {
  const { name, model_new, model_ref, step, output_new, output_ref, viewer_props, names, colors, onStep, focus, setFocus, flipped, pinned, onPin, width } = props;
  const { Viewer: CustomViewer, fileUrl } = useMediaContext();
  const Viewer = CustomViewer ?? OutputViewer;
  const [box_filters, setBoxFilters] = useState({ hidden: new Set(), min_score: 0 });
  const [text_against, setTextAgainst] = useState('reference');
  const entry = model_new.keys[name];
  const kind = entry.kind;
  const at_new = itemAt(model_new, name, step);
  const at_ref = model_ref ? itemAt(model_ref, name, step) : null;
  const items_ref = at_ref?.items ?? null;
  const is_focused = focus.key === name;
  const ref_of = item => items_ref ? matchItem(item, items_ref).item : null;
  // items in viewers don't take the section's keys
  const viewer = (item, ref, ref_output = output_ref) => <div className="qa-media-viewer" key={sampleKey(item)}>
    <Viewer
      {...viewer_props}
      output_new={output_new}
      output_ref={ref ? ref_output : undefined}
      path={item.path}
      path_ref={ref?.path}
      boxes={kind === 'image' ? boxRegions(item, box_filters) : undefined}
    />
  </div>;

  let content;
  if (at_new.step === null) {
    content = <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Not logged yet at step {formatStep(step)}: from step {formatStep(entry.steps[0])}.</span>;
  } else if (kind === 'histogram') {
    content = <LoadableHistogramView entry_new={entry} entry_ref={model_ref?.keys[name]} step={at_new.step} step_ref={at_ref?.step} onStep={onStep} colors={colors} names={names}/>;
  } else if (kind === 'table') {
    content = <LoadableTableView key={at_new.step} item_new={at_new.items[0]} item_ref={items_ref?.[0]} output_new={output_new} output_ref={output_ref} names={names}/>;
  } else if (kind === 'image') {
    const opened = is_focused && focus.open && focus.sample ? matchItem(focus.sample, at_new.items).item : null;
    const evolving = is_focused && focus.evolution && focus.sample;
    const side_by_side = at_new.items.length === 1 && !!items_ref && width >= 560;
    const size = at_new.items.length === 1 ? Math.min(320, Math.floor((width - 10) / (side_by_side ? 2 : 1))) : width < 520 ? 110 : 150;
    content = <>
      <BoxControls items={[...at_new.items, ...(items_ref ?? [])]} filters={box_filters} onChange={setBoxFilters}/>
      {evolving && <LoadableEvolutionStrip
        name={name} sample={focus.sample} model_new={model_new} model_ref={model_ref} output_new={output_new} output_ref={output_ref}
        step={at_new.step} onStep={onStep} onClose={() => setFocus({ evolution: false })} names={names} colors={colors} filters={box_filters}
      />}
      <ImageGrid
        items_new={at_new.items} items_ref={items_ref} output_new={output_new} output_ref={output_ref} names={names} colors={colors}
        size={size} side_by_side_room={side_by_side} filters={box_filters} flipped={is_focused && flipped} focused={is_focused ? focus.sample : null}
        onOpen={sample => setFocus({ key: name, sample, open: !(is_focused && focus.open && focus.sample === sample) })}
        onEvolution={sample => setFocus({ key: name, sample, evolution: !(evolving && focus.sample === sample) })}
      />
      {opened && <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
          <Icon icon="zoom-in" size={12}/><strong>{opened.caption ?? opened.id ?? `#${opened.index ?? 0}`}</strong>
          <span style={{ flex: 1 }}/>
          <Button size="small" variant="minimal" icon="cross" aria-label="Close the image" onClick={() => setFocus({ open: false })}/>
        </div>
        {viewer(opened, ref_of(opened))}
      </div>}
    </>;
  } else if (kind === 'text') {
    // against the reference at the step, or against the run's previous step
    const previous_step = entry.steps[entry.steps.indexOf(at_new.step) - 1];
    const previous = previous_step !== undefined ? entry.by_step.get(previous_step) : null;
    const against = text_against === 'previous' && previous ? 'previous' : 'reference';
    content = <>
      <ButtonGroup size="small" style={{ marginBottom: 4 }}>
        <Button active={against === 'reference'} disabled={!items_ref} onClick={() => setTextAgainst('reference')} text={`vs ${names.ref}`}/>
        <Button active={against === 'previous'} disabled={!previous} onClick={() => setTextAgainst('previous')} text={previous_step !== undefined ? `vs step ${formatStep(previous_step)}` : 'vs previous step'}/>
      </ButtonGroup>
      {at_new.items.map(item => against === 'previous'
        ? viewer(item, matchItem(item, previous).item, output_new)
        : viewer(item, ref_of(item)))}
    </>;
  } else {
    content = at_new.items.map(item => {
      const ref = ref_of(item);
      return <div key={sampleKey(item)}>
        {item.path ? viewer(item, ref) : <span className={Classes.TEXT_MUTED}>No file.</span>}
        {(item.caption || ref?.caption) && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
          {item.caption}{ref?.caption && ref.caption !== item.caption && <> ({names.ref}: {ref.caption})</>}
        </div>}
      </div>;
    });
  }

  const download = at_new.items[0]?.path ? fileUrl(output_new, at_new.items[0].path) : null;
  return <section aria-label={name} data-testid="media-key" data-key={name} style={{ marginBottom: 18, scrollMarginTop: 120 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13, marginBottom: 6, minHeight: 24 }}>
     <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minHeight: 24 }}>
      <Icon icon={KIND_ICONS[kind] ?? 'document'} size={12} title={kind} className={Classes.TEXT_MUTED}/>
      <strong style={{ overflowWrap: 'anywhere' }}>{name}</strong>
      {at_new.step !== null && at_new.step !== step && <Tooltip content={`Nothing logged at step ${formatStep(step)}: the last before it`} compact>
        <Tag minimal size="small" icon="history">from step {formatStep(at_new.step)}</Tag>
      </Tooltip>}
      {at_ref && at_new.step !== null && (at_ref.step === null
        ? <Tag minimal size="small">not in {names.ref} yet</Tag>
        : at_ref.step !== at_new.step && <Tag minimal size="small" icon="history">{names.ref} from step {formatStep(at_ref.step)}</Tag>)}
     </div>
     <div style={{ flex: 'none', display: 'flex' }}>
      {kind === 'image' && at_new.items.length > 0 && <Tooltip content="Across the steps (e)" compact>
        <Button size="small" variant="minimal" icon="film" aria-label={`Evolution of ${name}`} onClick={() => setFocus({ key: name, sample: focus.key === name && focus.sample ? focus.sample : sampleKey(at_new.items[0]), evolution: !(is_focused && focus.evolution) })}/>
      </Tooltip>}
      {download && kind !== 'histogram' && <Tooltip content="Download the file" compact>
        <Button size="small" variant="minimal" icon="download" aria-label={`Download ${name}`} href={download} download target="_blank"/>
      </Tooltip>}
      <Tooltip content={pinned ? 'Unpin' : 'Pin on top, for this project'} compact>
        <Button size="small" variant="minimal" icon={pinned ? 'unpin' : 'pin'} aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} onClick={() => onPin(name)} active={pinned}/>
      </Tooltip>
     </div>
    </div>
    <Suspense fallback={<ViewerLoading height={120}/>}>{content}</Suspense>
  </section>;
};

const link_style = { border: 'none', background: 'none', padding: 0, color: 'inherit', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' };

// The keys, grouped by prefix, to jump to one: kind, how many steps, the last
const Contents = ({ groups, pinned, model, collapsed, onToggleGroup, onPin, onJump, filter, setFilter, total }) => {
  const entry = key => <li key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 22, fontSize: 12 }}>
    <Icon icon={KIND_ICONS[model.keys[key].kind]} size={11} className={Classes.TEXT_MUTED}/>
    <button type="button" className="qa-media-link" onClick={() => onJump(key)} style={{ ...link_style, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={key}>
      {key.includes('/') ? key.slice(key.indexOf('/') + 1) : key}
    </button>
    <span className={Classes.TEXT_MUTED} style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{model.keys[key].steps.length}× · {formatStep(model.keys[key].steps.at(-1))}</span>
    <Button size="small" variant="minimal" icon={pinned.has(key) ? 'unpin' : 'pin'} aria-label={pinned.has(key) ? `Unpin ${key}` : `Pin ${key}`} onClick={() => onPin(key)} style={{ minHeight: 18, minWidth: 18, padding: 0, opacity: pinned.has(key) ? 1 : 0.45 }}/>
  </li>;
  return <nav aria-label="Logged media keys" data-testid="media-contents">
    {total > FILTER_FROM && <InputGroup size="small" leftIcon="search" placeholder="Filter keys" aria-label="Filter keys" value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }}/>}
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {pinned.size > 0 && <>
        <li className={Classes.TEXT_MUTED} style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, margin: '2px 0' }}>Pinned</li>
        {[...pinned].filter(key => model.keys[key]).map(entry)}
      </>}
      {groups.map(({ group, keys }) => !group ? keys.map(entry) : <li key={group}>
        <button type="button" className="qa-media-link" onClick={() => onToggleGroup(group)} aria-expanded={!collapsed[group]} style={{ ...link_style, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600, minHeight: 22 }}>
          <Icon icon={collapsed[group] ? 'chevron-right' : 'chevron-down'} size={12}/>{group}<span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{keys.length}</span>
        </button>
        {!collapsed[group] && <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 14 }}>{keys.map(entry)}</ul>}
      </li>)}
    </ul>
  </nav>;
};

// media_step: the step chosen for all the runs' cards (controls.media_step), media_focus: the key, sample and evolution
// strip of one card (controls.media_focus, with its run's id). onControlsChange tells the page; without it, e.g. in a
// preview, the card keeps its own. By default: the last step, also while the run goes on.
// The other props are the card's, for the viewers of the items: the visual controls, config, fullscreen...
const LoggedMedia = ({ output_new, output_ref, path = 'media.jsonl', path_ref, labels: labels_, media_step, media_focus, onControlsChange, style, manifests, project, name: _name, automatic: _automatic, id: _id, ...props }) => {
  const { fileUrl } = useMediaContext();
  const labels = useLabels(labels_);
  const is_dark = useIsDark();
  const project_key = project ?? output_new?.project ?? '';
  const pins = usePrefsStore(state => state.mediaPins?.[project_key]) ?? no_pins;
  const collapsed = usePrefsStore(state => state.mediaGroupsCollapsed?.[project_key]) ?? no_pins;
  const togglePin = usePrefsStore(state => state.toggleMediaPin);
  const toggleGroup = usePrefsStore(state => state.toggleMediaGroup);
  const [own_step, setOwnStep] = useState(undefined);
  const [own_focus, setOwnFocus] = useState({});
  const [filter, setFilter] = useState('');
  const [help, setHelp] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [series_choice, setSeriesChoice] = useState(undefined);
  const [contents_open, setContentsOpen] = useState(false);
  const [root, width, root_element] = useWidth(900);

  const compared = !!output_ref && output_ref.id !== output_new?.id;
  const query_new = useRunFile(output_new, path, fileUrl);
  const query_ref = useRunFile(compared ? output_ref : undefined, path_ref ?? path, fileUrl);
  const model_new = useMemo(() => query_new.data !== undefined ? parseMedia(text_of(query_new.data)) : null, [query_new.data]);
  // without the reference's media (or an error), we show the new run's alone
  const ref_data = compared && query_ref.isSuccess ? query_ref.data : undefined;
  const model_ref = useMemo(() => ref_data !== undefined ? parseMedia(text_of(ref_data)) : null, [ref_data]);
  const series = useSeries(output_new, manifests?.new, fileUrl);

  const steps = model_new?.steps ?? no_steps;
  const chosen = onControlsChange ? media_step : own_step;
  const step = steps.length ? snap(steps, chosen ?? steps.at(-1)) ?? steps[0] : null;
  const focus = onControlsChange ? (media_focus?.run === output_new?.id ? media_focus : {}) : own_focus;

  // the images of the steps around are fetched before users go there
  useEffect(() => {
    if (!model_new || step === null) return;
    const around = [nextStep(steps, step, -1), nextStep(steps, step, 1)].filter(s => s !== step);
    let count = 0;
    for (const [key, entry] of Object.entries(model_new.keys)) {
      if (entry.kind !== 'image') continue;
      for (const s of around) for (const item of itemAt(model_new, key, s).items) {
        if (count++ > 40) return;
        const src = fileUrl(output_new, item.path);
        if (src) new Image().src = src;
      }
    }
  }, [model_new, step, steps, fileUrl, output_new]);

  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  if (!query_new.isSuccess || (compared && query_ref.isPending)) return <ViewerLoading height={style?.height}/>;
  const keys = Object.keys(model_new.keys);
  if (keys.length === 0) return <EmptyState running={output_new?.is_running}/>;

  const choose = value => onControlsChange ? onControlsChange({ media_step: value }) : setOwnStep(value);
  const setFocus = change => {
    const next = { ...focus, ...change };
    if (onControlsChange) onControlsChange({ media_focus: { ...next, run: output_new.id } });
    else setOwnFocus(next);
  };
  const names = { new: labels?.new ?? 'new', ref: labels?.reference ?? 'reference' };
  const colors = {
    new: labels?.colors?.new ? plot_color(labels.colors.new, is_dark) : '#2d72d2',
    ref: labels?.colors?.reference ? plot_color(labels.colors.reference, is_dark) : '#738091',
  };
  const pinned = new Set(Object.keys(pins).filter(key => model_new.keys[key]));
  const needle = filter.trim().toLowerCase();
  const matching = needle ? keys.filter(key => key.toLowerCase().includes(needle)) : keys;
  const groups = groupKeys(matching.filter(key => !pinned.has(key)));
  const shown_keys = [...[...pinned].filter(key => matching.includes(key)), ...groups.flatMap(({ group, keys }) => collapsed[group] ? [] : keys)];
  const series_names = series ? sorted_keys(Object.keys(series.series)) : [];
  const series_name = series_choice === undefined ? defaultSeries(series_names) : series_choice;
  const ref_steps = model_ref?.steps ?? [];
  const image_keys = shown_keys.filter(key => model_new.keys[key].kind === 'image');

  const preview = at => {
    for (const key of image_keys) {
      const items = model_new.keys[key].by_step.get(at);
      if (items) return { src: fileUrl(output_new, items[0].path), label: `${key}${items[0].caption ? ` · ${items[0].caption}` : ''}` };
    }
    const logged = shown_keys.filter(key => model_new.keys[key].by_step.has(at));
    return { label: logged.length ? logged.join(', ') : 'nothing logged' };
  };
  const jump = key => {
    if (pinned.has(key) || !collapsed[groupKeys([key])[0].group]) {
      root_element?.querySelector(selector('key', key))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else toggleGroup(project_key, groupKeys([key])[0].group);
    setFocus({ key });
  };

  // the key and sample the keyboard acts on: the one users are on, else the first images
  const focus_key = focus.key && model_new.keys[focus.key] ? focus.key : image_keys[0];
  const focus_items = focus_key ? itemAt(model_new, focus_key, step).items : [];
  const focus_sample = focus.key === focus_key && focus.sample ? focus.sample : focus_items[0] ? sampleKey(focus_items[0]) : null;
  const onKeyDown = e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
    // the viewers of the items have their own keys
    const in_viewer = !!e.target.closest?.('.qa-media-viewer');
    const go = action => { e.preventDefault(); action(); };
    if (!in_viewer && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return go(() => choose(nextStep(steps, step, e.key === 'ArrowRight' ? 1 : -1)));
    if (!in_viewer && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && focus_items.length > 0) return go(() => {
      const i = focus_items.findIndex(item => sampleKey(item) === focus_sample);
      const next = focus_items[Math.max(0, Math.min(focus_items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      setFocus({ key: focus_key, sample: sampleKey(next) });
      root_element?.querySelector(`${selector('key', focus_key)} ${selector('sample', sampleKey(next))} button`)?.focus();
    });
    if (in_viewer) return;
    if (e.key === ' ' && focus_key) return go(() => setFlipped(f => !f));
    if (e.key === 'e' && focus_sample) return go(() => setFocus({ key: focus_key, sample: focus_sample, evolution: !(focus.key === focus_key && focus.evolution) }));
    if (e.key === 'f' && focus_sample) return go(() => setFocus({ key: focus_key, sample: focus_sample, open: true }));
    if (e.key === '?') return go(() => setHelp(true));
    if (e.key === 'Escape' && (focus.evolution || focus.open)) return go(() => setFocus({ evolution: false, open: false }));
  };

  const wide = width >= WIDE;
  const contents = <Contents
    groups={groups} pinned={pinned} model={model_new} collapsed={collapsed} total={keys.length}
    onToggleGroup={group => toggleGroup(project_key, group)} onPin={key => togglePin(project_key, key)} onJump={jump}
    filter={filter} setFilter={setFilter}
  />;
  const key_width = wide ? width - 236 : width;
  const key_props = {
    model_new, model_ref, step, output_new, output_ref: compared ? output_ref : undefined, names, colors, onStep: choose,
    focus, setFocus, flipped, onPin: key => togglePin(project_key, key), width: key_width,
    viewer_props: { ...props, labels: labels_, manifests, style, onControlsChange },
  };
  const following = chosen === undefined;

  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keyboard shortcuts of the items inside
  return <div ref={root} role="region" aria-label="Logged media" data-testid="logged-media" onKeyDown={onKeyDown} className="qa-logged-media">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, marginBottom: 4 }}>
      {output_new?.is_running && <Tag minimal intent="primary" icon="pulse">Live</Tag>}
      <span className={Classes.TEXT_MUTED} data-testid="media-summary">{summary(model_new)}</span>
      {compared && !model_ref?.items.length && <span className={Classes.TEXT_MUTED}>· nothing logged in {names.ref}</span>}
    </div>
    <div style={{ position: 'sticky', top: 'var(--qa-sticky-top, 0px)', zIndex: 6, background: 'var(--qa-surface, #fff)', padding: '28px 0 6px', marginBottom: 8, borderBottom: '1px solid var(--qa-border, rgba(128, 128, 128, 0.18))' }}>
      <div style={{ position: 'absolute', top: 2, left: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
        <span>Step <strong data-testid="media-step" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatStep(step)}</strong></span>
        {chosen !== undefined && chosen !== step && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>(chosen: {formatStep(chosen)})</span>}
        <Button size="small" variant="minimal" icon="chevron-left" aria-label="Previous step" disabled={step === steps[0]} onClick={() => choose(nextStep(steps, step, -1))}/>
        <Button size="small" variant="minimal" icon="chevron-right" aria-label="Next step" disabled={step === steps.at(-1)} onClick={() => choose(nextStep(steps, step, 1))}/>
        <Tooltip content="The last step, following the run while it logs more" compact>
          <Button size="small" variant="minimal" icon="fast-forward" active={following} onClick={() => choose(undefined)} text="Latest"/>
        </Tooltip>
        <Tooltip content="Keyboard shortcuts (?)" compact>
          <Button size="small" variant="minimal" icon="key-command" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}/>
        </Tooltip>
      </div>
      <Timeline
        rows={shown_keys.map(key => ({ key, kind: model_new.keys[key].kind, steps: model_new.keys[key].steps }))}
        steps={steps} ref_steps={ref_steps} step={step} onStep={choose} preview={preview} names={names} colors={colors}
        series={series_name ? series?.series[series_name] : null} series_names={series_names} series_name={series_name} onSeriesChange={setSeriesChoice}
      />
    </div>
    <div style={wide ? { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 16, alignItems: 'start' } : undefined}>
      {wide
        ? <div style={{ position: 'sticky', top: 'calc(var(--qa-sticky-top, 0px) + 130px)', maxHeight: 'calc(100vh - var(--qa-sticky-top, 0px) - 150px)', overflowY: 'auto' }}>{contents}</div>
        : <div style={{ marginBottom: 8 }}>
          <Button size="small" variant="minimal" icon={contents_open ? 'chevron-down' : 'chevron-right'} onClick={() => setContentsOpen(open => !open)} aria-expanded={contents_open}>
            Contents <span className={Classes.TEXT_MUTED}>({keys.length})</span>
          </Button>
          {(contents_open || needle) && <div style={{ padding: '4px 0 0 8px', maxWidth: 420 }}>{contents}</div>}
          {!contents_open && !needle && keys.length > FILTER_FROM && <InputGroup size="small" leftIcon="search" placeholder="Filter keys" aria-label="Filter keys" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 180, display: 'inline-block', marginLeft: 8 }}/>}
        </div>}
      <div style={{ minWidth: 0 }}>
        {shown_keys.map(key => <Lazy key={key} height={estimated_height(model_new.keys[key], !!model_ref)}>
          <MediaKey name={key} pinned={pinned.has(key)} {...key_props}/>
        </Lazy>)}
        {needle && matching.length === 0 && <span className={Classes.TEXT_MUTED}>No key matches "{filter}".</span>}
        {!needle && shown_keys.length === 0 && <span className={Classes.TEXT_MUTED}>All the groups are collapsed.</span>}
      </div>
    </div>
    <Dialog isOpen={help} onClose={() => setHelp(false)} title="Logged media: keyboard" icon="key-command" style={{ width: 420 }}>
      <DialogBody>
        <table className={`${Classes.HTML_TABLE} ${Classes.COMPACT}`} style={{ width: '100%' }}>
          <tbody>{HELP.map(([keys, what]) => <tr key={keys}><td><kbd className={Classes.KEY}>{keys}</kbd></td><td>{what}</td></tr>)}</tbody>
        </table>
        <p className={Classes.TEXT_MUTED} style={{ marginTop: 8, fontSize: 12 }}>The step is the same for every run of the page, and the address shares it, with the sample you're on.</p>
      </DialogBody>
    </Dialog>
  </div>;
};

export default LoggedMedia;
