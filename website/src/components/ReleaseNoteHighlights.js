// The description and highlight cards of a release note (website/release-notes/*.md frontmatter).
// The web app shows the same cards in its "What's new" panel (webapp/src/releaseNotes/).
import React from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './ReleaseNoteHighlights.module.css';

const AUDIENCES = {
  'users': 'Users',
  'project-leads': 'Project leads',
  'admins': 'Admins',
};

// Highlight descriptions are plain text, with `code` spans
const withCode = text => text.split(/`([^`]+)`/).map((part, idx) => (idx % 2 ? <code key={idx}>{part}</code> : part));

export default function ReleaseNoteHighlights({frontMatter}) {
  const {description, version, highlights = []} = frontMatter;
  // Links are /docs/page-id. In the build for the web app, the docs are at the root of the /docs/ baseUrl
  const {siteConfig} = useDocusaurusContext();
  const resolve = link => (siteConfig.customFields.is_for_webapp ? link.replace(/^\/docs\//, '/') : link);
  return (
    <div className={styles.releaseNote}>
      {version && <span className={styles.version}>qaboard v{version}</span>}
      {description && <p className={styles.description}>{description}</p>}
      {highlights.length > 0 && (
        <div className={styles.grid}>
          {highlights.map((h, idx) => (
            <div key={idx} className={styles.card}>
              {h.audience && (
                <span className={`${styles.audience} ${styles[h.audience] ?? ''}`}>
                  {AUDIENCES[h.audience] ?? h.audience}
                </span>
              )}
              <h3 className={styles.title}>{h.title}</h3>
              <p className={styles.text}>{withCode(h.description)}</p>
              {h.link && <Link to={resolve(h.link)}>Learn more →</Link>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
