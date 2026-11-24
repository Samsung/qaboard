// What a run logged at its steps besides numbers (run.log() in Python, qaboard/media.py): images, audio, video,
// tables, histograms, texts... Design: docs/design/logged-media.md.
// - one timeline for all the keys, sticky: a tick per logged step, the run's main series behind, the reference's steps
// - each key shows its items at the greatest step <= the selected one, next to the reference's same samples (matched by
//   id, else caption, else position), and says so when an item comes from another step (keys.jsx)
// - the step is the same for all the cards of the page (controls.media_step, in the URL), the key and sample users are
//   on, and the evolution strip, are the card's (controls.media_focus, with the run's id): the address shares them
// While the run goes on, new steps show up.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { Button, Callout, Classes, Dialog, DialogBody, Tag, Tooltip } from "@blueprintjs/core";

import { useLabels } from "../../hooks";
import { plot_colors } from "../../sideColors";
import { useIsDark } from "../../theme";
import { usePrefsStore } from "../../stores/prefs";
import { ViewerError, ViewerLoading } from "../ViewerStates";
import { parse_series, sorted_keys } from "../series/series";
import { useWidth } from "../audio/hooks";
import { useMediaContext } from "./context";
import { slotSize } from "./ImageGrid";
import Timeline from "./Timeline";
import Contents, { FILTER_FROM, KeysFilter } from "./Contents";
import { MediaKey } from "./keys";
import { cleanFocus, formatStep, groupKeys, itemAt, mediaStepFor, mediaSteps, nextStep, orderedItems, sampleKey, summary } from "./media";
import { useMediaModel, useRunText } from "./useMediaModel";
import { MEDIA_SHORTCUTS, useMediaKeys } from "./useMediaKeys";
import "./media.css";

// cards at least that wide show the contents on the side
const WIDE = 900;
const no_pins = {};
const SERIES_FILES = ['series.json', 'series.jsonl'];
const selector = (name, value) => `[data-${name}="${globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&')}"]`;

// The run's series, to draw one behind the timeline: the loss by default
const useRunSeries = (output, manifest) => {
  const path = manifest ? SERIES_FILES.find(file => manifest[file]) : undefined;
  const query = useRunText(path ? output : undefined, path);
  return useMemo(() => {
    if (typeof query.data !== 'string') return null;
    try {
      return parse_series(query.data);
    } catch {
      return null;
    }
  }, [query.data]);
};
export const defaultSeries = names => names.find(name => /(^|[/_.])loss$/i.test(name)) ?? names.find(name => /loss/i.test(name)) ?? names[0] ?? null;

// The sticky header's height, for what scrolls into view below it (scroll.js)
const useHeight = () => {
  const [element, setElement] = useState(null);
  const [height, setHeight] = useState(null);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setHeight(Math.round(element.getBoundingClientRect().height)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, height];
};

const EmptyState = ({ running }) => <Callout compact icon="media" title={running ? "The run hasn't logged media yet" : 'The run logged no media'}>
  Log images, audio, tables... at a step, and they show here, next to the reference run's:
  <pre style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`run.log({"val/samples": [qaboard.Image(img, caption=name, id=name) for img, name in batch]}, step=step)
run.log({"weights/fc1": qaboard.Histogram(model.fc1.weight)}, step=step)`}</pre>
</Callout>;

