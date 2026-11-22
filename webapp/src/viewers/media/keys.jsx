// One key of the "Logged media" section: its header, and what it logged at the step next to the reference's, with a
// renderer per kind. A key only the reference logged (what the new run stopped logging) is shown by the same
// renderers, the reference's items alone, and says so.
import { lazy, Suspense, useState } from "react";
import { AnchorButton, Button, ButtonGroup, Classes, Icon, Tag, Tooltip } from "@blueprintjs/core";

import { OutputViewer } from "../OutputViewer";
import { ViewerLoading } from "../ViewerStates";
import { useMediaContext } from "./context";
import { KIND_ICONS } from "./kinds";
import ImageGrid from "./ImageGrid";
import BoxControls, { boxCounts, NO_BOX_FILTERS } from "./BoxControls";
import { STICKY_MARGIN, useScrollIntoView } from "./scroll";
import { boxRegions, formatStep, itemAt, matchItem, orderedItems, sampleKey } from "./media";

const LoadableTableView = lazy(() => import('./TableView'));
const LoadableHistogramView = lazy(() => import('./HistogramView'));
const LoadableEvolutionStrip = lazy(() => import('./EvolutionStrip'));

const caption_of = item => item.caption ?? item.id ?? `#${item.index ?? 0}`;
// the texts: the key titles them, and answers are long lines
const TEXT_PROPS = { hide_filename: true, word_wrap: true };

// The key's name, kind, the steps it shows when they aren't the one selected, and its actions
export const KeyHeader = ({ name, kind, step, step_new, step_ref, only_ref, names, pinned, onPin, actions }) => <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: '2px 6px', fontSize: 13, marginBottom: 6, minHeight: 24 }}>
  <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minHeight: 24 }}>
    <Icon icon={KIND_ICONS[kind] ?? 'document'} size={12} title={kind} className={Classes.TEXT_MUTED}/>
    <strong style={{ overflowWrap: 'anywhere' }}>{name}</strong>
    {only_ref && <Tooltip content={`${names.reference} logged this key, ${names.new} didn't: shown is ${names.reference}'s`} compact>
      <Tag minimal size="small" intent="warning" icon="warning-sign">Not logged by {names.new}</Tag>
    </Tooltip>}
    {only_ref
      ? step_ref !== null && <Tag minimal size="small" icon={step_ref !== step ? 'history' : undefined}>{names.reference} at step {formatStep(step_ref)}</Tag>
      : <>
        {step_new !== null && step_new !== step && <Tooltip content={`Nothing logged at step ${formatStep(step)}: the last before it`} compact>
          <Tag minimal size="small" icon="history">from step {formatStep(step_new)}</Tag>
        </Tooltip>}
        {step_ref !== undefined && step_new !== null && (step_ref === null
          ? <Tag minimal size="small">not in {names.reference} yet</Tag>
          : step_ref !== step_new && <Tag minimal size="small" icon="history">{names.reference} from step {formatStep(step_ref)}</Tag>)}
      </>}
  </div>
  <div style={{ flex: 'none', display: 'flex', marginLeft: 'auto' }}>
    {actions}
    <Tooltip content={pinned ? 'Unpin' : 'Pin on top, for this project'} compact>
      <Button size="small" variant="minimal" icon={pinned ? 'unpin' : 'pin'} aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} onClick={() => onPin(name)} active={pinned}/>
    </Tooltip>
  </div>
</div>;

