import { useSiteConfig, useUser } from "../hooks";
import { Button, Callout, Classes, Intent } from "@blueprintjs/core";
import { LoginHint } from "./authentication/login";

const formatDate = iso => {
  if (!iso) return null
  const date = new Date(iso)
  return isNaN(date) ? iso : date.toLocaleString()
}

// Tells users when they can't run from a commit's artifacts (redo, tuning), why, and how to get them back.
// `artifacts` is commit.artifacts from /api/v1/commit/<id>
export const ArtifactsCallout = ({ deleted, artifacts, waiting, onRestore }) => {
  const docs_root = useSiteConfig()?.docs_root ?? "/"
  const is_logged = useUser().is_logged
  const recreation = artifacts?.recreation
  const deletion = artifacts?.deletion
  const recreating = artifacts?.recreating ?? recreation?.status === 'triggered'
  // commits whose artifacts were never saved (e.g. projects that don't use `qa save-artifacts`) are not a problem
  const broken = artifacts?.ok === false && artifacts?.exists !== false
  // e.g. some files listed in the manifests are missing: runs may not need them, so we only warn
  const warnings = artifacts?.warnings ?? []
  if (!deleted && !broken && !recreating && warnings.length === 0) return null

  const problems = (artifacts?.problems ?? []).filter(p => p !== "The artifacts were deleted.")
  const title = recreating
    ? "This commit's artifacts are being recreated"
    : deleted ? "This commit's artifacts were deleted"
    : broken ? "This commit's artifacts are incomplete" : "Some of this commit's artifacts are missing"
  return <Callout
    icon={recreating ? "time" : "trash"}
    intent={recreating ? Intent.PRIMARY : Intent.WARNING}
    title={title}
    style={{marginBottom: '10px'}}
    data-testid="artifacts-callout"
  >
    {deletion?.at && <p>
      Deleted on {formatDate(deletion.at)}{deletion.by ? ` by ${deletion.by}` : ''}.
      {deletion.errors?.length > 0 && ` Some files could not be deleted.`}
    </p>}
    {(problems.length > 0 || warnings.length > 0) && <ul className={Classes.LIST}>
      {[...problems, ...warnings].map(p => <li key={p}>{p}</li>)}
    </ul>}
    {!deleted && !broken && !recreating && <p>You can still redo runs and start tuning, but runs that need these files will fail.</p>}
    {recreating && <p>
      Asked {recreation.via} on {formatDate(recreation.at)}{recreation.by ? ` (${recreation.by})` : ''}.{' '}
      {recreation.web_url && <a href={recreation.web_url} target="_blank" rel="noopener noreferrer">Follow the build</a>}
      {' '}Once it calls <code>qa save-artifacts</code>, you can redo runs and start tuning.
    </p>}
    {recreation?.status === 'failed' && <p className={Classes.INTENT_DANGER}>
      The last attempt to recreate the artifacts with {recreation.via} failed: {recreation.error}
    </p>}
    {artifacts?.recreate_errors?.length > 0 && <p className={Classes.INTENT_DANGER}>
      Fix <code>recreate_artifacts</code> in qaboard.yaml: {artifacts.recreate_errors.join(' ')}
    </p>}
    {!recreating && <p>
      {artifacts?.recreate
        ? <>QA-Board can ask {artifacts.recreate} to rebuild them. Redoing runs or starting tuning also does it.</>
        : <>QA-Board can restore the files from the source code, but not build outputs like binaries.{' '}
            To rebuild them automatically, configure <a href={`${docs_root}docs/storage/deleting-old-data#recreating-artifacts`} target="_blank" rel="noopener noreferrer"><code>recreate_artifacts</code></a> in qaboard.yaml.</>}
    </p>}
    {onRestore && <>
      <Button
        icon="redo"
        text={artifacts?.recreate ? (recreating ? "Ask again to recreate the artifacts" : "Recreate the artifacts") : "Restore the artifacts"}
        minimal={recreating}
        intent={recreating ? Intent.NONE : Intent.PRIMARY}
        disabled={!!waiting || !is_logged}
        onClick={onRestore}
      />
      {!is_logged && <LoginHint text="Log in to bring the artifacts back"/>}
    </>}
  </Callout>
}
