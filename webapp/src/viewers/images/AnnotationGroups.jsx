// The groups of annotations of an image, e.g. the workspaces of an annotation app: users pick those they see, and open
// them in the app. What's hidden is the same for every viewer of the page, not saved.
import { AnchorButton, Button, Checkbox, Popover, Tag } from '@blueprintjs/core';
import { create } from 'zustand';

export const useHiddenGroupsStore = create(set => ({
  // { [set id]: [group ids] }
  hidden: {},
  toggle: (set_id, group) => set(state => {
    const hidden = state.hidden[set_id] ?? [];
    return { hidden: { ...state.hidden, [set_id]: hidden.includes(group) ? hidden.filter(g => g !== group) : [...hidden, group] } };
  }),
  only: (set_id, group, groups) => set(state => ({ hidden: { ...state.hidden, [set_id]: groups.filter(g => g !== group) } })),
  showAll: set_id => set(state => ({ hidden: { ...state.hidden, [set_id]: [] } })),
}));

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// groups: [{ id, label, detail?, url?, count }], noun: what they are, e.g. "workspace"
export const AnnotationGroups = ({ set_id, groups, noun = 'group', source }) => {
  const hidden = useHiddenGroupsStore(state => state.hidden[set_id]) ?? [];
  const toggle = useHiddenGroupsStore(state => state.toggle);
  const only = useHiddenGroupsStore(state => state.only);
  const showAll = useHiddenGroupsStore(state => state.showAll);
  if (groups.length === 0) return null;
  const shown = groups.filter(group => !hidden.includes(group.id));
  const ids = groups.map(group => group.id);
  const content = <div className="qaboard-annotation-groups">
    <div className="qaboard-annotation-groups-header">
      <span>{plural(groups.length, noun)} in {source}</span>
      {hidden.length > 0 && <Button size="small" variant="minimal" text="Show all" onClick={() => showAll(set_id)} />}
    </div>
    {groups.map(group => <div key={group.id} className="qaboard-annotation-group">
      <Checkbox
        checked={!hidden.includes(group.id)}
        onChange={() => toggle(set_id, group.id)}
        labelElement={<span title={group.detail}>
          {group.label}
          {group.detail && <span className="qaboard-muted"> · {group.detail}</span>}
        </span>}
      />
      <Tag minimal round title={plural(group.count, 'annotation')}>{group.count}</Tag>
      <Button size="small" variant="minimal" icon="eye-open" title={`Only the annotations of ${group.label}`} onClick={() => only(set_id, group.id, ids)} />
      {group.url && <AnchorButton size="small" variant="minimal" icon="share" href={group.url} target="_blank" rel="noopener noreferrer" title={`Open ${group.label} in ${source}`} />}
    </div>)}
  </div>;
  // in the viewer: else it wouldn't show in full screen
  return <Popover content={content} placement="bottom-start" usePortal={false}>
    <Button
      size="small"
      variant="minimal"
      endIcon="caret-down"
      intent={hidden.length > 0 ? 'warning' : 'none'}
      text={hidden.length > 0 ? `${shown.length} of ${plural(groups.length, noun)}` : plural(groups.length, noun)}
      title={`The ${noun}s of these annotations: pick those you see, open them in ${source}`}
    />
  </Popover>;
};
