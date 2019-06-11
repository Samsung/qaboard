import React from "react";

import { CopyToClipboard } from "react-copy-to-clipboard";
import {
  Classes,
  Tag,
  Intent,
  Toaster,
} from "@blueprintjs/core";

import { deserialize_config } from '../utils'


const toaster = Toaster.create();
const on_copy = text => {
    toaster.show({
      message: <span className={Classes.TEXT_OVERFLOW_ELLIPSIS}><strong>Copied:</strong> {text}</span>,
    });
}



class PlatformTag extends React.Component {
	render() {
		if (this.props.platform === undefined || this.props.platform === null || this.props.platform === 'lsf') return <span/>
        return <Tag round minimal style={{marginRight: '5px', marginLeft: '5px'}}>@{this.props.platform}</Tag>
	}
}

class ConfigurationsTags extends React.Component {
	render() {
		const configurations = this.props.configurations || deserialize_config(this.props.configuration)
		const intent = this.props.intent || Intent.PRIMARY;

	    const tags = configurations.map( (c, idx) => <Tag
	    	intent={intent}
	    	round
	    	minimal
	    	interactive
	    	key={idx}
	    	style={{marginRight: '5px', marginBottom: '3px'}}
	    >
	    		{typeof(c) === 'string' ? c : JSON.stringify(c)}
	    </Tag>)

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
			return <span/>

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


export { PlatformTag, ConfigurationsTags, ExtraParametersTags };