// Keys are drawn when they come near the screen: runs log dozens. Until then, a placeholder of about their size, with
// the key's name: jumping to a key far below scrolls to its placeholder, which then draws it.
const Lazy = ({ name, height, children }) => {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '600px', fallbackInView: true });
  return <div ref={ref} data-key={name} style={{ scrollMarginTop: 'calc(var(--qa-sticky-top, 0px) + var(--qa-media-sticky, 120px))', ...(inView ? {} : { minHeight: height }) }}>{inView && children}</div>;
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
  const [sticky, sticky_height] = useHeight();

  const compared = !!output_ref && output_ref.id !== output_new?.id;
  const { model: model_new, query: query_new } = useMediaModel(output_new, undefined, path);
  // without the reference's media (or an error), we show the new run's alone
  const { model: model_ref, query: query_ref } = useMediaModel(compared ? output_ref : undefined, undefined, path_ref ?? path);
  const series = useRunSeries(output_new, manifests?.new);

  const steps = model_new?.steps;
  // the steps either run logged at: each key shows its own nearest earlier step, in each run
  const all_steps = useMemo(() => mediaSteps(model_new, model_ref), [model_new, model_ref]);
  const chosen = onControlsChange ? media_step : own_step;
  const step = mediaStepFor(model_new, model_ref, chosen);
  // from the address: anything
  const focus = onControlsChange ? (media_focus?.run === output_new?.id ? cleanFocus(media_focus) : {}) : own_focus;

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

  const choose = value => onControlsChange ? onControlsChange({ media_step: value }) : setOwnStep(value);
  const setFocus = change => {
    const next = { ...focus, ...change };
    if (onControlsChange) onControlsChange({ media_focus: { ...next, run: output_new.id } });
    else setOwnFocus(next);
  };
  // the key and sample the keyboard acts on: the one users are on, else the first images
  const image_keys = model_new ? Object.keys(model_new.keys).filter(key => model_new.keys[key].kind === 'image') : [];
  const focus_key = focus.key && model_new?.keys[focus.key] ? focus.key : image_keys[0];
  const focus_items = focus_key ? orderedItems(model_new.keys[focus_key], itemAt(model_new, focus_key, step).step) : [];
  const focus_sample = focus.key === focus_key && focus.sample ? focus.sample : focus_items[0] ? sampleKey(focus_items[0], focus_items) : null;
  const keys_props = useMediaKeys({
    root: root_element, steps: all_steps, step, choose, focus, setFocus, focus_key, focus_items, focus_sample, selector,
    flip: () => setFlipped(f => !f), openHelp: () => setHelp(true),
  });

  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  // isLoading, not isPending: a reference whose file can't be asked for (no URL) is never fetched, and stays pending
  if (!model_new || (compared && query_ref.isLoading)) return <ViewerLoading height={style?.height}/>;
  const new_keys = Object.keys(model_new.keys);
  if (new_keys.length === 0) return <EmptyState running={output_new?.is_running}/>;
  // the keys of both runs: those only the reference logged are shown too, they're what the new run stopped logging
  const ref_only = Object.keys(model_ref?.keys ?? {}).filter(key => !model_new.keys[key]);
  const keys = [...new_keys, ...ref_only];
  const entries = {};
  for (const key of new_keys) entries[key] = model_new.keys[key];
  for (const key of ref_only) entries[key] = { ...model_ref.keys[key], only_ref: true };

  const names = { new: labels?.new ?? 'new', reference: labels?.reference ?? 'reference' };
  const colors = plot_colors(labels, is_dark);
  const pinned = new Set(Object.keys(pins).filter(key => entries[key]));
  const needle = filter.trim().toLowerCase();
  const matching = needle ? keys.filter(key => key.toLowerCase().includes(needle)) : keys;
  const groups = groupKeys(matching.filter(key => !pinned.has(key)), key => entries[key]?.kind);
  const shown_keys = [...[...pinned].filter(key => matching.includes(key)), ...groups.flatMap(({ group, keys }) => collapsed[group] ? [] : keys)];
  const series_names = series ? sorted_keys(Object.keys(series.series)) : [];
  const series_name = series_choice === undefined ? defaultSeries(series_names) : series_choice;
  const shown_images = shown_keys.filter(key => model_new.keys[key]?.kind === 'image');

  const preview = at => {
    for (const key of shown_images) {
      const items = model_new.keys[key].by_step.get(at);
      if (items) return { src: fileUrl(output_new, items[0].path), label: `${key}${items[0].caption ? ` · ${items[0].caption}` : ''}` };
    }
    const logged = shown_keys.filter(key => entries[key].by_step.has(at));
    return { label: logged.length ? logged.join(', ') : 'nothing logged' };
  };
  const jump = key => {
    if (pinned.has(key) || !collapsed[groupKeys([key])[0].group]) {
      root_element?.querySelector(selector('key', key))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else toggleGroup(project_key, groupKeys([key])[0].group);
    setFocus({ key });
  };

  const wide = width >= WIDE;
  const contents = <Contents
    groups={groups} pinned={pinned} entries={entries} names={names} collapsed={collapsed} total={keys.length}
    onToggleGroup={group => toggleGroup(project_key, group)} onPin={key => togglePin(project_key, key)} onJump={jump}
    filter={filter} setFilter={setFilter}
  />;
  const key_props = {
    model_new, model_ref, step, output_new, output_ref: compared ? output_ref : undefined, labels, names, colors, onStep: choose,
    focus, setFocus, flipped, onPin: key => togglePin(project_key, key), width: wide ? width - 236 : width,
    viewer_props: { ...props, labels: labels_, manifests, style, onControlsChange },
  };
  const following = chosen === undefined;
  const step_controls = <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, fontSize: 13, minWidth: 0 }}>
    <span style={{ whiteSpace: 'nowrap', marginRight: 2 }}>Step <strong data-testid="media-step" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatStep(step)}</strong></span>
    {chosen !== undefined && chosen !== step && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>(chosen: {formatStep(chosen)})</span>}
    <Button size="small" variant="minimal" icon="chevron-left" aria-label="Previous step" disabled={step === all_steps[0]} onClick={() => choose(nextStep(all_steps, step, -1))}/>
    <Button size="small" variant="minimal" icon="chevron-right" aria-label="Next step" disabled={step === all_steps.at(-1)} onClick={() => choose(nextStep(all_steps, step, 1))}/>
    <Tooltip content="The last step, following the run while it logs more" compact>
      <Button size="small" variant="minimal" icon="fast-forward" active={following} onClick={() => choose(undefined)} text="Latest"/>
    </Tooltip>
    <Tooltip content="Keyboard shortcuts (?)" compact>
      <Button size="small" variant="minimal" icon="help" onClick={() => setHelp(true)} text="Shortcuts" aria-keyshortcuts="?"/>
    </Tooltip>
  </div>;

  return <div
    ref={root} role="region" aria-label="Logged media" data-testid="logged-media" className="qa-logged-media"
    // its width is the card's, not its content's: the timeline and grids are drawn to the width measured
    style={{ minWidth: 0, contain: 'inline-size', '--qa-media-sticky': sticky_height ? `${sticky_height}px` : undefined }}
    {...keys_props}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, marginBottom: 4 }}>
      {output_new?.is_running && <Tag minimal intent="primary" icon="pulse">Live</Tag>}
      <span className={Classes.TEXT_MUTED} data-testid="media-summary">{summary(model_new)}</span>
      {compared && !model_ref?.items.length && <span className={Classes.TEXT_MUTED}>· nothing logged in {names.reference}</span>}
      {ref_only.length > 0 && <Tooltip content={ref_only.join(', ')} compact>
        <Tag minimal size="small" intent="warning" icon="warning-sign">{ref_only.length} {ref_only.length === 1 ? 'key' : 'keys'} not logged by {names.new}</Tag>
      </Tooltip>}
    </div>
    <div ref={sticky} style={{ position: 'sticky', top: 'var(--qa-sticky-top, 0px)', zIndex: 6, background: 'var(--qa-surface, #fff)', padding: '4px 0 6px', marginBottom: 8, borderBottom: '1px solid var(--qa-border, rgba(128, 128, 128, 0.18))' }}>
      <Timeline
        header={step_controls}
        rows={shown_keys.map(key => ({ key, kind: entries[key].kind, steps: entries[key].steps, only_ref: entries[key].only_ref }))}
        steps={steps} ref_steps={model_ref?.steps ?? []} choices={all_steps} step={step} onStep={choose} preview={preview} names={names} colors={colors}
        series={series_name ? series?.series[series_name] : null} series_names={series_names} series_name={series_name} onSeriesChange={setSeriesChoice}
      />
    </div>
    <div style={wide ? { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 16, alignItems: 'start' } : undefined}>
      {wide
        ? <div style={{ position: 'sticky', top: 'calc(var(--qa-sticky-top, 0px) + var(--qa-media-sticky, 120px) + 10px)', maxHeight: 'calc(100vh - var(--qa-sticky-top, 0px) - var(--qa-media-sticky, 120px) - 20px)', overflowY: 'auto' }}>{contents}</div>
        : <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Button size="small" variant="minimal" icon={contents_open ? 'chevron-down' : 'chevron-right'} onClick={() => setContentsOpen(open => !open)} aria-expanded={contents_open}>
            Contents <span className={Classes.TEXT_MUTED}>({keys.length})</span>
          </Button>
          {!contents_open && !needle && keys.length > FILTER_FROM && <KeysFilter filter={filter} setFilter={setFilter} style={{ width: 180 }}/>}
          {(contents_open || needle) && <div style={{ padding: '4px 0 0 8px', maxWidth: 420, flexBasis: '100%' }}>{contents}</div>}
        </div>}
      <div style={{ minWidth: 0 }}>
        {shown_keys.map(key => <Lazy key={key} name={key} height={estimated_height(entries[key], !!model_ref && !entries[key].only_ref)}>
          <MediaKey name={key} pinned={pinned.has(key)} {...key_props}/>
        </Lazy>)}
        {needle && matching.length === 0 && <span className={Classes.TEXT_MUTED}>No key matches "{filter}".</span>}
        {!needle && shown_keys.length === 0 && <span className={Classes.TEXT_MUTED}>All the groups are collapsed.</span>}
      </div>
    </div>
    <Dialog isOpen={help} onClose={() => setHelp(false)} title="Logged media: keyboard" icon="help" style={{ width: 420, maxWidth: 'calc(100vw - 32px)' }}>
      <DialogBody>
        <table className={`${Classes.HTML_TABLE} ${Classes.COMPACT}`} style={{ width: '100%' }}>
          <tbody>{MEDIA_SHORTCUTS.map(([keys, what]) => <tr key={keys}><td><kbd className={Classes.KEY}>{keys}</kbd></td><td>{what}</td></tr>)}</tbody>
        </table>
        <p className={Classes.TEXT_MUTED} style={{ marginTop: 8, fontSize: 12 }}>Click in the section, then use the keys. The step is the same for every run of the page, and the address shares it, with the sample you're on.</p>
      </DialogBody>
    </Dialog>
  </div>;
};

export default LoggedMedia;
