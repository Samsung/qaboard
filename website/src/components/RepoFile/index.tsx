// A file of the repository in a code block: <RepoFile path="charts/qaboard/kind.yaml" />.
// The build imports the file itself (website/plugins/snippets/remark.js adds `source`), so the docs can't drift from it.
// - title: what the reader saves it as (default: the path)
// - lines: the lines to show, e.g. "3-10" or "1-4,9" (1-based); highlight: lines to highlight in what's shown, e.g. "2,4-5"
// - untested: for files no CI of ours runs (e.g. GitLab CI or Jenkins examples, under website/snippets/)
import React from 'react';
import CodeBlock from '@theme/CodeBlock';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

export type RepoFileProps = {
  /** Relative to the repository's root; must be a literal */
  path: string;
  /** Added at build time */
  source?: string;
  title?: string;
  language?: string;
  lines?: string;
  highlight?: string;
  untested?: boolean;
};

const REPOSITORY = 'https://github.com/Samsung/qaboard/blob/master/';

const LANGUAGES: [RegExp, string][] = [
  [/\.ya?ml$/, 'yaml'],
  [/\.(sh|bash)$/, 'bash'],
  [/\.py$/, 'python'],
  [/\.json$/, 'json'],
  [/\.toml$/, 'toml'],
  [/(^|\/)Jenkinsfile$/, 'groovy'],
  [/(^|\/)Dockerfile$/, 'docker'],
];

function languageOf(path: string) {
  return LANGUAGES.find(([re]) => re.test(path))?.[1] ?? 'text';
}

/** "3-10,12" → the lines 3 to 10 and 12, 1-based. Throws on ranges outside the file, so the build fails. */
export function selectLines(source: string, spec: string | undefined, path: string) {
  const all = source.replace(/\n$/, '').split('\n');
  if (!spec)
    return all.join('\n');
  const picked: string[] = [];
  for (const part of spec.split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    const [start, end] = match ? [Number(match[1]), Number(match[2] ?? match[1])] : [NaN, NaN];
    if (!match || start < 1 || end < start || end > all.length)
      throw new Error(`<RepoFile path="${path}" lines="${spec}">: "${part}" isn't a range of lines in this ${all.length}-line file`);
    picked.push(...all.slice(start - 1, end));
  }
  return picked.join('\n');
}

export default function RepoFile({path, source, title, language, lines, highlight, untested = false}: RepoFileProps) {
  if (source === undefined)
    throw new Error(`<RepoFile path="${path}">: no source, is website/plugins/snippets/remark.js in this content plugin's remarkPlugins?`);
  const code = selectLines(source, lines, path);
  return (
    <div className={styles.repoFile}>
      <CodeBlock language={language ?? languageOf(path)} title={title ?? path} metastring={highlight ? `{${highlight}}` : undefined}>
        {code}
      </CodeBlock>
      <p className={styles.footer}>
        {untested ? (
          <span className={styles.untested}>Not run in our CI: adapt it to your setup.</span>
        ) : (
          <>
            {lines ? 'From ' : 'Source: '}
            <Link href={`${REPOSITORY}${path}`}>
              <code>{path}</code>
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
