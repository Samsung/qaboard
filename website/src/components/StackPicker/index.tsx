// Sets every stack-dependent tab group of the site at once: <StackPicker />, or <StackPicker groups={['server', 'ci']} />.
// See docs-media/README.md#stackpicker. The groups and their values are in ../stack.ts.
//
// Pages use plain Docusaurus tabs (<Tabs groupId="server" queryString>). Docusaurus tabs pick their value from the
// URL query (?server=k8s) first, then from their storage slot (docusaurus.tab.server). A choice here writes both,
// so every tab group on the page switches, later pages remember it, and a copied link carries it.
import React, {useCallback, useEffect, useId} from 'react';
import clsx from 'clsx';
import {useHistory} from '@docusaurus/router';
import {useHistorySelector, useStorageSlot} from '@docusaurus/theme-common';
import {STACK_GROUPS, defaultValue, storageKey, type StackGroup, type StackGroupInfo} from '../stack';
import styles from './styles.module.css';

export type StackPickerProps = {
  /** The groups to show, in this order; default: all of them */
  groups?: StackGroup[];
  /** One line, without the explanation: for the top of a short page */
  compact?: boolean;
};

const isValid = (group: StackGroupInfo, value: string | null): value is string =>
  value !== null && group.options.some(option => option.value === value);

/** The group's value: the URL's, then the stored one, then the default. Defaults on the server and at hydration. */
export function useStackValue(group: StackGroupInfo) {
  // The server snapshot has no query string, so the first render matches the static HTML
  const queryValue = useHistorySelector(history => new URLSearchParams(history.location.search).get(group.id));
  const [storedValue, slot] = useStorageSlot(storageKey(group.id));
  const value = isValid(group, queryValue) ? queryValue : isValid(group, storedValue) ? storedValue : defaultValue(group);

  // Docusaurus tabs read the URL but don't store it: store it, so the next pages follow the link's choice
  useEffect(() => {
    if (isValid(group, queryValue) && queryValue !== storedValue)
      slot.set(queryValue);
  }, [group, queryValue, storedValue, slot]);

  const history = useHistory();
  const setValue = useCallback(
    (newValue: string) => {
      slot.set(newValue);
      const params = new URLSearchParams(history.location.search);
      params.set(group.id, newValue);
      history.replace({...history.location, search: `?${params.toString()}`});
    },
    [group.id, history, slot],
  );
  return [value, setValue] as const;
}

function GroupControl({group, compact}: {group: StackGroupInfo; compact: boolean}) {
  const [value, setValue] = useStackValue(group);
  const name = useId();
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{group.label}</legend>
      <div className={clsx(styles.options, compact && styles.optionsCompact)}>
        {group.options.map(option => (
          <label key={option.value} className={styles.option}>
            <input
              type="radio"
              className={styles.input}
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => setValue(option.value)}
            />
            <span className={styles.pill}>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function StackPicker({groups, compact = false}: StackPickerProps) {
  const titleId = useId();
  const shown = groups ? groups.map(id => STACK_GROUPS.find(group => group.id === id)) : STACK_GROUPS;
  const unknown = groups?.filter((_, idx) => !shown[idx]);
  if (unknown?.length)
    throw new Error(`<StackPicker groups>: unknown group(s) ${unknown.join(', ')}; use ${STACK_GROUPS.map(g => g.id).join(', ')}`);
  return (
    <section className={clsx(styles.picker, compact && styles.compact)} aria-labelledby={titleId}>
      <div className={styles.header}>
        <div id={titleId} className={styles.title}>
          Your stack
        </div>
        {!compact && <p className={styles.hint}>The steps below follow your choices, on this page and the next ones.</p>}
      </div>
      <div className={styles.groups}>
        {(shown as StackGroupInfo[]).map(group => (
          <GroupControl key={group.id} group={group} compact={compact} />
        ))}
      </div>
    </section>
  );
}
