// Tabs for the landing page's sections (WAI-ARIA tabs pattern, automatic activation): the arrow keys move between
// them, Home and End go to the ends. Spread the props on a tablist, its tab buttons and the one tabpanel.
import {useId, useRef, useState, type KeyboardEvent} from 'react';

export function useTabs(count: number, label: string) {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const select = (index: number) => {
    const next = (index + count) % count;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: count - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      select(moves[event.key]);
    }
  };
  return {
    selected,
    tabListProps: {role: 'tablist', 'aria-label': label, onKeyDown},
    tabProps: (index: number) => ({
      ref: (element: HTMLButtonElement | null) => {
        tabs.current[index] = element;
      },
      type: 'button' as const,
      role: 'tab',
      id: `${id}-tab-${index}`,
      'aria-selected': index === selected,
      'aria-controls': `${id}-panel`,
      tabIndex: index === selected ? 0 : -1,
      onClick: () => setSelected(index),
    }),
    panelProps: {role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab-${selected}`},
  };
}
