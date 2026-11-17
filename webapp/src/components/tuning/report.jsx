// What the Tuning Analysis reports share: the layout, how values read, the parameters' ranges and impact, and running or
// copying a set of parameters. For OptimizationReport.jsx (automated tunings) and TuningReport.jsx (the others).
import styled from "styled-components";
import { Button, Classes, HTMLTable, Menu, MenuItem, PopoverNext, Tag, Tooltip, Intent } from "@blueprintjs/core";

import { format } from "../../utils";
import { updateSelected } from "../../hooks";
import { usePrefsStore } from "../../stores/prefs";
import { copyWithToast } from "../../utils/clipboard";
import { position, as_json, as_yaml } from "./optimization";

export const plot_config = { displayModeBar: 'hover', displaylogo: false, showSendToCloud: false, showLink: false, responsive: true };

// 4 significant digits: enough to tell values apart, few enough to read
export const num = value => typeof value === 'number' ? format(value, { precision: 4 }) : JSON.stringify(value);
// a parameter's value: categories exactly as configured (99.999 isn't "100"), numbers rounded
export const value_text = (value, dimension) => {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (dimension?.type === 'categorical' || typeof value !== 'number') return JSON.stringify(value);
  return Number.isInteger(value) ? String(value) : num(value);
};
// the parameters of an evaluation, in a plot's tooltip
export const hover_params = (params, space) => {
  const dimensions = Object.fromEntries(space.map(d => [d.name, d]));
  return Object.entries(params).map(([k, v]) => `${k}: ${dimensions[k] ? value_text(v, dimensions[k]) : JSON.stringify(v)}`).join('<br>');
};
export const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
export const Code = ({ children }) => <code className={Classes.MONOSPACE_TEXT}>{children}</code>;

// a metric's display: label, value with its scale and suffix
export const metric_label = (available_metrics, key) => available_metrics?.[key]?.label ?? key;
export const metric_value = (available_metrics, key, value) => {
  const info = available_metrics?.[key] ?? {};
  if (typeof value !== 'number') return '—';
  return `${format(value * (info.scale ?? 1), { precision: 3 })}${info.suffix ?? ''}`;
};

export const Report = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* wide tables scroll inside their section, instead of widening the page */
  > * { min-width: 0; }
  .qa-optim-section > header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 2px; }
  .qa-optim-section h3 { margin: 0; font-size: 15px; display: flex; align-items: center; gap: 8px; }
  .qa-optim-section > p.qa-optim-how { margin: 0 0 10px; font-size: 13px; }
  .qa-optim-num { font-variant-numeric: tabular-nums; }
`;

export const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 16px;
  h2 { margin: 0 0 4px; font-size: 18px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .qa-optim-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; }
  /* an icon and its text; the sampler's span is inside its tooltip's target */
  .qa-optim-meta > span, .qa-optim-meta > a, .qa-optim-meta > .${Classes.POPOVER_TARGET} > span { display: inline-flex; align-items: center; gap: 5px; }
`;

