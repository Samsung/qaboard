import { useState } from "react";
import {
  Classes,
  Colors,
  Icon,
  Tag,
  Menu,
  MenuItem,
  MenuDivider,
  Popover,
  PopoverNext,
  Intent,
  Tooltip,
  Button,
} from "@blueprintjs/core";

import { http, errorMessage, isAbort } from "../api/http";
import { useRefreshCommit } from "../hooks";
import { linux_to_windows } from '../utils'
import { folder_url } from '../utils/paths'
import { toaster } from "../toaster"
import { copyWithToast } from "../utils/clipboard"
import { copyDirectory } from "./logs/DirectoryActions"
import { hidden_keys } from "../configurations/tokens"
import { ConfigurationsTags, ConfigurationDiff } from "../configurations/ConfigurationsTags"


const style_skeleton = {
  borderRadius: '2px',
  boxShadow: 'none !important',
  borderColor: 'rgba(206, 217, 224, 0.2) !important',
  background: 'rgba(206, 217, 224, 0.2)',
  backgroundClip: 'padding-box !important',
  animation: '1000ms linear infinite alternate skeleton-glow',
}


const StatusTag = ({output, style}) => {
  const intent = output.is_failed
                 ? Intent.DANGER
                 : output.is_pending ? Intent.WARNING : Intent.SUCCESS;
  const tag_text = output.is_failed ? "" : output.is_pending ? (output.is_running ? "🏃" : "⏳") : "";
  const tag_title = output.is_failed ? "Failed" : output.is_pending ? (output.is_running ? "Running" : "Pending") : undefined;
  return <Tag
    title={tag_title}
    icon={output.is_failed ? "cross" : (output.is_pending ? undefined : "tick")}
    style={output.is_running ? {...style, ...style_skeleton} : style}
    intent={intent}>{tag_text}
  </Tag>

}

const PlatformTag = ({ platform, inverted }) => {
  if (platform === undefined || platform === null || platform === 'linux') return <span />
  return <Tag round minimal={!inverted} style={{ marginRight: '5px', marginLeft: '5px' }}>@{platform}</Tag>
}

const ExtraParametersTags = ({ parameters, intent = Intent.PRIMARY, inverted, before }) => {
  if (Object.keys(parameters).length === 0)
    return <span />

  const pretty_json = JSON.stringify(parameters, null, 2);
  const copy = () => copyWithToast(pretty_json, { what: 'the parameters' });
  const tags = Object.entries(parameters)
    .filter(([k]) => !hidden_keys.includes(k))
    .map(([k, v]) => (
      <Tag key={k} intent={intent} minimal={!inverted} round interactive onClick={copy} style={{ marginRight: '5px', marginBottom: '3px' }}>
        <strong>{k}: </strong> {JSON.stringify(v)}
      </Tag>
    ));

  return <span>
    {before}
    {tags}
  </span>
}



const MismatchTag = ({text, explanation}) => {
  return <div>
    <Tooltip content={<div>
        <h3>Comparing to reference:</h3>
        <p>{explanation}</p>
      </div>}
    >
      <Tag intent={Intent.WARNING} icon="not-equal-to" style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>{text}</Tag>
    </Tooltip>
  </div>
}

// Configurations are long: we show how they differ, like `git diff`
const ConfigMismatchTag = ({ configurations, reference }) => <div>
  <PopoverNext placement="bottom" interactionKind="hover" hoverCloseDelay={200} content={
    <ConfigurationDiff configurations={configurations} reference={reference} />
  }>
    <Tag intent={Intent.WARNING} icon="not-equal-to" interactive style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>Config</Tag>
  </PopoverNext>
</div>

