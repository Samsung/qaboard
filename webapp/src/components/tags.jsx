import { useState } from "react";
import {
  Alert,
  AnchorButton,
  Classes,
  Icon,
  Spinner,
  Tag,
  Menu,
  MenuItem,
  MenuDivider,
  PopoverNext,
  Intent,
  Tooltip,
  Button,
} from "@blueprintjs/core";

import { http, errorMessage, isAbort } from "../api/http";
import { useRefreshCommit, useSiteConfig } from "../hooks";
import { linux_to_windows } from '../utils'
import { folder_url, hasPathMappings } from '../utils/paths'
import { toaster } from "../toaster"
import { copyDirectory } from "./logs/DirectoryActions"
import { hidden_keys } from "../configurations/tokens"
import { ConfigurationsTags, ConfigurationDiff } from "../configurations/ConfigurationsTags"
import { runName } from "./logs/RunLogs"


const style_skeleton = {
  borderRadius: '2px',
  boxShadow: 'none !important',
  borderColor: 'rgba(206, 217, 224, 0.2) !important',
  background: 'rgba(206, 217, 224, 0.2)',
  backgroundClip: 'padding-box !important',
  animation: '1000ms linear infinite alternate skeleton-glow',
}


// A run's status, quiet when it went fine. The same width for all statuses: the names next to it line up.
const status_style = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 26 };
const StatusTag = ({output, style}) => {
  let status;
  if (output.is_failed)
    status = <Tag minimal intent={Intent.DANGER} icon="cross" aria-label="Failed"/>;
  else if (output.is_running)
    status = <Spinner size={12} aria-label="Running"/>;
  else if (output.is_pending)
    status = <Icon icon="time" size={12} className={Classes.TEXT_MUTED} aria-label="Pending"/>;
  else
    status = <Icon icon="tick-circle" size={12} intent={Intent.SUCCESS} aria-label="Succeeded"/>;
  const title = output.is_failed ? "Failed" : output.is_running ? "Running" : output.is_pending ? "Pending" : "Succeeded";
  return <span title={title} style={{ ...status_style, ...style }}>{status}</span>;
}

const PlatformTag = ({ platform, inverted }) => {
  if (platform === undefined || platform === null || platform === 'linux') return <span />
  return <Tag round minimal={!inverted} title="Platform the run used" style={{ marginRight: '5px', marginLeft: '5px' }}>@{platform}</Tag>
}

const MismatchTag = ({text, what, explanation}) => {
  return <div>
    <Tooltip content={<div>
        <h3>The reference run differs. Its {what}:</h3>
        <p>{explanation}</p>
      </div>}
    >
      <Tag intent={Intent.WARNING} icon="not-equal-to" style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>{text}</Tag>
    </Tooltip>
  </div>
}

// Configurations are long: we show how they differ, like `git diff`. With the tuning parameters, settings like the others.
const ConfigMismatchTag = ({ configurations, tuning, mismatch }) => <div>
  <PopoverNext placement="bottom" interactionKind="hover" hoverCloseDelay={200} content={
    <ConfigurationDiff configurations={configurations} tuning={tuning} mismatch={mismatch} />
  }>
    <Tag intent={Intent.WARNING} icon="not-equal-to" interactive style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>Config</Tag>
  </PopoverNext>
</div>

// `configurations` and `tuning` are the run's: the mismatch has its reference's
const MismatchTags = ({mismatch, configurations, tuning}) => {
  if (mismatch===null || mismatch===undefined)
    return <span/>
  const { test_input_path, platform } = mismatch;
  return <div>
    {test_input_path  && <MismatchTag text="Input" what="input" explanation={test_input_path} />}
    {(mismatch.configurations || mismatch.extra_parameters) && <ConfigMismatchTag configurations={configurations} tuning={tuning} mismatch={mismatch} />}
    {platform         && <MismatchTag text="Platform" what="platform" explanation={<PlatformTag inverted platform={platform} />} />}
  </div>
}


const RunBadges = ({output}) => {
  return (output.params?.badges ?? []).map( (badge, idx) => {
      return <span key={idx} style={{marginRight: '5px'}}>
        <RunBadge badge={badge} key={idx}/>
      </span>
  })
}
const RunBadge = ({badge}) => {
  const tag = <Tag
    icon={badge.icon}
    minimal={badge.minimal}
    large={badge.large}
    rightIcon={badge.href && "share"}
    style={badge.style}
    intent={badge.intent}>
      {badge.text ?? (typeof badge==="string" ? badge : JSON.stringify(badge))}
  </Tag>
  return <>{!!badge.href ? <a rel="noopener noreferrer" target="_blank" href={badge.href}>
    {tag}
    </a> : tag}
  </>
}



