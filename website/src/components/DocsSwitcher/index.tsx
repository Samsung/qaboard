// The docs' sections, one per audience, at the top of every docs sidebar (src/theme/DocSidebarItems).
// Docusaurus shows only the current sidebar: on a phone, the others were behind "← Back to main menu", then "Docs".
// Keep in sync with the "Docs" dropdown of the navbar (docusaurus.config.ts) and the sidebars (sidebars.ts).
import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useActiveDocContext, useLayoutDocsSidebar} from '@docusaurus/plugin-content-docs/client';
import {useNavbarMobileSidebar} from '@docusaurus/theme-common/internal';
import styles from './styles.module.css';

const sections = [
  {sidebarId: 'start', label: 'Get started', description: 'Try it, wrap a project, use cases'},
  {sidebarId: 'userGuide', label: 'User guide', description: 'Review results in the web app'},
  {sidebarId: 'docs', label: 'Project integration', description: 'qa, qaboard.yaml, runners, CI'},
  {sidebarId: 'admin', label: 'Admin', description: 'Run the QA-Board server'},
]

function Section({sidebarId, label, description, active}: (typeof sections)[number] & {active: boolean}): ReactNode {
  // The first page of the sidebar. In the default docs plugin: not the site docs' (site-docs/<site>/)
  const sidebar = useLayoutDocsSidebar(sidebarId, 'default')
  const mobileSidebar = useNavbarMobileSidebar()
  return (
    <li>
      <Link
        to={sidebar.link.path}
        className={clsx(styles.section, active && styles.active)}
        aria-current={active ? 'true' : undefined}
        onClick={() => mobileSidebar.shown && mobileSidebar.toggle()}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.description}>{description}</span>
      </Link>
    </li>
  )
}

export default function DocsSwitcher(): ReactNode {
  // Not useDocsSidebar(): on a phone, the sidebar is rendered in the navbar's menu, outside its context
  const current = useActiveDocContext('default').activeDoc?.sidebar
  // Only in the sidebars it lists (not in the site docs' own sidebar)
  if (!sections.some(s => s.sidebarId === current))
    return null
  return (
    <li className={styles.switcher}>
      <nav aria-label="Docs sections">
        <ul className={styles.list}>
          {sections.map(s => <Section key={s.sidebarId} {...s} active={s.sidebarId === current} />)}
        </ul>
      </nav>
    </li>
  )
}
