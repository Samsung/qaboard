import React from "react";
import { VariableSizeList as List } from 'react-window';
import qs from "qs";

import {
  FormGroup,
  Switch,
  InputGroup,
  Callout,
  Intent,
} from "@blueprintjs/core";

import { Section } from "../components/layout";
import { bit_accuracy_help } from "./bit_accuracy/utils";
import { sortOutputs } from "../utils";
import { OutputCard } from "./OutputCard";


 
 

class OutputCardsList extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);

    this.state = {
      outputs: [],
      select_debug: "",
      // bit-accuracy controls
      show_all_files: params.get("show_all_files") === 'true' || false,
      expand_all: params.get("expand_all") === 'true' || false,
      files_filter: params.get("files_filter") || '',
    };
  }

  componentDidUpdate(prevProps, prevState) {
    const { new_batch, sort_by, sort_order } = this.props;
    const has_outputs = !!this.props.new_batch && !!this.props.new_batch.outputs;
    const had_outputs = !!prevProps.new_batch && !!prevProps.new_batch.outputs;
    let updated_outputs = has_outputs && (!had_outputs || (had_outputs && prevProps.new_batch.outputs !== this.props.new_batch.outputs));
    if (updated_outputs) {
      const outputs = Object.entries(new_batch.outputs)
        .filter( ([id, output]) => output.output_type !== "optim_iteration")
        .sort(sortOutputs(sort_by, sort_order))
      this.setState({outputs})      
    }
}

  render() {
    const { project, project_data, new_commit, new_batch, ref_batch } = this.props;
    const { type, controls } = this.props;
    const { show_all_files, expand_all, files_filter, select_debug } = this.state;
    const misc_output_props = {
      project,
      project_data,
      commit,
      controls,
      type,
      show_all_files,
      files_filter,
      expand_all
      select_debug,
    } 


    return (
      <>
        {type === 'bit_accuracy' && 
          <Callout style={{marginBottom: '20px', display: 'flex', justifyContent: 'space-between'}}>
            <FormGroup
              inline
              labelFor="show-all-files"
              helperText="By default the only files shown are those that are different/added/removed."
              style={{flex: '50 1 auto'}}
            >
              <Switch
                label="Show all files"
                checked={show_all_files}
                onChange={this.toggle('show_all_files')}
                style={{ width: "300px" }}
              />
            </FormGroup>
            <FormGroup
              inline
              labelFor="expand-all"
              style={{flex: '50 1 auto'}}
            >
              <Switch
                label="Expand all folders"
                checked={expand_all}
                onChange={this.toggle('expand_all')}
                style={{ width: "300px" }}
              />
            </FormGroup>
            <FormGroup
              inline
              labelFor="files-filter"
              helperText="Only show files matching"
              style={{flex: '50 1 auto'}}
            >
              <InputGroup
                value={files_filter}
                placeholder="filter by path"
                onChange={this.update('files_filter')}
                type="search"
                leftIcon="filter"
                style={{ width: "150px" }}
              />
            </FormGroup>
            <span style={{flex: '1 1 auto'}}>{bit_accuracy_help}</span>
          </Callout>
        }
        {controls.show_debug && (
          <FormGroup
            label="Show debug outputs matching"
            labelFor="show-debug-input"
            helperText="You can select any number of debug outputs."
            style={{ marginBottom: "30px" }}
          >
            <InputGroup
              value={this.state.select_debug_input}
              placeholder="ransac points"
              onChange={e => this.setState({ select_debug: e.target.value })}
              leftIcon="series-add"
              style={{ width: "300px" }}
            />
          </FormGroup>
        )}
        {!!ref_batch.label && ref_batch.label !== "default" && this.props.sorted_extra_parameters.length > 0 && (
          <Section><Callout intent={Intent.WARNING}>
            We compare each output to <strong>any</strong> reference outputs
            with matching recording+configuration+platform,{" "}
            <strong>without looking at the tuning parameters</strong>.
          </Callout></Section>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexFlow: "row wrap"
          }}
        >
          {this.state.outputs.map(([id, output]) => {
              return (
                <OutputCard
                  key={id}
                  output_type={output.output_type}
                  output_new={output}
                  output_ref={ref_batch.outputs[output.reference_id]}
                  warning={output.reference_warning}
                  {...misc_output_props}
                />
              );
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