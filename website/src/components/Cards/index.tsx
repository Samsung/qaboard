// Link cards, to send readers to the next page that fits what they want to do. In MDX, without an import:
//   <Cards>
//     <Card title="Compare images" to="/docs/user-guide/image-viewer">Side by side, wipe, difference, pixel values.</Card>
//   </Cards>
// `eyebrow` is a short label above the title, like who the page is for. The whole card is clickable.
import React, {type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

export function Cards({children}: {children: ReactNode}) {
  return <ul className={styles.cards}>{children}</ul>;
}

export function Card({title, to, eyebrow, children}: {title: string; to: string; eyebrow?: string; children?: ReactNode}) {
  return (
    <li className={styles.card}>
      {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
      <Link to={to} className={styles.title}>
        {title}
      </Link>
      {children && <div className={styles.text}>{children}</div>}
    </li>
  );
}
