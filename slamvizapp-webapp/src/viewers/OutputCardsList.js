import React from "react";
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
import { matching_output, sortOutputs } from "../utils";
import { OutputCard } from "./OutputCard";




class OutputCardsList extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);

    this.state = {
      select_debug: "",
      // bit-accuracy controls
      show_all_files: params.get("show_all_files") || false,
      expand_all: params.get("expand_all") || false,
      files_filter: params.get("files_filter") || '',
    };
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


  render() {
    const { project, project_data, new_batch, ref_batch, sort_by, sort_order, controls, type } = this.props;
    const { show_all_files, expand_all, files_filter } = this.state;
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md

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
          {Object.entries(new_batch.outputs)
            .filter( ([id, output]) => output.output_type!=="optim_iteration")
            .sort(sortOutputs(sort_by, sort_order))
            .map(([id, output]) => {
              let { output_ref, warning } = matching_output({
                output: output,
                batch: ref_batch
              });
              return (
                <OutputCard
                  key={id}
                  type={this.props.type}
                  show_all_files={this.state.show_all_files}
                  files_filter={files_filter}
                  expand_all={expand_all}
                  project={project}
                  project_data={project_data}
                  commit={this.props.new_commit}
                  output_type={output.output_type}
                  output_new={output}
                  output_ref={output_ref}
                  warning={warning}
                  controls={controls}
                  select_debug={this.state.select_debug}
                />
              );
            })}
        </div>
      </>
    );
  }
}

export { OutputCardsList }