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
import { copyWithToast } from "../utils/clipboard"
import { copyDirectory } from "./logs/DirectoryActions"
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

const hidden_keys = ["badges", "roi", "auto_rois"]

// Helper function to convert configuration to tuning format
const convertToTuningFormat = (configurations) => {
  const merged = {};
  
  configurations.forEach(config => {
    if (typeof config === 'object' && config !== null) {
      Object.entries(config)
        .filter(([k]) => !hidden_keys.includes(k))
        .forEach(([key, value]) => {
          // Handle numeric vectors/arrays specially
          if (Array.isArray(value) && value.every(item => typeof item === 'number')) {
            merged[key] = [[[value]]];
          } else {
            merged[key] = [value];
          }
        });
    }
  });
  
  return Object.keys(merged).length > 0 ? JSON.stringify(merged, null, 2) : null;
};

const ConfigurationsTags = ({configurations, inverted, intent, toplevel=true}) => {
    // Some configuration key names are used and shown by viewers - we don't display them here...
    const tags = configurations.map((c, idx) => {
      const wrapper_style = { marginRight: '5px', marginBottom: '3px', fontWeight: '400' }
      
      if (typeof (c) === 'string') {
        const stringTag = <Tag
          intent={intent}
          round
          minimal={!inverted}
          interactive
          key={idx}
          style={wrapper_style}
        >{c}</Tag>
        
        if (!toplevel) return stringTag;
        
        return <PopoverNext
          key={idx}
          placement="bottom"
          hoverCloseDelay={200}
          interactionKind={"hover"}
          content={
            <Menu>
              <MenuItem
                icon="duplicate"
                text="Copy this item"
                onClick={() => copyWithToast(c, { what: 'the configuration item' })}
              />
              <MenuItem
                icon="duplicate"
                text="Copy full configuration"
                onClick={() => copyWithToast(JSON.stringify(configurations, null, 2), { what: 'the configuration' })}
              />
              {convertToTuningFormat(configurations) && <MenuItem
                icon="duplicate"
                text="Copy full config in tuning format"
                onClick={() => copyWithToast(convertToTuningFormat(configurations), { what: 'the configuration in tuning format' })}
              />}
            </Menu>
          }
        >
          {stringTag}
        </PopoverNext>
      } else {
        const objectTags = <span style={wrapper_style} key={idx}>
          {Object.entries(c)
                 .filter(([k]) => !hidden_keys.includes(k))
                 .map( ([k, v]) => {
                   const tag = <Tag round interactive minimal={!inverted} key={k} intent={intent}>
                     <strong>{k}:</strong> {JSON.stringify(v)}
                   </Tag>
                   
                   if (!toplevel) return tag;
                   
                   return <PopoverNext
                     key={k}
                     placement="bottom"
                     hoverCloseDelay={200}
                     interactionKind={"hover"}
                     content={
                       <Menu>
                         <MenuItem
                           icon="duplicate"
                           text={<span>Copy <em>{`${k}`}</em></span>}
                           onClick={() => copyWithToast(`${k}: ${JSON.stringify(v)}`, { what: k })}
                         />
                         <MenuItem
                           icon="duplicate"
                           text="Copy as JSON"
                           onClick={() => copyWithToast(JSON.stringify(c, null, 2), { what: 'the configuration item' })}
                         />
                         <MenuItem
                           icon="duplicate"
                           text="Copy full configuration"
                           onClick={() => copyWithToast(JSON.stringify(configurations, null, 2), { what: 'the configuration' })}
                         />
                         {convertToTuningFormat(configurations) && <MenuItem
                           icon="duplicate"
                           text="Copy full configuration in tuning format"
                           onClick={() => copyWithToast(convertToTuningFormat(configurations), { what: 'the configuration in tuning format' })}
                         />}
                       </Menu>
                     }
                   >
                     {tag}
                   </PopoverNext>
                 })}
          </span>
          
        return objectTags;
      }
    })

    if (!toplevel)
      return tags
      
    return <span>{tags}</span>
}


const ExtraParametersTags = ({ parameters, intent = Intent.PRIMARY, inverted, before }) => {
  if (Object.keys(parameters).length === 0)
    return <span />

  const pretty_json = JSON.stringify(parameters, null, 2);
  const copy = () => copyWithToast(pretty_json, { what: 'the parameters' });
  const tags = Object.entries(parameters)
    .filter(([k]) => !hidden_keys.includes(k))
    .map(([k, v]) => (
      <Tag key={k} intent={intent} minimal={!inverted} round interactive onClick={copy} title="Tuning parameters. Click to copy them as JSON" style={{ marginRight: '5px', marginBottom: '3px' }}>
        <strong>{k}: </strong> {JSON.stringify(v)}
      </Tag>
    ));

  return <span>
    {before}
    {tags}
  </span>
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

const MismatchTags = ({mismatch}) => {
  if (mismatch===null || mismatch===undefined)
    return <span/>
  const { test_input_path, configurations, platform, extra_parameters } = mismatch;
  return <div>
    {test_input_path  && <MismatchTag text="Input" what="input" explanation={test_input_path} />}
    {configurations   && <MismatchTag text="Config" what="configuration" explanation={<ConfigurationsTags inverted configurations={configurations} />} />}
    {platform         && <MismatchTag text="Platform" what="platform" explanation={<PlatformTag inverted platform={platform} />} />}
    {extra_parameters && <MismatchTag text="Tuning" what="tuning parameters" explanation={Object.keys(extra_parameters).length > 0 ? <ExtraParametersTags inverted parameters={extra_parameters} /> : 'No tuning'} />}
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
    <ConfigurationsTags configurations={configurations} />

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
    <MismatchTags mismatch={mismatch}/>
  </span>
}


export { hidden_keys, RunActionsMenu, StatusTag, PlatformTag, ConfigurationsTags, ExtraParametersTags, MismatchTags, OutputTags, RunBadge, RunBadges, style_skeleton };