// What users can do with a run: redo it, mark it as failed, delete it...
const RunActionsMenu = ({ output, project, commit }) => {
  const [waiting, setWaiting] = useState(false)
  // deletes need confirming: 'delete' or 'delete-files'
  const [confirming, setConfirming] = useState(null)
  const refreshCommit = useRefreshCommit()
  const { id, deleted, is_pending } = output
  const name = runName(output)
  const refresh = () => refreshCommit(project, commit.id)
  const act = (request, requested, done) => {
    const key = `run-action-${id}`
    setWaiting(true)
    toaster.show({message: requested, icon: 'time'}, key);
    request()
      .then(() => toaster.show({message: done, intent: Intent.SUCCESS}, key))
      .catch(error => toaster.show({message: errorMessage(error), intent: Intent.DANGER}, key))
      .finally(() => {
        setWaiting(false)
        refresh()
      });
  }
  return (
    <Menu>
      {id && is_pending && <MenuItem
        icon="stop"
        text="Mark as failed"
        htmlTitle="For runs stuck as pending or running: their job is gone and will never report"
        intent={Intent.WARNING}
        minimal
        disabled={waiting}
        onClick={() => act(
          () => http.put(`/api/v1/output/${id}/`, {is_pending: false, is_running: false, is_failed: true}),
          `Marking ${name} as failed…`,
          `Marked ${name} as failed`,
        )}
      />}
      {id && !is_pending && <MenuItem
        icon="redo"
        text="Redo"
        intent={Intent.WARNING}
        minimal
        disabled={waiting}
        onClick={() => act(
          () => http.post(`/api/v1/output/redo/${id}/`, {is_pending: false, is_running: false}),
          `Starting ${name} again…`,
          `Redoing ${name}`,
        )}
      />}
      {id && !deleted && <MenuItem
        icon="trash"
        text="Delete…"
        htmlTitle="Delete the run, its metrics and its files"
        intent={Intent.DANGER}
        minimal
        disabled={waiting}
        shouldDismissPopover={false}
        onClick={() => setConfirming('delete')}
      />}
      {id && !deleted && <MenuItem
        icon="trash"
        text="Delete output files…"
        htmlTitle="Delete the run's files, keep its metrics"
        intent={Intent.DANGER}
        minimal
        disabled={waiting}
        shouldDismissPopover={false}
        onClick={() => setConfirming('delete-files')}
      />}
      {/* rendered in a portal; while it's open, the menu's popover stays open */}
      <Alert
        className={Classes.POPOVER_DISMISS}
        isOpen={confirming !== null}
        icon="trash"
        intent={Intent.DANGER}
        cancelButtonText="Cancel"
        confirmButtonText={confirming === 'delete-files' ? "Delete files" : "Delete run"}
        canEscapeKeyCancel
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const files_only = confirming === 'delete-files'
          setConfirming(null)
          act(
            () => http.delete(`/api/v1/output/${id}/`, files_only ? {params: {soft: true}} : undefined),
            `Deleting ${files_only ? 'the files of ' : ''}${name}…`,
            `Deleted ${files_only ? 'the files of ' : ''}${name}`,
          )
        }}
      >
        {confirming === 'delete-files'
          ? <><p><strong>Delete the files of {name}?</strong></p><p>Its metrics are kept.</p></>
          : <><p><strong>Delete {name}?</strong></p><p>Its output files and metrics will be deleted. This can't be undone.</p></>}
      </Alert>
    </Menu>
  )
}