// `configurations` are the run's: the mismatch has its reference's
const MismatchTags = ({mismatch, configurations}) => {
  if (mismatch===null || mismatch===undefined)
    return <span/>
  const { test_input_path, platform, extra_parameters } = mismatch;
  return <div>
    {test_input_path  && <MismatchTag text="Input" explanation={test_input_path} />}
    {mismatch.configurations && <ConfigMismatchTag configurations={configurations} reference={mismatch.configurations} />}
    {platform         && <MismatchTag text="Platform" explanation={<PlatformTag inverted platform={platform} />} />}
    {extra_parameters && <MismatchTag text="Tuning" explanation={Object.keys(extra_parameters).length > 0 ? <ExtraParametersTags inverted parameters={extra_parameters} /> : 'No tuning'} />}
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
  const refreshCommit = useRefreshCommit()
  const { id, deleted, is_pending } = output
  const refresh = () => refreshCommit(project, commit.id)
  const act = (request, requested, done) => {
    setWaiting(true)
    toaster.show({message: requested});
    request()
      .then(() => toaster.show({message: done, intent: Intent.SUCCESS}))
      .catch(error => toaster.show({message: errorMessage(error), intent: Intent.DANGER}))
      .finally(() => {
        setWaiting(false)
        refresh()
      });
  }
  return (
    <Menu>
      {id && is_pending && <MenuItem
        icon="stop"
        text="Mark as Failed"
        htmlTitle="For runs stuck as pending or running: their job is gone and will never report"
        intent={Intent.WARNING}
        minimal
        disabled={waiting}
        onClick={() => act(
          () => http.put(`/api/v1/output/${id}/`, {is_pending: false, is_running: false, is_failed: true}),
          "Requested to mark as 'Failed'.",
          "Marked as failed.",
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
          "Requested Redo.",
          "Redo started.",
        )}
      />}
      {id && !deleted && <MenuItem
        icon="trash"
        text="Delete"
        intent={Intent.DANGER}
        minimal
        disabled={waiting}
        onClick={() => act(() => http.delete(`/api/v1/output/${id}/`), "Delete requested.", "Deleted.")}
      />}
      {id && !deleted && <MenuItem
        icon="trash"
        text="Delete Output Files"
        intent={Intent.DANGER}
        minimal
        disabled={waiting}
        onClick={() => act(() => http.delete(`/api/v1/output/${id}/`, {params: {soft: true}}), "Delete requested.", "Deleted.")}
      />}
    </Menu>
  )
}


// Asks WebCDE, running on the user's machine, to open the output
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
  const refresh = () => refreshCommit(project, commit.id)
  const { platform, configurations, output_dir_url, deleted, output_type } = output;
  const cde_shs = !deleted ? Object.keys(manifests?.new ?? []).filter(path => path.endsWith("cde.sh")) : []
  return <span style={style}>
    {deleted && <Tag icon="trash">deleted</Tag>}
    <PlatformTag platform={platform} />
    <ConfigurationsTags configurations={configurations} reference={mismatch?.configurations} />

    {output_type !== "batch" &&
    <Popover placement="bottom" hoverCloseDelay={200} interactionKind={"hover"} content={
      <RunActionsMenu output={output} project={project} commit={commit} />
    }>
      <Icon icon="menu" style={{ marginLeft: "5px", color: Colors.GRAY1 }}/>
    </Popover>}


    <Popover hoverCloseDelay={500} interactionKind={"hover"} placement="bottom" content={
      <Menu>
        <MenuItem
          text="Open output directory in browser"
          target="_blank"
          rel="noopener noreferrer"
          href={folder_url(output_dir_url)}
          className={Classes.TEXT_MUTED} minimal
          icon="folder-shared-open"
        />
        {output_ref &&
        <MenuItem
          text="Open the Reference's output directory in browser"
          target="_blank"
          rel="noopener noreferrer"
          href={folder_url(output_ref.output_dir_url)}
          className={Classes.TEXT_MUTED} minimal
          icon="folder-shared-open"
        />}
      </Menu>}
    >
      <a style={{marginLeft: "5px", color: Colors.GRAY1}}
            target="_blank"
            rel="noopener noreferrer"
            href={folder_url(output_dir_url)}
      >
        <Icon icon="folder-shared-open" />
      </a>
    </Popover>

    <Popover hoverCloseDelay={500} interactionKind={"hover"} placement="bottom" content={
      <Menu>
        {output_ref && <MenuDivider title="New Run" />}
        <MenuItem text="Copy output directory" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_dir_url)} />
        <MenuItem text="Copy output directory" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_dir_url, { windows: true })} />
        {output_ref && <>
          <MenuDivider title="Reference Run" />
          <MenuItem text="Copy output directory of the 'Reference'" label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_ref.output_dir_url)} />
          <MenuItem text="Copy output directory of the 'Reference'" label={<Tag minimal>windows</Tag>} className={Classes.TEXT_MUTED} minimal icon="duplicate" onClick={() => copyDirectory(output_ref.output_dir_url, { windows: true })} />
          </>
        }
      </Menu>}
    >
      <span style={{marginLeft: "5px", marginRight: '5px', color: Colors.GRAY1}}>
        <Icon
          title="Copy-to-Clipboard"
          icon="duplicate"
        />
      </span>
    </Popover>
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
                const help_text = "Sorry we could not connect to CDEWebService. Please start WebCDE.exe (download from \\\\netapp\\Joint\\WebCDE\\WebCDE_Setup.exe)"
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
    <MismatchTags mismatch={mismatch} configurations={configurations}/>
  </span>
}


export { hidden_keys, RunActionsMenu, StatusTag, PlatformTag, ConfigurationsTags, ExtraParametersTags, MismatchTags, OutputTags, RunBadge, RunBadges, style_skeleton };
