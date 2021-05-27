import React from "react";
import axios from "axios";

import copy from 'copy-to-clipboard';
import { CopyToClipboard } from "react-copy-to-clipboard";
import {
  Classes,
  Colors,
  Icon,
  Tag,
  Menu,
  MenuItem,
  MenuDivider,
  Popover,
  Intent,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { fetchCommit } from "../actions/commit";
import { linux_to_windows } from '../utils'


const toaster = Toaster.create();
const on_copy = text => {
  toaster.show({
    message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
  });
}



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

class PlatformTag extends React.Component {
  render() {
    if (this.props.platform === undefined || this.props.platform === null || this.props.platform === 'linux') return <span />
    return <Tag round minimal={!this.props.inverted} style={{ marginRight: '5px', marginLeft: '5px' }}>@{this.props.platform}</Tag>
  }
}

class ConfigurationsTags extends React.Component {
  render() {
    const configurations = this.props.configurations;
    const intent = this.props.intent || Intent.PRIMARY;

    // Some configuration key names are used and shown by viewers
    // we don't display them here...

    const reserved_keys = [] //"roi", "auto_rois"]
    const tags = configurations.map((c, idx) => {
      const is_object = typeof (c) !== 'string';
      if (is_object) {
        reserved_keys.forEach(key => {
          delete c[key];
        })
        // if (Object.keys(c).length === 0)
        //   return <span key={idx} />
      }
      return <Tag
        intent={intent}
        round
        minimal={!this.props.inverted}
        interactive
        key={idx}
        style={{ marginRight: '5px', marginBottom: '3px' }}
      >
        {!is_object ? c : JSON.stringify(c)}
      </Tag>
    })

    const pretty_json = JSON.stringify(this.props.configurations, null, 2);
    return <CopyToClipboard text={pretty_json} onCopy={() => on_copy(pretty_json)}>
      <span>{tags}</span>
    </CopyToClipboard>
  }
}


class ExtraParametersTags extends React.Component {
  render() {
    const { parameters } = this.props;
    if (Object.keys(parameters).length === 0)
      return <span />

    const intent = this.props.intent || Intent.PRIMARY;
    const tags = Object.entries(parameters).map(([k, v]) => (
      <Tag key={k} intent={intent} minimal={!this.props.inverted} round interactive>
        <strong>{k}: </strong> {JSON.stringify(v)}
      </Tag>
    ));

    const pretty_json = JSON.stringify(parameters, null, 2);
    return <CopyToClipboard text={pretty_json} onCopy={() => on_copy(pretty_json)}><span>
      {this.props.before}
      {tags}
    </span></CopyToClipboard>
  }
}



const MismatchTag = ({text, explanation}) => {
  return <div>
    <Tooltip>
    <Tag intent={Intent.WARNING} icon="not-equal-to" style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>{text}</Tag>
      <div>
        <h3>Comparing to reference:</h3>
        <p>{explanation}</p>
      </div>
    </Tooltip>
  </div>
}

const MismatchTags = ({mismatch}) => {
  if (mismatch===null || mismatch===undefined)
    return <span/>
  const { test_input_path, configurations, platform, extra_parameters } = mismatch;
  return <div>
    {test_input_path  && <MismatchTag text="Input" explanation={test_input_path} />}
    {configurations   && <MismatchTag text="Config" explanation={<ConfigurationsTags inverted configurations={configurations} />} />}
    {platform         && <MismatchTag text="Platform" explanation={<PlatformTag inverted platform={platform} />} />}
    {extra_parameters && <MismatchTag text="Tuning" explanation={Object.keys(extra_parameters).length > 0 ? <ExtraParametersTags inverted parameters={extra_parameters} /> : 'No tuning'} />}
  </div>
}




class OutputTags extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      waiting: false,
    };
  }

  refresh = () => {
    const { project, commit, dispatch } = this.props;
    dispatch(fetchCommit({project, id: commit.id}))
  }


  render() {
    const { platform, configurations, output_dir_url, id, deleted, is_pending, output_type } = this.props.output;
    const { mismatch } = this.props;
    return <span style={this.props.style}>
      {deleted && <Tag icon="trash">deleted</Tag>}
      <PlatformTag platform={platform} />
      <ConfigurationsTags configurations={configurations} />

      {output_type !== "batch" &&
      <Popover position="bottom" hoverCloseDelay={200} interactionKind={"hover"}>
        <Icon icon="menu" style={{ marginLeft: "5px", color: Colors.GRAY1 }}/>

        <Menu>
          {id && !deleted && <MenuItem
            icon="trash"
            text="Delete"
            intent={Intent.DANGER}
            minimal
            disabled={this.state.waiting}
            onClick={() => {
              this.setState({waiting: true})
              toaster.show({message: "Delete requested."});
              axios.delete(`/api/v1/output/${id}/`)
                .then(() => {
                  this.setState({waiting: false})
                  toaster.show({message: "Deleted.", intent: Intent.PRIMARY});
                  this.refresh()
                })
                .catch(error => {
                  this.setState({waiting: false });
                  toaster.show({message: error.response?.data?.error ?? JSON.stringify(error), intent: Intent.DANGER});
                  this.refresh()
                });
            }}
          />}
          {id && !deleted && <MenuItem
            icon="trash"
            text="Delete Output Files"
            intent={Intent.DANGER}
            minimal
            disabled={this.state.waiting}
            onClick={() => {
              this.setState({waiting: true})
              toaster.show({message: "Delete requested."});
              axios.delete(`/api/v1/output/${id}/?soft=true`)
                .then(() => {
                  this.setState({waiting: false})
                  toaster.show({message: "Deleted.", intent: Intent.PRIMARY});
                  this.refresh()
                })
                .catch(error => {
                  this.setState({waiting: false });
                  toaster.show({message: error.response?.data?.error ?? JSON.stringify(error), intent: Intent.DANGER});
                  this.refresh()
                });
            }}
          />}
          {id && is_pending && <MenuItem
            icon="stop"
            text="Mark as Finished"
            intent={Intent.WARNING}
            minimal
            disabled={this.state.waiting}
            onClick={() => {
              this.setState({waiting: true})
              toaster.show({message: "Requested to mark as 'Finished'."});
              axios.put(`/api/v1/output/${id}/`, {is_pending: false, is_running: false})
                .then(() => {
                  this.setState({waiting: false})
                  toaster.show({message: "Marked as finished.", intent: Intent.PRIMARY});
                  this.refresh()
                })
                .catch(error => {
                  this.setState({waiting: false });
                  toaster.show({message: error.response?.data?.error ?? JSON.stringify(error), intent: Intent.DANGER});
                  this.refresh()
                });
            }}
          />}
          {this.props.output_ref && <>
            <MenuDivider title="Reference Output" />
            <MenuItem icon="duplicate" text="Copy Windows path" onClick={()=>{
              copy(linux_to_windows(this.props.output_ref.output_dir_url))
              console.log(linux_to_windows(this.props.output_ref.output_dir_url))
              toaster.show({
                message: "Copied the output directory's path to the clipboard!",
                intent: Intent.PRIMARY
              });
            }}/>
            <MenuItem icon="folder-shared-open" href={this.props.output_ref.output_dir_url} text="View"/>
          </>}
        </Menu>
      </Popover>}


      <Tooltip>
        <a
          style={{ marginLeft: "5px", color: Colors.GRAY1 }}
          target="_blank"
          rel="noopener noreferrer"
          href={output_dir_url}
        >
          <Icon icon="folder-shared-open" />
        </a>
        <span>View the output directory in the browser</span>
      </Tooltip>

      <Tooltip>
        <CopyToClipboard
          text={linux_to_windows(output_dir_url)}
          onCopy={() => {
            toaster.show({
              message: "Copied the output directory's path to the clipboard!",
              intent: Intent.PRIMARY
            });
          }}
        >
          <span style={{marginLeft: "5px", marginRight: '5px', color: Colors.GRAY1}}>
            <Icon
             title="Copy-to-Clipboard"
             iconSize={Icon.SIZE_SMALL}
             icon="duplicate"
            />
          </span>
        </CopyToClipboard>
        <span>Copy-to-Clipboard the Windows directory</span>
      </Tooltip>

      <MismatchTags mismatch={mismatch}/>
    </span>
  }
}


export { StatusTag, PlatformTag, ConfigurationsTags, ExtraParametersTags, MismatchTags, OutputTags, style_skeleton };