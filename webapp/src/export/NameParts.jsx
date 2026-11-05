// Exported files' names, in color: each part (input, settings, file, region, new or reference) has its color, the same
// in the example at the top of the dialog, the list of what each part says, and the preview's list of files.
// Colors aren't the only cue: the example says each part's name under it, and each part says what it is on hover.
import { Classes } from "@blueprintjs/core";

// What users call the fields
export const FIELD_LABELS = {
  input: 'input',
  input_name: "input's name",
  settings: 'settings',
  file: 'file',
  region: 'region',
  side: 'new or reference',
  platform: 'platform',
  commit: 'commit',
  batch: 'batch',
  run: 'run id',
};

// The color of each field. `sides`: the colors of the new and reference results on the page (labels.colors)
export const field_color = (field, side, sides) => {
  if (field === 'input' || field === 'input_name') return 'var(--qa-text)';
  if (field === 'settings') return 'var(--qa-export-settings)';
  if (field === 'file') return 'var(--qa-export-file)';
  if (field === 'region') return 'var(--qa-export-region)';
  if (field === 'side') return side === 'reference' ? (sides?.reference?.css ?? 'var(--qa-side-1)') : (sides?.new?.css ?? 'var(--qa-side-0)');
  return 'var(--qa-text-secondary)';
};
const field_weight = field => field === 'input' || field === 'input_name' || field === 'side' ? 600 : undefined;

// A name as colored parts: [{text, field, folder?}] (export/names.js render_parts)
export const NameParts = ({ parts, side, sides }) => <>
  {parts.map((part, index) => part.field
    ? <span key={index} title={FIELD_LABELS[part.field]} style={{ color: field_color(part.field, side, sides), fontWeight: field_weight(part.field) }}>{part.text}</span>
    : <span key={index} className={Classes.TEXT_MUTED} style={part.folder ? { fontWeight: 600, padding: '0 1px' } : undefined}>{part.text}</span>)}
</>;

// The example name, large, with each part's name under it
export const NameAnatomy = ({ parts, side, sides }) => <div aria-label="Example name" style={{
  display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', rowGap: 6, padding: '10px 12px 6px', borderRadius: 4,
  background: 'var(--qa-surface-alt)', border: '1px solid var(--qa-border)', fontFamily: 'var(--bp-typography-family-mono, monospace)', fontSize: 14,
}}>
  {parts.map((part, index) => <span key={index} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
    <span style={part.field
      ? { color: field_color(part.field, side, sides), fontWeight: field_weight(part.field), wordBreak: 'break-all', padding: '1px 3px', borderRadius: 3, boxShadow: `inset 0 -2px 0 ${field_color(part.field, side, sides)}` }
      : { color: 'var(--qa-text-muted)', fontWeight: part.folder ? 700 : undefined, padding: '1px 0' }}>
      {part.text}
    </span>
    <span aria-hidden="true" style={{ fontFamily: 'var(--bp-typography-family-sans, sans-serif)', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap', color: part.field ? field_color(part.field, side, sides) : 'transparent', opacity: 0.9 }}>
      {part.field ? FIELD_LABELS[part.field] : part.folder ? 'folder' : '.'}
    </span>
  </span>)}
</div>;

// A colored dot, for the list of what each part says
export const FieldDot = ({ field, side, sides, muted }) => <span aria-hidden="true" style={{
  display: 'inline-block', width: 8, height: 8, borderRadius: 4, flex: '0 0 8px', marginTop: 6,
  background: muted ? 'var(--qa-border)' : field_color(field, side, sides),
}}/>;
