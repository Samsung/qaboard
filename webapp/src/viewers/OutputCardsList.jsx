import React from "react";
import qs from "qs";

import {
  FormGroup,
  InputGroup,
} from "@blueprintjs/core";

import { BitAccuracyForm } from "./bit_accuracy/utils";
import { OutputCard } from "./OutputCard";


class OutputCardsList extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);

    this.state = {
      select_debug: "",
      // bit-accuracy controls
      show_all_files: params.get("show_all_files") === 'true' || false,
      hide_runs_without_files: params.get("hide_runs_without_files") === 'true' || false,
      expand_all: params.get("expand_all") === 'true' || false,
      files_filter: params.get("files_filter") || '',
      color_blind_friendly: params.get("color_blind_friendly") || '',
    };
  }


  render() {
    const { new_batch, project, config, metrics, new_commit, ref_batch } = this.props;
    const { type, controls } = this.props;
    const { show_all_files, hide_runs_without_files, expand_all, files_filter, color_blind_friendly, select_debug } = this.state;
    const misc_output_props = {
      project,
      config,
      metrics,
      commit: new_commit,
      controls,
      type,
      show_all_files,
      hide_runs_without_files,
      files_filter,
      expand_all,
      color_blind_friendly,
      select_debug,
      onRegisterOutputOptions: this.props.onRegisterOutputOptions,
      onToggleDynamicOptionSync: this.props.onToggleDynamicOptionSync,
    }
    const outputs = (new_batch?.filtered?.outputs || [])
                    .map( id => [id, new_batch.outputs[id]])
                    .filter( ([id, output]) => output.output_type !== "optim_iteration")

    return (
      <>
        {type === 'bit_accuracy' && <BitAccuracyForm
                                     show_all_files={show_all_files}
                                     hide_runs_without_files={hide_runs_without_files}
                                     expand_all={expand_all}
                                     files_filter={files_filter}
                                     color_blind_friendly={color_blind_friendly}
                                     toggle={this.toggle}
                                     update={this.update}
                                    />
        }
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexFlow: "row wrap",
          }}
        >
          {outputs.map( ([id, output]) => {
              return <OutputCard
                key={id}
                output_type={output.output_type}
                output_new={output}
                output_ref={ref_batch.outputs[output.reference_id]}
                files_filter={files_filter}
                dispatch={this.props.dispatch}
                {...misc_output_props}
              />;
            })}
        </div>
      </>
    );
  }


  
  update = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    let query = qs.parse(window.location.search.substring(1));
    this.setState({[attribute_url || attribute]: value,})
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  }

  toggle = name => () => {
    this.setState({[name]: !this.state[name]})
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [name]: !this.state[name],
      })
    });
  }

}



export { OutputCardsList }