export const Tiles = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  .value { font-size: 24px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .detail { font-size: 12px; margin-top: 2px; }
`;

export const Columns = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(280px, 4fr);
  gap: 16px;
  @media (max-width: 1100px) { grid-template-columns: minmax(0, 1fr); }
`;

export const Small = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  .qa-optim-small h4 { margin: 0; font-size: 13px; display: flex; justify-content: space-between; gap: 8px; }
`;

// Wide tables scroll sideways inside it. width: 0 + min-width: 100% takes the container's width without widening the page:
// the commit page sizes its content to fit, so a plain overflow: auto would still push it wider.
export const Scroll = styled.div`
  width: 0;
  min-width: 100%;
  overflow-x: auto;
`;

export const ParamTable = styled(HTMLTable)`
  width: 100%;
  && td, && th { vertical-align: middle; }
  td.qa-optim-best { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.qa-optim-name { white-space: nowrap; }
`;


// Where the best value sits in its range, and every value the search tried
export const RangeBar = ({ dimension, values, best }) => {
  const width = 200, height = 26, pad = 6;
  if (dimension.type === 'categorical') {
    const counts = new Map(dimension.choices.map(c => [JSON.stringify(c), 0]));
    values.forEach(v => counts.set(JSON.stringify(v), (counts.get(JSON.stringify(v)) ?? 0) + 1));
    return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {dimension.choices.map(choice => {
        const is_best = JSON.stringify(choice) === JSON.stringify(best);
        return <Tooltip key={JSON.stringify(choice)} content={`Tried in ${plural(counts.get(JSON.stringify(choice)) ?? 0, 'evaluation')}`} hoverOpenDelay={200}>
          <Tag minimal={!is_best} intent={is_best ? Intent.PRIMARY : Intent.NONE} round>
            {value_text(choice, dimension)} <span className={is_best ? undefined : Classes.TEXT_MUTED}>×{counts.get(JSON.stringify(choice)) ?? 0}</span>
          </Tag>
        </Tooltip>;
      })}
    </div>;
  }
  const x = v => pad + Math.min(1, Math.max(0, position(dimension, v) ?? 0)) * (width - 2 * pad);
  const best_x = typeof best === 'number' ? x(best) : null;
  return <svg width={width} height={height + 12} role="img" aria-label={`Range ${num(dimension.low)} to ${num(dimension.high)}${dimension.log ? ', log scale' : ''}, best ${num(best)}`} style={{ overflow: 'visible', display: 'block' }}>
    <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} stroke="var(--qa-border)" strokeWidth={4} strokeLinecap="round"/>
    {values.filter(v => typeof v === 'number').map((v, i) => <line key={i} x1={x(v)} x2={x(v)} y1={height / 2 - 5} y2={height / 2 + 5} stroke="var(--qa-text-muted)" strokeOpacity={0.45} strokeWidth={1}/>)}
    {best_x !== null && <circle cx={best_x} cy={height / 2} r={6} fill="var(--qa-intent-primary)" stroke="var(--qa-surface)" strokeWidth={2}/>}
    <text x={pad} y={height + 10} fontSize={10} fill="var(--qa-text-muted)">{num(dimension.low)}</text>
    <text x={width - pad} y={height + 10} fontSize={10} fill="var(--qa-text-muted)" textAnchor="end">{num(dimension.high)}{dimension.log ? ' (log)' : ''}</text>
  </svg>;
};

export const ImportanceBar = ({ value, missing = "Shown after 8 evaluations, with 2 parameters or more" }) => {
  if (typeof value !== 'number') return <Tooltip content={missing} hoverOpenDelay={200}><span className={Classes.TEXT_MUTED}>—</span></Tooltip>;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 110 }}>
    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--qa-border)', overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.max(2, value * 100)}%`, height: '100%', background: 'var(--qa-intent-primary)', borderRadius: 3 }}/>
    </div>
    <span className="qa-optim-num" style={{ width: 34, textAlign: 'right' }}>{Math.round(value * 100)}%</span>
  </div>;
};


// "Run these parameters": Run Tests / Tuning, with them filled in as the values to try
export const useTryParameters = (project, label) => {
  const updateTuning = usePrefsStore(state => state.updateTuning);
  return params => {
    updateTuning(project, {
      search_type: 'grid',
      parameter_search: JSON.stringify(params, null, 2),
      experiment_name: `${label}-best`,
    });
    updateSelected({ selected_views: 'tuning' });
  };
};

export const CopyMenu = ({ params, what = 'the best parameters' }) => <PopoverNext
  placement="bottom-end"
  content={<Menu>
    <MenuItem icon="code" text="As preset_params, for another tuning" onClick={() => copyWithToast(`preset_params:\n${as_yaml(params)}\n`, { what })}/>
    <MenuItem icon="code-block" text="As JSON, for qa --tuning" onClick={() => copyWithToast(as_json(params), { what })}/>
  </Menu>}
>
  <Button icon="duplicate" endIcon="caret-down" text="Copy"/>
</PopoverNext>;


export const InsightList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  > li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 2px 10px; padding: 10px 2px; border-bottom: 1px solid var(--qa-border); align-items: start; }
  > li:last-child { border-bottom: none; }
  > li > .bp6-icon { margin-top: 2px; }
  .qa-insight-title { font-weight: 600; }
  .qa-insight-text { margin: 2px 0 0; }
`;

export const intents = { warning: Intent.WARNING, success: Intent.SUCCESS, primary: Intent.PRIMARY, none: Intent.NONE };

