// The groups of annotations of an image, e.g. the workspaces of an annotation app, next to the set's name above the
// regions: users toggle those they see (remembered, for every image), and open them in the app. Each has the color of
// its outlines. By default, users see theirs.
import { AnchorButton, Button, Checkbox, Icon, Popover } from '@blueprintjs/core';

import { usePrefsStore } from '../../stores/prefs';
import { isGroupShown } from './regionProviders';

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
// chips shown inline, the others in the menu
const INLINE = 3;

export const useGroupChoices = source => {
  const choices = usePrefsStore(state => state.annotationGroups?.[source]);
  const setChoices = usePrefsStore(state => state.setAnnotationGroups);
  return [choices, next => setChoices(source, next)];
};

const describe = (group, shown) => [
  `${group.label}${group.detail ? ` (${group.detail})` : ''}: ${plural(group.count, 'annotation')}`,
  group.mine ? 'Yours: shown unless you hide it' : null,
  `Click to ${shown ? 'hide' : 'show'} its annotations, on every image`,
].filter(Boolean).join('\n');

const Chip = ({ group, shown, onToggle }) => <button
  type="button"
  className={`qaboard-group-chip ${shown ? 'qaboard-group-shown' : ''}`}
  style={{ '--group-color': group.color }}
  aria-pressed={shown}
  title={describe(group, shown)}
  onClick={onToggle}
>
  <span className="qaboard-group-swatch" />
  <span className="qaboard-group-label">{group.label}</span>
  {group.mine && <Icon icon="person" size={10} />}
  <span className="qaboard-group-count">{group.count}</span>
</button>;

// groups: [{ id, label, detail?, url?, count, color, mine? }], noun: what they are, e.g. "workspace"
export const AnnotationGroups = ({ source, groups, noun = 'group', label }) => {
  const [choices, setChoices] = useGroupChoices(source);
  if (groups.length === 0) return null;
  const shown = group => isGroupShown(group, choices);
  const toggle = group => setChoices({ [group.id]: !shown(group) });
  const count = groups.filter(shown).length;
  const all = value => setChoices(Object.fromEntries(groups.map(group => [group.id, value])));
  const menu = <div className="qaboard-annotation-groups">
    <div className="qaboard-annotation-groups-header">
      <span>{plural(groups.length, noun)} annotated this input in {label}</span>
      <span>
        <Button size="small" variant="minimal" text="All" disabled={count === groups.length} onClick={() => all(true)} />
        <Button size="small" variant="minimal" text="None" disabled={count === 0} onClick={() => all(false)} />
      </span>
    </div>
    {groups.map(group => <div key={group.id} className="qaboard-annotation-group" style={{ '--group-color': group.color }}>
      <Checkbox
        checked={shown(group)}
        onChange={() => toggle(group)}
        labelElement={<span title={describe(group, shown(group))}>
          <span className="qaboard-group-swatch" />
          {group.label}
          {group.detail && <span className="qaboard-muted"> · {group.detail}</span>}
          {group.mine && <span className="qaboard-muted"> · yours</span>}
        </span>}
      />
      <span className="qaboard-group-count" title={plural(group.count, 'annotation')}>{group.count}</span>
      <Button size="small" variant="minimal" icon="eye-open" title={`Only ${group.label}`} onClick={() => setChoices(Object.fromEntries(groups.map(g => [g.id, g.id === group.id])))} />
      {group.url && <AnchorButton size="small" variant="minimal" icon="share" href={group.url} target="_blank" rel="noopener noreferrer" title={`Open ${group.label} in ${label}`} />}
    </div>)}
    <div className="qaboard-annotation-groups-footer qaboard-muted">
      Remembered in this browser, for every image. Until you pick, you see yours.
    </div>
  </div>;
  return <span className="qaboard-annotation-groups-inline">
    {groups.slice(0, INLINE).map(group => <Chip key={group.id} group={group} shown={shown(group)} onToggle={() => toggle(group)} />)}
    {/* in the viewer: else it wouldn't show in full screen */}
    <Popover content={menu} placement="bottom-start" usePortal={false} minimal>
      <Button
        size="small"
        variant="minimal"
        endIcon="caret-down"
        text={groups.length > INLINE ? `+${groups.length - INLINE}` : undefined}
        title={`${count} of ${plural(groups.length, noun)} shown: pick them, open them in ${label}`}
      />
    </Popover>
  </span>;
};
