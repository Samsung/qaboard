import React from "react";

import { CopyToClipboard } from "react-copy-to-clipboard";
import {
  Classes,
  Icon,
  Tag,
  Intent,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { deserialize_config, linux_to_windows } from '../utils'


const toaster = Toaster.create();
const on_copy = text => {
  toaster.show({
    message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
  });
}


class PlatformTag extends React.Component {
  render() {
    if (this.props.platform === undefined || this.props.platform === null || this.props.platform === 'lsf') return <span />
    return <Tag round minimal style={{ marginRight: '5px', marginLeft: '5px' }}>@{this.props.platform}</Tag>
  }
}

class ConfigurationsTags extends React.Component {
  render() {
    const configurations = this.props.configurations || deserialize_config(this.props.configuration)
    const intent = this.props.intent || Intent.PRIMARY;

    // Some configuration key names are used and shown by viewers
    // we don't display them here...
    const reserved_keys = ["roi", "auto_rois"]
    const tags = configurations.map((c, idx) => {
      const is_object = typeof (c) !== 'string';
      if (is_object) {
        reserved_keys.forEach(key => {
          delete c[key];
        })
        if (Object.keys(c).length === 0)
          return <span key={idx} />
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

    const pretty_json = this.props.configuration || JSON.stringify(this.props.configurations, null, 2);
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
      <Tag key={k} intent={intent} minimal round interactive>
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


class OutputTags extends React.PureComponent {
  render() {
    const { platform, configuration, output_dir_url } = this.props.output;
    const { warning } = this.props;
    let windows_path = linux_to_windows(output_dir_url);
    return <span>
      <PlatformTag platform={platform} />
      <ConfigurationsTags configuration={configuration} />
      <Tooltip>
        <a
          style={{ marginLeft: "4px" }}
          target="_blank"
          rel="noopener noreferrer"
          href={output_dir_url}
        >
          <Icon icon="folder-shared-open" style={{ verticalAlign: 'baseline' }} />
        </a>
        <span>Open the output directory</span>
      </Tooltip>
      <Tooltip>
        <CopyToClipboard
          text={windows_path}
          onCopy={() => {
            toaster.show({
              message: "Copied the output directory's windows-path to clipboard!",
              intent: Intent.PRIMARY
            });
          }}
        >
          <Icon
            title="copy to clipboard"
            intent={Intent.PRIMARY}
            iconSize={Icon.SIZE_SMALL}
            icon="duplicate"
            style={{ marginLeft: "4px" }}
          />
        </CopyToClipboard>
        <span>Copy to the clipboard the Windows directory </span>
      </Tooltip>

      {warning && (
        <Tooltip>
          <Tag intent={Intent.WARNING} icon="not-equal-to" style={{ verticalAlign: 'baseline', marginLeft: "4px" }}>ref</Tag>
          <span>{warning}</span>
        </Tooltip>
      )}
    </span>
  }
}



export { PlatformTag, ConfigurationsTags, ExtraParametersTags, OutputTags };