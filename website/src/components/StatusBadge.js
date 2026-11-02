import React from 'react';
import clsx from 'clsx';
import styles from './StatusBadge.module.css';

// The statuses of the roadmap (see website/STYLE.md). Docs pages can use the badge too, e.g. next to a heading:
//   import StatusBadge from '@site/src/components/StatusBadge';
//   <StatusBadge status="experimental" />
export const STATUSES = {
  shipped: {label: 'Shipped', description: 'Released and documented: use it today.'},
  experimental: {label: 'Experimental', description: 'Released, but may change without notice.'},
  next: {label: 'Next', description: "What we're building now or next."},
  exploring: {label: 'Exploring', description: 'We want it and are working out how. Tell us if you need it.'},
};

export default function StatusBadge({status}) {
  const info = STATUSES[status];
  if (!info) {
    // Fails the build instead of showing a wrong status
    throw new Error(`<StatusBadge status="${status}">: use one of ${Object.keys(STATUSES).join(', ')}`);
  }
  return (
    <span className={clsx(styles.badge, styles[status])} title={info.description}>
      {info.label}
    </span>
  );
}

// What each status means, as a compact legend
export function StatusLegend() {
  return (
    <dl className={styles.legend}>
      {Object.entries(STATUSES).map(([status, {description}]) => (
        <div key={status} className={styles.legendItem}>
          <dt><StatusBadge status={status} /></dt>
          <dd>{description}</dd>
        </div>
      ))}
    </dl>
  );
}
