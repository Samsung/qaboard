import React from "react";
import { get, all, CancelToken } from "axios";
import qs from "qs";
import copy from 'copy-to-clipboard';

import {
  Classes,
  Button,
  Tag,
  Intent,
  Callout,
  FormGroup,
  Switch,
  NonIdealState,
  InputGroup,
  Toaster,
} from "@blueprintjs/core";

import { bit_accuracy_help, humanFileSize } from "../viewers/bit_accuracy/utils";
import { linux_to_windows } from "../utils";
import { OutputViewer } from "../viewers/OutputViewer";


export const toaster = Toaster.create();


class CommitParameters extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);
    this.state = {
      artifact: params.get("params_artifact") || 'configurations',
      manifests: {},
      is_loaded: false,
      error: {},
      cancel_source: {
        new: CancelToken.source(),
        reference: CancelToken.source(),
      },
      show_all_files: params.get("params_show_all_files") === 'true' || false,
      expand_all: params.get("params_expand_all") === 'true' || true,
      files_filter: params.get("params_files_filter") || '',
    };
  }

  componentWillUnmount() {
    ["new", "reference"].forEach(label => {
      if (!!this.state.cancel_source[label])
        this.state.cancel_source[label].cancel();      
    })
  }

  fetchData(props, label) {
    const { new_commit, ref_commit } = props;
    if (new_commit === undefined || new_commit === null || new_commit.artifacts_url === undefined || new_commit.artifacts_url === null)
    	return;

    this.setState({is_loaded: false})
    let results = [];
    const should_get_all = label === undefined || label === null;
    if (should_get_all || label === 'new') {
      results.push(['new', `${new_commit.artifacts_url}/manifests/${this.state.artifact}.json`])
    }
    if (should_get_all || label === 'reference') {
      if (!!ref_commit && !!ref_commit.artifacts_url)
        results.push(['reference', `${ref_commit.artifacts_url}/manifests/${this.state.artifact}.json`])
    }
    const load_data = label => (response, error) => {
      let storage = 0
      if (response.data !== undefined) {
        Object.values(response.data).forEach(f => {storage += f.st_size ?? 0})
      }
      this.setState((previous_state, props) => ({
        manifests: {
          ...previous_state.manifests,
          [label]: response.data,
        },
        storage: {
          ...previous_state.storage,
          [label]: storage,
        },
        error: {
          ...previous_state.error,
          [label]: error,
        }
      }))
    }
    all(results.map( ([label, url]) => {
      return () =>  get(url, {cancelToken: this.state.cancel_source[label].token})
                    .then(load_data(label))
                    .catch(response => {
                     load_data(label)(
                        {load_data  : {}},
                        response,
                      )
                    });
    }).map(f=>f()) )
    // now we loaded and parsed all the data
    .then( () => {
      this.setState({
        is_loaded: true,
      })
    })
  }


  componentDidMount() {
    this.fetchData(this.props)
  }


  componentDidUpdate(prevProps, prevState) {
      const has_new = this.props.new_commit !== undefined && this.props.new_commit !== null;
      const has_ref = this.props.ref_commit !== undefined && this.props.ref_commit !== null;
      let updated_new = has_new && (prevProps.new_commit === null || prevProps.new_commit === undefined || prevProps.new_commit.id !== this.props.new_commit.id || prevProps.new_commit.artifacts_url !== this.props.new_commit.artifacts_url);
      let updated_ref = has_ref && (prevProps.ref_commit === null || prevProps.ref_commit === undefined || prevProps.ref_commit.id !== this.props.ref_commit.id || prevProps.ref_commit.artifacts_url !== this.props.ref_commit.artifacts_url);
      if (updated_new) {
        if (!!this.state.cancel_source.new)
          this.state.cancel_source.new.cancel();
        this.fetchData(this.props, 'new');
      }
      if (updated_ref) {
        if (!!this.state.cancel_source.reference)
          this.state.cancel_source.reference.cancel();
        this.fetchData(this.props, 'reference');
      }
  }


  render() {
    const { new_commit, ref_commit, config } = this.props;
    const { manifests, is_loaded, error } = this.state;
    const { show_all_files, expand_all, files_filter } = this.state;

    if (new_commit === null || new_commit === undefined)
    	return <span />;

    const artifacts = Object.keys(config.artifacts || {})

    const help_text = <>
      <p>
        Configurations are defined in your <strong>qaboard.yaml</strong>, eg as <code>artifacts.configurations</code>.
        <br/>
        You can explore all your artifacts:  {artifacts.map((artifact, idx) => 
            <Button
                key={idx}
                onClick={e => this.setState({artifact}, () => {this.update('artifact', 'params_artifact')(artifact); this.fetchData(this.props)})}
                intent={this.state.artifact===artifact ? Intent.PRIMARY : null}
                style={{margin: '5px'}}
            >
                {artifact}
            </Button>
        )}
      </p>
    </>

    const fake_output = {is_failed: false, is_running: false, is_pending: false, metrics: {}}
    const viewer = !is_loaded ? <span/> : <>
      <Tag>Total: {humanFileSize(this.state.storage.new, true)}</Tag>
      <OutputViewer
        key="bit-accuracy"
        type="files/bit-accuracy"
        output_new={{...fake_output, output_dir_url: new_commit.repo_artifacts_url}}
        output_ref={!!ref_commit && {...fake_output, output_dir_url: ref_commit.repo_artifacts_url}}
        manifests={manifests}
        show_all_files={show_all_files}
        expand_all={expand_all}
        files_filter={files_filter}
      />
    </>


    const forms = <Callout style={{marginBottom: '20px', display: 'flex', justifyContent: 'space-between'}}>
        <FormGroup
          inline
          labelFor="show-all-files"
          helperText="By default the only files shown are those that are different/added/removed."
          style={{flex: '50 1 auto'}}
        >
          <Switch
            label="Show all files"
            checked={show_all_files}
            onChange={this.toggle('show_all_files', 'params_show_all_files')}
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
            onChange={this.toggle('expand_all', 'params_expand_all')}
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
            onChange={this.update('files_filter', 'params_files_filter')}
            type="search"
            leftIcon="filter"
            style={{ width: "150px" }}
          />
        </FormGroup>
        <span style={{flex: '1 1 auto'}}>{bit_accuracy_help}</span>
    </Callout>

    return <div>
      {help_text}
      {forms}
      {!!error.new ? <NonIdealState
                        title={`Could not find the ${this.state.artifact}`}
                        icon="folder-open"
                        description={<>
                          <p>To solve the issue, go to your commit's workspace and call<br/><code>qa save-artifacts</code>.</p>
                          <p className={Classes.TEXT_MUTED}><code>{JSON.stringify(error.new.response)}</code></p>
                        </>}
                      />
                   : viewer
      }
      <div style={{margin: '10px'}}>
        <Button style={{margin: '10px'}} className={Classes.TEXT_MUTED} icon="duplicate" onClick={() => {toaster.show({message: "Windows path copied to clipboard!", intent: Intent.PRIMARY}); copy(linux_to_windows(new_commit.artifacts_url))}}>
          Copy Path <Tag minimal>windows</Tag>
        </Button>
        <Button style={{margin: '10px'}} label={<Tag minimal>linux</Tag>} className={Classes.TEXT_MUTED} icon="duplicate" onClick={() => {toaster.show({message: "Linux path copied to clipboard!", intent: Intent.PRIMARY}); copy(decodeURI(new_commit.artifacts_url).slice(2))}}>
          Copy Path <Tag minimal>linux</Tag>
        </Button>
        <a rel="noopener noreferrer" target="_blank" href={new_commit.artifacts_url}><Button style={{margin: '10px'}} className={Classes.TEXT_MUTED} icon="folder-shared-open">
          View in browser
        </Button></a>
      </div>
    </div>
  }



  update = (attribute, attribute_url) => e => {
    const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    let query = qs.parse(window.location.search.substring(1));
    this.setState({[attribute]: value,})
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute_url || attribute]: value,
      })
    });
  }

  toggle = (name, name_url) => () => {
    this.setState({[name]: !this.state[name]})
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [name_url || name]: !this.state[name],
      })
    });
  }

}

export { CommitParameters };
