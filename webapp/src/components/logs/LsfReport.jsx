import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Callout, Classes, Intent, Tag, Tooltip } from "@blueprintjs/core";

import { siteConfigQuery } from "../../api/queries";
import { lsfHeadline, lsfHint, lsfHintDocs, lsfKilled, lsfNearMemoryLimit, lsfReason } from "./lsf";


const DEFAULT_DOCS_ROOT = 'https://samsung.github.io/qaboard/'

// Sites can host their own docs. Until we know, we link to the public docs.
const useDocsRoot = () => useQuery(siteConfigQuery).data?.docs_root ?? DEFAULT_DOCS_ROOT


// Renders `code` in hints
export const withCode = text => (text ?? '').split('`').map((part, index) => index % 2
  ? <code key={index} className={Classes.CODE}>{part}</code>
  : <React.Fragment key={index}>{part}</React.Fragment>)


const failed = report => !report.successful && (report.exited || report.term_reason !== null)


// A tag summarizing why LSF ended the job, e.g. "LSF: out of memory".
// When jobs exit with an error by themselves, their logs say more than LSF.
const LsfTag = ({ report, onClick }) => {
  if (!lsfKilled(report)) return null
  return <Tooltip content={<div style={{ maxWidth: '400px' }}>
    <p style={{ marginBottom: 4 }}><strong>{lsfHeadline(report)}</strong></p>
    {report.term_reason && <p style={{ marginBottom: 4 }}>{report.term_reason}: {report.term_message}</p>}
    {lsfHint(report) && <p style={{ marginBottom: 0 }}>{withCode(lsfHint(report))}</p>}
  </div>}>
    <Tag intent={Intent.DANGER} minimal interactive={!!onClick} onClick={onClick} icon="warning-sign">
      LSF: {lsfReason(report)}
    </Tag>
  </Tooltip>
}


const ResourceTag = ({ label, value, intent }) => <Tag minimal intent={intent} style={{ marginRight: '5px', marginBottom: '5px' }}>
  {label}: <strong>{value}</strong>
</Tag>


// What LSF says about the job: why it ended, where it ran, what it used.
const LsfReport = ({ report }) => {
  const docs_root = useDocsRoot()
  if (!report) return null
  const is_failed = failed(report)
  const hint = lsfHint(report)
  const docs = lsfHintDocs(report)
  const near_memory_limit = lsfNearMemoryLimit(report)
  const { resources } = report
  const memory = resources['Max Memory']
    ? `${resources['Max Memory']}${resources['Total Requested Memory'] ? ` / ${resources['Total Requested Memory']} requested` : ''}`
    : null
  return <Callout
    compact
    intent={is_failed ? Intent.DANGER : undefined}
    icon={is_failed ? "error" : "info-sign"}
    title={<>LSF: {lsfHeadline(report)}{report.term_reason ? ` · ${report.term_reason}` : ''}</>}
    style={{ marginBottom: '8px', maxWidth: '1400px' }}
  >
    {report.term_message && <p style={{ marginBottom: '5px' }}>{report.term_message}</p>}
    {hint && <p style={{ marginBottom: '5px' }}>
      <strong>{withCode(hint)}</strong>
      {docs && <> <a href={`${docs_root}${docs}`} target="_blank" rel="noopener noreferrer">Read the docs</a></>}
    </p>}
    <div>
      {report.job_id && <ResourceTag label="Job" value={report.job_id} />}
      {report.hosts.length > 0 && <ResourceTag label="Host" value={report.hosts.join(' ')} />}
      {report.queue && <ResourceTag label="Queue" value={report.queue} />}
      {resources['Run time'] && <ResourceTag label="Run time" value={resources['Run time']} />}
      {resources['CPU time'] && <ResourceTag label="CPU time" value={resources['CPU time']} />}
      {memory && <ResourceTag label="Max memory" value={memory} intent={near_memory_limit ? Intent.WARNING : undefined} />}
      {resources['Max Threads'] && <ResourceTag label="Threads" value={resources['Max Threads']} />}
      {report.started_at && <ResourceTag label="Started" value={report.started_at} />}
      {report.terminated_at && <ResourceTag label="Ended" value={report.terminated_at} />}
    </div>
  </Callout>
}


export { LsfReport, LsfTag };