// Images: a grid of thumbnails over the reference's, box controls, the evolution strip and the image viewer under the
// sample's row
const ImageKey = ({ name, items_new, items_ref, step_new, model_new, model_ref, output_new, output_ref, names, colors, onStep, focus, setFocus, flipped, width, viewer, box_filters, setBoxFilters, only_ref }) => {
  const is_focused = focus.key === name;
  const opened = is_focused && focus.open && focus.sample ? matchItem(focus.sample, items_new).item : null;
  const evolving = !only_ref && is_focused && focus.evolution && focus.sample ? focus.sample : null;
  const opened_ref = useScrollIntoView(opened);
  const side_by_side = items_new.length === 1 && !!items_ref && width >= 560;
  const size = items_new.length === 1 ? Math.min(320, Math.floor((width - 10) / (side_by_side ? 2 : 1))) : width < 520 ? 110 : 150;
  const counts = boxCounts([...items_new, ...(items_ref ?? [])], box_filters);
  const opened_sample = opened ? sampleKey(opened, items_new) : null;
  const expanded = [
    evolving && <LoadableEvolutionStrip
      key="evolution"
      name={name} sample={evolving} model_new={model_new} model_ref={model_ref} output_new={output_new} output_ref={output_ref}
      step={step_new} onStep={onStep} onClose={() => setFocus({ evolution: false })} names={names} colors={colors} filters={box_filters}
    />,
    opened && <div key="viewer" ref={opened_ref} style={{ margin: '4px 0 8px', scrollMarginTop: STICKY_MARGIN }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
        <Icon icon="zoom-in" size={12}/><strong>{caption_of(opened)}</strong>
        <span style={{ flex: 1 }}/>
        <Button size="small" variant="minimal" icon="cross" aria-label="Close the image" onClick={() => setFocus({ open: false })}/>
      </div>
      {viewer(opened, items_ref ? matchItem(opened, items_ref, items_new).item : null)}
    </div>,
  ].filter(Boolean);
  return <>
    <BoxControls items={[...items_new, ...(items_ref ?? [])]} filters={box_filters} onChange={setBoxFilters} counts={counts}/>
    <ImageGrid
      items_new={items_new} items_ref={items_ref} output_new={output_new} output_ref={output_ref} names={names} colors={colors}
      size={size} width={width} side_by_side_room={side_by_side} filters={box_filters} badges={!counts.uniform}
      flipped={is_focused && flipped} focused={is_focused ? focus.sample : null}
      onOpen={sample => setFocus({ key: name, sample, open: !(is_focused && focus.open && focus.sample === sample) })}
      onEvolution={only_ref ? undefined : sample => setFocus({ key: name, sample, evolution: !(evolving === sample) })}
      // under the row of the sample they're about: the strip of the sample users are on, the image they opened
      expanded={expanded.length ? { sample: evolving ?? opened_sample, content: expanded } : null}
    />
  </>;
};

// Texts: against the reference at the step, or against the run's previous step
const TextKey = ({ entry, items_new, items_ref, step_new, step_ref, output_new, output_ref, names, labels, viewer }) => {
  const [against, setAgainst] = useState('reference');
  const previous_step = entry.steps[entry.steps.indexOf(step_new) - 1];
  const previous = previous_step !== undefined ? entry.by_step.get(previous_step) : null;
  const shown = against === 'previous' && previous ? 'previous' : 'reference';
  // the text viewer says what it compares with: "step 10", not "reference"
  const compared_with = (name_new, name_ref) => ({ ...TEXT_PROPS, compared_to: name_ref, labels: labels ? { ...labels, new: name_new, reference: name_ref } : undefined });
  return <>
    <ButtonGroup size="small" style={{ marginBottom: 4 }}>
      <Button active={shown === 'reference'} disabled={!items_ref} onClick={() => setAgainst('reference')} text={`vs ${names.reference}`}/>
      <Button active={shown === 'previous'} disabled={!previous} onClick={() => setAgainst('previous')} text={previous_step !== undefined ? `vs step ${formatStep(previous_step)}` : 'vs previous step'}/>
    </ButtonGroup>
    {items_new.map(item => shown === 'previous'
      ? viewer(item, matchItem(item, previous, items_new).item, output_new, compared_with(`step ${formatStep(step_new)}`, `step ${formatStep(previous_step)}`))
      : viewer(item, items_ref ? matchItem(item, items_ref, items_new).item : null, output_ref, step_ref !== undefined && step_ref !== null && step_ref !== step_new ? compared_with(names.new, `${names.reference} at step ${formatStep(step_ref)}`) : TEXT_PROPS))}
  </>;
};

// Sounds: one in the full viewer; several at a step, compact rows (play, A/B), one opened in the full viewer at a time
const AudioKey = props => {
  const { name, items_new, items_ref, focus, setFocus, viewer } = props;
  const ref_of = item => items_ref ? matchItem(item, items_ref, items_new).item : null;
  if (items_new.length === 1) return <OtherKey {...props}/>;
  const opened = focus.key === name && focus.open && focus.sample ? focus.sample : null;
  return items_new.map(item => {
    const sample = sampleKey(item, items_new);
    const ref = ref_of(item);
    const caption = caption_of(item);
    return opened === sample
      ? <div key={sample}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <strong>{caption}</strong><span style={{ flex: 1 }}/>
            <Button size="small" variant="minimal" icon="minimize" aria-label="Back to the list" onClick={() => setFocus({ open: false })}/>
          </div>
          {viewer(item, ref, undefined, { caption, caption_ref: ref?.caption })}
        </div>
      : viewer(item, ref, undefined, { compact: true, caption, onExpand: () => setFocus({ key: name, sample, open: true }) });
  });
};

const TableKey = ({ items_new, items_ref, step_new, output_new, output_ref, names, viewer_props }) =>
  <LoadableTableView key={step_new} item_new={items_new[0]} item_ref={items_ref?.[0]} output_new={output_new} output_ref={output_ref} names={names}
    identity={{ new: viewer_props.manifests?.new, reference: viewer_props.manifests?.reference }}/>;

const HistogramKey = ({ entry, entry_ref, step_new, step_ref, onStep, colors, names }) =>
  <LoadableHistogramView entry_new={entry} entry_ref={entry_ref} step={step_new} step_ref={step_ref} onStep={onStep} colors={colors} names={names}/>;

// Videos, HTML, plots, files: the app's viewer of each
const OtherKey = ({ items_new, items_ref, names, viewer }) => items_new.map(item => {
  const ref = items_ref ? matchItem(item, items_ref, items_new).item : null;
  return <div key={sampleKey(item, items_new)}>
    {item.path ? viewer(item, ref) : <span className={Classes.TEXT_MUTED}>No file.</span>}
    {(item.caption || ref?.caption) && <div className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
      {item.caption}{ref?.caption && ref.caption !== item.caption && <> ({names.reference}: {ref.caption})</>}
    </div>}
  </div>;
});

const RENDERERS = { image: ImageKey, text: TextKey, audio: AudioKey, table: TableKey, histogram: HistogramKey };

// One key: what it logged at the step, and the reference's. The props are the section's (LoggedMedia).
export const MediaKey = ({ name, model_new, model_ref, step, output_new, output_ref, viewer_props, labels, names: names_, colors: colors_, onStep, focus, setFocus, flipped, pinned, onPin, width }) => {
  const { Viewer: CustomViewer, fileUrl } = useMediaContext();
  const Viewer = CustomViewer ?? OutputViewer;
  const [box_filters, setBoxFilters] = useState(NO_BOX_FILTERS);
  const only_ref = !model_new.keys[name];
  const entry = (only_ref ? model_ref : model_new).keys[name];
  const kind = entry.kind;
  const at_new = itemAt(model_new, name, step);
  const at_ref = model_ref ? itemAt(model_ref, name, step) : null;
  // a key only the reference logged: its items, alone, in the reference's name and color
  const shown = only_ref
    ? { at: at_ref, at_ref: null, output_new: output_ref, output_ref: undefined, names: { new: names_.reference, reference: names_.reference }, colors: { new: colors_.reference, reference: colors_.reference }, model_new: model_ref, model_ref: null }
    : { at: at_new, at_ref, output_new, output_ref, names: names_, colors: colors_, model_new, model_ref };
  // in a stable order: loaders shuffle, a sample stays where it was first seen
  const items_new = orderedItems(entry, shown.at.step);
  const items_ref = shown.at_ref ? orderedItems(shown.model_ref.keys[name], shown.at_ref.step) : null;
  // items in viewers don't take the section's keys
  const viewer = (item, ref, ref_output = shown.output_ref, extra = {}) => <div className="qa-media-viewer" key={sampleKey(item, items_new)}>
    <Viewer
      {...viewer_props}
      {...extra}
      output_new={shown.output_new}
      output_ref={ref ? ref_output : undefined}
      path={item.path}
      path_ref={ref?.path}
      // the image viewer draws a set of regions over every image it shows: each side's boxes are a set of their own
      boxes={kind === 'image' ? boxRegions(item, box_filters) : undefined}
      boxes_ref={kind === 'image' && ref ? boxRegions(ref, box_filters) : undefined}
    />
  </div>;

  let content;
  if (shown.at.step === null) {
    content = <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
      {only_ref ? `${names_.reference} logs it from step ${formatStep(entry.steps[0])}.` : `Not logged yet at step ${formatStep(step)}: from step ${formatStep(entry.steps[0])}.`}
    </span>;
  } else {
    const Renderer = RENDERERS[kind] ?? OtherKey;
    content = <Renderer
      name={name} entry={entry} entry_ref={shown.model_ref?.keys[name]} items_new={items_new} items_ref={items_ref}
      step_new={shown.at.step} step_ref={shown.at_ref?.step} model_new={shown.model_new} model_ref={shown.model_ref}
      output_new={shown.output_new} output_ref={shown.output_ref} names={shown.names} colors={shown.colors} labels={only_ref ? undefined : labels}
      onStep={onStep} focus={focus} setFocus={setFocus} flipped={flipped} width={width} viewer={viewer} viewer_props={viewer_props}
      box_filters={box_filters} setBoxFilters={setBoxFilters} only_ref={only_ref}
    />;
  }

  const first = items_new[0];
  const download = first?.path && kind !== 'histogram' ? fileUrl(shown.output_new, first.path) : null;
  const actions = <>
    {kind === 'image' && !only_ref && items_new.length > 0 && <Tooltip content="Across the steps (e)" compact>
      <Button size="small" variant="minimal" icon="film" aria-label={`Evolution of ${name}`} onClick={() => setFocus({ key: name, sample: focus.key === name && focus.sample ? focus.sample : sampleKey(first, items_new), evolution: !(focus.key === name && focus.evolution) })}/>
    </Tooltip>}
    {download && <Tooltip content="Download the file" compact>
      <AnchorButton size="small" variant="minimal" icon="download" aria-label={`Download ${name}`} href={download} download target="_blank" rel="noopener noreferrer"/>
    </Tooltip>}
  </>;
  return <section aria-label={name} data-testid="media-key" data-only-ref={only_ref || undefined} style={{ marginBottom: 18 }}>
    <KeyHeader
      name={name} kind={kind} step={step} step_new={shown.at.step} step_ref={only_ref ? shown.at.step : at_ref ? at_ref.step : undefined}
      only_ref={only_ref} names={names_} pinned={pinned} onPin={onPin} actions={actions}
    />
    <Suspense fallback={<ViewerLoading height={120}/>}>{content}</Suspense>
  </section>;
};