// Asks WebCDE, running on the user's machine, to open the output.
// WebCDE is a desktop app that replays runs whose outputs have a cde.sh, its service listens on localhost:2020.
const open_in_webcde = async ({ output, commit, cde_sh }) => {
  const { platform, output_dir_url } = output
  const cde_dir = cde_sh.replace(/\/?cde.sh$/, '')
  const { data: text } = await http.get(`${output_dir_url}/${cde_sh}`, { responseType: 'text' })
  const command = text.replace(/"/g, '').trim();
  const name = output.test_input_path.split(".")[0]
  const wd = `${decodeURIComponent(linux_to_windows(`${output_dir_url}/${cde_dir}`))}\\`
  try {
    await http.post(`http://localhost:2020/CDE/Launch?WebCDE`, {
      os: platform,
      command, wd, name,
      commit: commit.id.slice(0, 8),
    })
  } catch (error) {
    // fetch fails without a response when nothing listens
    if (!error.response && !isAbort(error))
      error.webcde_unreachable = true
    throw error
  }
}

const OutputTags = ({ output, output_ref, mismatch, manifests, project, commit, style }) => {
  const [waiting, setWaiting] = useState(false)
  const refreshCommit = useRefreshCommit()
  // where users install WebCDE, from QABOARD_WEBCDE_INSTALLER
  const { webcde_installer } = useSiteConfig()
  const refresh = () => refreshCommit(project, commit.id)
  const { platform, configurations, output_dir_url, deleted, output_type } = output;
  const cde_shs = !deleted ? Object.keys(manifests?.new ?? []).filter(path => path.endsWith("cde.sh")) : []
  return <span style={style}>
    {deleted && <Tag icon="trash">deleted</Tag>}
    <PlatformTag platform={platform} />
    <ConfigurationsTags configurations={configurations} tuning={output.extra_parameters} mismatch={mismatch} />

    {output_type !== "batch" &&
    <PopoverNext placement="bottom" content={
      <RunActionsMenu output={output} project={project} commit={commit} />
    }>
      <Button size="small" variant="minimal" icon="menu" className={Classes.TEXT_MUTED} style={{ marginLeft: "5px" }} aria-label="Run actions"/>
    </PopoverNext>}

    {/* The menus open on click: their buttons only act directly when there is nothing to choose from */}
    {output_ref ? <PopoverNext placement="bottom" content={
      <Menu>
        <MenuItem
          text="Open the output directory in the browser"
          target="_blank"
          rel="noopener noreferrer"
          href={folder_url(output_dir_url)}
          className={Classes.TEXT_MUTED} minimal
          icon="folder-shared-open"
        />
        <MenuItem
          text="Open the reference's output directory in the browser"
          target="_blank"
          rel="noopener noreferrer"
          href={folder_url(output_ref.output_dir_url)}
          className={Classes.TEXT_MUTED} minimal
          icon="folder-shared-open"
        />
      </Menu>}
    >
      <Button size="small" variant="minimal" icon="folder-shared-open" className={Classes.TEXT_MUTED} aria-label="Open the output directory"/>
    </PopoverNext> : <Tooltip content="Open the output directory" hoverOpenDelay={300}>
      <AnchorButton
        size="small"
        variant="minimal"
        icon="folder-shared-open"
        className={Classes.TEXT_MUTED}
        aria-label="Open the output directory"
        target="_blank"
        rel="noopener noreferrer"
        href={folder_url(output_dir_url)}
      />
    </Tooltip>}

    {(output_ref || hasPathMappings()) ? <PopoverNext placement="bottom" content={
      <Menu>
        {output_ref && <MenuDivider title="New Run" />}
        <MenuItem text="Copy output directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_dir_url)} />
        {hasPathMappings() && <MenuItem text="Copy output directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_dir_url, { windows: true })} />}
        {output_ref && <>
          <MenuDivider title="Reference Run" />
          <MenuItem text="Copy the reference's output directory" label={hasPathMappings() ? <Tag minimal>linux</Tag> : undefined} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_ref.output_dir_url)} />
          {hasPathMappings() && <MenuItem text="Copy the reference's output directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_ref.output_dir_url, { windows: true })} />}
          </>
        }
      </Menu>}
    >
      <Button size="small" variant="minimal" icon="duplicate" className={Classes.TEXT_MUTED} style={{marginRight: '5px'}} aria-label="Copy the output directory"/>
    </PopoverNext> : <Tooltip content="Copy the path of the output directory" hoverOpenDelay={300}>
      <Button
        size="small"
        variant="minimal"
        icon="duplicate"
        className={Classes.TEXT_MUTED}
        style={{marginRight: '5px'}}
        aria-label="Copy the path of the output directory"
        onClick={() => copyDirectory(output_dir_url)}
      />
    </Tooltip>}
    {cde_shs.map(cde_sh => {
      const cde_dir = cde_sh.replace(/\/?cde.sh$/, '')
      return <Tooltip key={cde_sh} content="Open in WebCDE">
      <Button
          outlined={true}
          style={{margin: "5px"}}
          disabled={waiting}
          icon="open-application"
          text={cde_shs.length === 1 ? 'WebCDE' : cde_dir}
          onClick={() => {
            setWaiting(true)
            open_in_webcde({ output, commit, cde_sh })
              .then(() => toaster.show({message: "Sent to WebCDE", intent: Intent.SUCCESS}))
              .catch(error => {
                const help_text = `Could not connect to WebCDE (CDEWebService) on your computer. Please start WebCDE.exe${webcde_installer ? ` (install it from ${webcde_installer})` : ''}.`
                toaster.show({
                  message: error.webcde_unreachable ? help_text : errorMessage(error),
                  intent: Intent.DANGER,
                });
              })
              .finally(() => {
                setWaiting(false)
                refresh()
              });
          }}
      />
      </Tooltip>}
    )}
    <MismatchTags mismatch={mismatch} configurations={configurations} tuning={output.extra_parameters}/>
  </span>
}


export { hidden_keys, RunActionsMenu, StatusTag, PlatformTag, ConfigurationsTags, MismatchTags, OutputTags, RunBadge, RunBadges, style_skeleton };
