// One sample across every step it was logged at, as a filmstrip: the new run's above, the reference's below (its own
// nearest earlier step, labeled when it isn't the same). Clicking a frame selects its step.
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Classes } from "@blueprintjs/core";

import { useMediaContext } from "./context";
import { Thumbnail, slotSize } from "./ImageGrid";
import { evolution, formatStep, itemAt, matchItem } from "./media";

const SIZE = 104;
const GAP = 6;

const EvolutionStrip = ({ name, sample, model_new, model_ref, output_new, output_ref, step, onStep, onClose, names, colors, filters }) => {
  const { fileUrl } = useMediaContext();
  const scroll = useRef(null);
  const frames = evolution(model_new, name, sample).filter(frame => frame.item);
  const first = frames.find(frame => frame.item)?.item;
  const slot = slotSize(first, null, SIZE);
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: frames.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => SIZE + GAP,
    overscan: 6,
    initialRect: { width: 800, height: 300 },
  });
  const selected = frames.findIndex(frame => frame.step === step);
  useEffect(() => {
    if (selected >= 0) virtualizer.scrollToIndex(selected, { align: 'center' });
  }, [selected, virtualizer]);
  const label = first?.caption ?? first?.id ?? sample;
  const row_height = 18 + slot.height + (model_ref ? slot.height + 20 : 0) + 4;
  return <div data-testid="evolution-strip" style={{ border: '1px solid rgba(128, 128, 128, 0.25)', borderRadius: 3, padding: '4px 6px 6px', margin: '4px 0 10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 4 }}>
      <strong>{label}</strong>
      <span className={Classes.TEXT_MUTED}>across {frames.length} steps</span>
      <span style={{ flex: 1 }}/>
      <Button size="small" variant="minimal" icon="cross" aria-label="Close the evolution strip" onClick={onClose}/>
    </div>
    {frames.length === 0 ? <span className={Classes.TEXT_MUTED}>This sample isn't in the run.</span>
      : <div ref={scroll} style={{ overflowX: 'auto', overflowY: 'hidden', height: row_height + 14 }}>
        <div style={{ width: virtualizer.getTotalSize(), height: row_height, position: 'relative' }}>
          {virtualizer.getVirtualItems().map(virtual => {
            const { step: frame_step, item } = frames[virtual.index];
            const at_ref = model_ref ? itemAt(model_ref, name, frame_step) : null;
            const ref = at_ref ? matchItem(item, at_ref.items).item : null;
            const is_selected = frame_step === step;
            return <div key={virtual.key} style={{ position: 'absolute', left: 0, top: 0, width: SIZE, transform: `translateX(${virtual.start}px)`, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: is_selected ? 700 : 400, color: is_selected ? '#f5498b' : undefined, height: 16 }}>{formatStep(frame_step)}</span>
              <Thumbnail src={fileUrl(output_new, item.path)} item={item} size={SIZE} selected={is_selected} filters={filters} onClick={() => onStep(frame_step)} title={`${names.new}, step ${frame_step}`}/>
              {model_ref && (ref
                ? <>
                  <Thumbnail src={fileUrl(output_ref, ref.path)} item={ref} size={SIZE} color={colors.ref} filters={filters} onClick={() => onStep(frame_step)} title={`${names.ref}, step ${at_ref.step}`}/>
                  <span className={Classes.TEXT_MUTED} style={{ fontSize: 10, height: 16 }}>{at_ref.step !== frame_step ? `${names.ref} @ ${formatStep(at_ref.step)}` : names.ref}</span>
                </>
                : <div className={Classes.TEXT_MUTED} style={{ height: slot.height + 18, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed rgba(128,128,128,0.35)' }}>—</div>)}
            </div>;
          })}
        </div>
      </div>}
  </div>;
};

export default EvolutionStrip;
