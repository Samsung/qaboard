// What went wrong in an export, from the server (backend/export_problems.py): one entry per kind of problem, not per
// file, with what to do. No tracebacks: admins find them from the reference, in the server's logs and in Sentry.
import { Button, Classes, Tag } from "@blueprintjs/core";

import { copyWithToast } from "../utils/clipboard";
import { reportUrl, scrubUrl } from "../errors";

// QA-Board's own issue tracker, the default support address, is public: reports there would show the folders' paths
const public_tracker = /^https:\/\/github\.com\/samsung\/qaboard\/issues\/?$/i;

const files = n => `${n} ${n === 1 ? 'file' : 'files'}`;

// What users send admins: enough to find the logs, and to understand without them
export const problemsReport = result => [
  `Page: ${scrubUrl(window.location.href)}`,
  result.reference && `Reference: ${result.reference}`,
  `Folder: ${result.folder}`,
  `As: ${result.type === 'copy' ? 'copies' : 'links'}`,
  `Exported: ${result.nb_files_exported}, failed: ${result.nb_failed}${result.nb_not_attempted ? `, not tried: ${result.nb_not_attempted}` : ''}`,
  ...(result.problems ?? []).map(p => `- ${p.message} (${files(p.count)}, ${p.step} as ${p.actor}, ${p.code})${p.examples?.[0] ? `. E.g. ${p.examples[0].to}: ${p.examples[0].error}` : ''}`),
  `Time: ${(result.at ?? new Date()).toISOString()}`,
].filter(Boolean).join('\n');

export const ExportProblems = ({ result, support_url }) => {
  const problems = result.problems ?? [];
  if (!problems.length) return null;
  const report = problemsReport(result);
  return <div aria-label="What went wrong">
    <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
      {problems.map((p, index) => <li key={index} style={{ marginBottom: 6 }}>
        <strong>{p.message}</strong> <Tag minimal round>{files(p.count)}</Tag>
        <div>{p.hint}</div>
        {p.examples?.length > 0 && <details style={{ marginTop: 2 }}>
          <summary className={Classes.TEXT_MUTED} style={{ cursor: 'pointer' }}>Examples</summary>
          <ul style={{ margin: '2px 0', paddingLeft: 18, fontSize: 12 }}>
            {p.examples.map((e, i) => <li key={i} style={{ wordBreak: 'break-all' }}>
              <code>{e.to}</code>{e.side ? ` (${e.side})` : ''}: <span className={Classes.TEXT_MUTED}>{e.error}</span>
            </li>)}
          </ul>
        </details>}
      </li>)}
    </ul>
    {result.nb_not_attempted > 0 && <p style={{ margin: '4px 0' }}>
      QA-Board stopped after the first {files(result.nb_failed)} failed: the other {files(result.nb_not_attempted)} weren't tried.
    </p>}
    <p style={{ margin: '6px 0 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {result.reference && <span>Reference <code>{result.reference}</code>: your QA-Board admins find the details with it.</span>}
      <Button size="small" variant="minimal" icon="duplicate" text="Copy the details" onClick={() => copyWithToast(report, { what: 'the details' })}/>
      {support_url && !public_tracker.test(support_url) && <a href={reportUrl(support_url, { subject: 'An export failed', body: report })} target="_blank" rel="noopener noreferrer">Report it</a>}
    </p>
  </div>;
};
