import React from 'react';
import Heading from '@theme/Heading';
import StatusBadge from './StatusBadge';
import styles from './RoadmapItem.module.css';

const slugify = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// One item of the roadmap page: its status, a title (with an anchor, to link to it from issues) and a description.
//   <RoadmapItem status="next" title="N-way comparisons">
//   Pick N commits... (Markdown)
//   </RoadmapItem>
export default function RoadmapItem({status, title, id, children}) {
  return (
    <div className={styles.item}>
      <div className={styles.status}><StatusBadge status={status} /></div>
      <div className={styles.body}>
        <Heading as="h3" id={id ?? slugify(title)} className={styles.title}>{title}</Heading>
        {children}
      </div>
    </div>
  );
}
