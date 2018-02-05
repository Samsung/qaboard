import React, { Component, Fragment } from "react";
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import { get, post } from "axios";


import brace from 'brace';
import AceEditor from 'react-ace';
import { EditableText, Tooltip, Callout, Icon, Button, Tag, Card, NonIdealState, Spinner, Tab, Tabs, Intent } from "@blueprintjs/core";
import { Toaster } from "@blueprintjs/core";

import Avatar from "./Avatar";
// import List from 'react-virtualized'

import { Container, Section } from "./Common";
import { OutputCard } from "./OutputCard";
import { DoneAtTag } from "./DoneAtTag";
import { MetricsSummary } from "./Metrics";
import { OutputTable } from "./Tables";


/*eslint-disable no-alert, no-console */
import 'brace/mode/json';
import 'brace/mode/diff';
import 'brace/mode/yaml';
import 'brace/theme/github';
import 'brace/ext/searchbox';
import 'brace/ext/language_tools';

export const OurToaster = Toaster.create();
// https://github.com/securingsincity/react-ace/blob/master/docs/Ace.md5

class AddRecordings extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      batches: null,

      submitted: false,
      overwrite: false,
      selected_batch: null,
    };
  }

  componentDidMount() {
    this.getBatches()
  }

  getBatches() {
   get('/api/v1/batches')
    .then(response => {
      this.setState({
        isLoaded: true,
        batches: response.data,
      })
    })
    .catch( error => {
      this.setState({isLoaded: true, error})
    })
  }

  updateBatches = newBatches => {this.setState({batches: newBatches})}
  updateOverwrite = e => {this.setState({overwrite: e.target.checked? 'on' : 'off'})}
  updateSelectedBatch = e => {this.setState({selected_batch: e.target.value})}
  onSubmit = e => {
    const { selected_batch, overwrite, batches } = this.state;
    this.setState({submitted: true})
    OurToaster.show({ message: "The request was sent!", intent: Intent.PRIMARY});
    post(`/api/v1/batch/${this.props.commit.id}`, {
      selected_batch, batches, overwrite,
    })
    .then(response => {
      this.setState({submitted: false})
      OurToaster.show({ message: "...Acknowledged!", intent: Intent.SUCCESS});
    })
    .catch( error => {
      this.setState({submitted: false})
      OurToaster.show({ message: "Something wrong happened", intent: Intent.DANGER});
    })
    e.preventDefault();
  }

  recomputeMetrics = e => {
    this.setState({submitted: true})
    OurToaster.show({ message: "The request was sent!", intent: Intent.PRIMARY});
    post(`/metrics/${this.props.commit.id}`)
    .then(response => {
      this.setState({submitted: false})
      OurToaster.show({ message: "Done!", intent: Intent.SUCCESS});
    })
    .catch( error => {
      this.setState({submitted: false})
      OurToaster.show({ message: "Something wrong happened", intent: Intent.DANGER});
    })    
  }

  render() {
    const { isLoaded, error, batches } = this.state;
    if (!isLoaded)
      return <Spinner />
    if (error)
      return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    return (
    <form onSubmit={this.onSubmit}>
      <div className="pt-form-group pt-inline">
        <label className="pt-label" htmlFor="selected-batch">
          Requested Batch
          <span className="pt-text-muted">(optionnal)</span>
        </label>
        <div className="pt-form-content">
          <input onChange={this.updateSelectedBatch} id="selected-batch" className="pt-input" style={{width: '300px'}} placeholder="Go_around_set" type="text" dir="auto" />
          <div className="pt-form-helper-text">Select a batch name from the list below:</div>
        </div>
        <label className="pt-label" htmlFor="overwrite-old-outputs"></label>
        <div className="pt-form-content">
          <label className="pt-control pt-switch">
            <input onChange={this.updateOverwrite} defaultValue='off' id="overwrite-old-outputs" type="checkbox" />
            <span className="pt-control-indicator"></span>
            Overwrite previous runs
          </label>
          <div className="pt-form-helper-text">By default we won't run the SLAM twice on the same recordings </div>
        </div>
        <Button onClick={this.recomputeMetrics} disabled={this.state.submitted} type='button'>Recompute all metrics</Button>
        <Button disabled={this.state.submitted} type='submit' intent={Intent.PRIMARY} >Send</Button>
      </div>

      <div className="pt-form-group pt-inline">
      </div>
      <AceEditor
        mode="yaml"
        theme="github"
        onChange={this.updateBatches}
        width='100%'
        name="batches"
        value={batches || ''}
        editorProps={{$blockScrolling: true}}
        setOptions={{
          enableBasicAutocompletion: true,
          enableLiveAutocompletion: true,
          tabSize: 2,
        }}
        enableBasicAutocompletion={true}
        enableLiveAutocompletion={true}
      />    
    </form>)
  }

}


class CommitLogs extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: true,
      error: null,
      logs_lsf: null,
    };
  }

  componentDidMount() {
    this.getLogs()
  }

  getLogs() {
   get(`${this.props.commit.commit_dir_url}/lsf.log`)
    .then(response => {
      this.setState({
        isLoaded: true,
        logs_lsf: response.data
      })
    })
    .catch( error => {
      this.setState({isLoaded: true, error})
    })
  }

  render() {
    const { isLoaded, error, logs_lsf } = this.state;
    if (!isLoaded)
      return <Spinner />
    if (error)
      return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    return <AceEditor
      mode="text"
      theme="github"
      readOnly
      onChange={()=>{}}
      width='100%'
      name="logs-lsf"
      value={logs_lsf || ''}
      editorProps={{$blockScrolling: true}}
    />    
  }
}




class CommitParameters extends Component {
  constructor(props) {
    super(props);
    this.state = {
      isLoaded: false,
      default_parameters: null,
    };
  }

  componentDidMount() {
    this.getParameters()
  }

  getParameters() {
   get(`${this.props.new_commit.commit_dir_url}/params.json`,
       {transformResponse: response=>response}) // avoid json parsing
    .then(response => {
      this.setState({
        isLoaded: true,
        default_parameters: response.data
      })
    })
    .catch( error => {
      this.setState({isLoaded: true, error})
    })
  }

  render() {
    const { isLoaded, error, default_parameters } = this.state;
    if (!isLoaded)
      return <Spinner />
    if (error)
      return <NonIdealState title="An error occurred" description={JSON.stringify(error.response)}/>
    return <AceEditor
      mode="json"
      theme="github"
      readOnly
      onChange={()=>{}}
      width='100%'
      name="default-parameters"
      value={default_parameters || ''}
      editorProps={{$blockScrolling: true}}
    />    
  }
}



class CiCommitResults extends Component {
  constructor(props) {
    super(props);
    this.state = {
      new_commit_id: null, // current commit to display
      ref_commit_id: null, // reference commit to display
      commits: { // store of commit information
        'default': {isLoaded: false}
      },

      filter: '',
      sort_by: 'translation_aape',
      order: -1,

      commit_logs: {},
    };
  }

  updateState() {
    const params = new URLSearchParams(this.props.location.search);
    const new_commit_id = params.get('commit_folder') || this.props.match.params[0]
    const ref_commit_id = this.state.ref_commit_id || params.get('reference') || params.get('commit_ref_folder') || 'default';
    this.setState({
        new_commit_id,
        ref_commit_id,
        commits: {
          ...this.state.commits,
          [new_commit_id]:{isLoaded:false},
          [ref_commit_id]:{isLoaded:false},
        }
    });
    this.getCiCommit(new_commit_id, 'new_commit_id');
    this.getCiCommit(ref_commit_id, 'ref_commit_id');
    this.interval_new = setInterval(x=>this.getCiCommit(new_commit_id, 'new_commit_id'), 60*1000);
    this.interval_ref = setInterval(x=>this.getCiCommit(ref_commit_id, 'ref_commit_id'), 60*1000);
  }

  componentDidMount() {
    this.updateState();
  }

  componentWillUnmount() {
    clearInterval(this.interval_new);
    clearInterval(this.interval_ref);
  }


  componentWillReceiveProps(nextProps) {
    if (this.props.match.url !== nextProps.match.url) {
      this.updateState();
    }
  }

  getCiCommit(commit_id, to_update) {
    // the API defaults to the latest commit on develop
    // we want to use this default 
    let query = commit_id==='default' ? '' : `/${commit_id}`;
    get(`http://gpu09-dt:5000/api/v1/commit${query}`, {params: {}})
      .then(response => {
        this.setState({
          [to_update]: response.data.id,
          commits: {
            ...this.state.commits,
            [response.data.id]: {
              data: response.data,
              isLoaded: true,
            }
          }
        });
      })
      .catch(error => {
        this.setState({
          commits: {
            ...this.state.commits,
            [commit_id]: {
              isLoaded: true,
            }
          }
        });
        if (error.response) {
          this.setState({
            commits: {
              ...this.state.commits,
              [commit_id]: {
                isLoaded: true,
                error: error.response.data.error,
              }
            }
          });
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          console.log(error.response.data);
          console.log(error.response.status);
          console.log(error.response.headers);
        } else if (error.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          console.log(error.request);
        } else {
          // Something happened in setting up the request that triggered an Error
          console.log("Error", error.message);
        }
        console.log(error.config);
      });
  }


  handleSubmitReference = (new_ref_commit_id) => {
    const { commits, ref_commit_id } = this.state;
    let is_git = commits[ref_commit_id].data.type==='git';
     // console.log(new_ref_commit_id.substring(0,8))
    // console.log(ref_commit_id.substring(0,8))
    if (
      ( is_git && new_ref_commit_id !== ref_commit_id.substring(0,8)) || 
      (!is_git && new_ref_commit_id !== ref_commit_id)
    )
    this.setState({
      ref_commit_id: new_ref_commit_id,
      commits: {
        ...this.state.commits,
        [new_ref_commit_id]:{isLoaded:false},
      }
    }, this.updateState);
  }

  handleFilterChange = (event) => {
    this.setState({
      filter: event.target.value,
    });
  }

  filter_commit = commit => {
    let commit_filtered = Object.create(commit)
    commit_filtered.slam_outputs = {}
    Object.entries(commit.slam_outputs).forEach( ([id, output])=> {
      if (`${output.recording_path} ${output.platform} ${output.configuration}`.includes(this.state.filter)) {
        commit_filtered.slam_outputs[id] = output;
      }
    });
    return commit_filtered;
  }

  selectSortBy = e => {
    this.setState({sort_by: e.target.value})
  }
  selectOrder = e => {
    this.setState({order: e.target.value})
  }

  sortOutputs = ([ka,a], [kb,b]) => {
    const { sort_by } = this.state;
    if (a[sort_by] > b[sort_by]) {
      return this.state.order;
    }
    if (a[sort_by] < b[sort_by]) {
      return -this.state.order;
    }
    return 0;
  }

  render() {
    // console.log(this.state);
    var { commits, new_commit_id, ref_commit_id } = this.state;

    if (!new_commit_id || !new_commit_id)
      return <Section><NonIdealState
        title="No commit selected"
        description="Please first select a commit."
        visual="pt-icon-folder-open"
      /></Section>

    var new_commit_ = commits[new_commit_id];
    var ref_commit_ = commits[ref_commit_id];
    if (!new_commit_.isLoaded || !ref_commit_.isLoaded)
      return (
        <Container>
          <NonIdealState
            title="Loading"
            visual={<Spinner/>}
          />              
        </Container>
      )

    if (new_commit_.error || ref_commit_.error) {
      var error_description = <span>
        {new_commit_.error && <span><strong>{new_commit_id}:</strong> {new_commit_.error}</span>}
        {new_commit_.error && ref_commit_.error && <br/>}
        {ref_commit_.error && <span><strong>{ref_commit_id}:</strong> {ref_commit_.error}</span>}
      </span>
      return (
        <Container>
          <NonIdealState
            title="Network Error"
            description={error_description} visual="pt-icon-error"
          />
        </Container>
      )
    }

    var new_commit = new_commit_.data;
    var ref_commit = ref_commit_.data;

    let status_messages = (
      <Section>
       {new_commit.pending_slam_outputs.length>0 &&
          <Callout
            iconName="info-sign"
            intent={Intent.WARNING}
            title={
              <Tooltip>
              <span>Still waiting for some ({new_commit.pending_slam_outputs.length}) SLAM</span>
              <ul>{new_commit.pending_slam_outputs.map(o=><li key={o}>{o}</li>)}</ul>
              </Tooltip>
          }>
          </Callout>}
       {new_commit.failed_slam_outputs.length>0 &&
          <Callout
            iconName="error"
            intent={Intent.DANGER}
            title={
              <Tooltip>
                <span>{new_commit.failed_slam_outputs.length} crashed in this commit</span>
                <ul>{new_commit.failed_slam_outputs.map(o=><li key={o}>{o}</li>)}</ul>
              </Tooltip>
            }>
            <p>Maybe the <a href={`${new_commit.commit_dir_url}/lsf.log`}>LSF logs</a> can help debug this.
            <br/>Consider adding <a href="http://gitlab-srv/dvs/psp_swip/blob/develop/CMakeLists.txt#L43">instrumentation flags</a> for the compiler.</p>
          </Callout>}
      </Section>
    );

    let new_commit_filtered = this.filter_commit(new_commit)
    let ref_commit_filtered = this.filter_commit(ref_commit)

    var result = (
      <Container>
        <CommitCompareCard new_commit={new_commit_filtered} ref_commit={ref_commit} onConfirmReference={this.handleSubmitReference}/>
        {status_messages}

        <Section>
          <Card elevation={2}>
          <Tabs id="tabs-summary">
              <Tab id="metrics" title="Performance Summary" panel={<MetricsSummary new_commit={new_commit_filtered} ref_commit={ref_commit_filtered} />} />
              <Tab id="parameters" title="Parameters" panel={<CommitParameters new_commit={new_commit}/>} />
              <Tab id="logs" title="Logs" panel={<CommitLogs commit={new_commit}/>} />
              <Tab id="re-run" title="Add recordings" panel={<AddRecordings commit={new_commit} />} />
          </Tabs>
          </Card>
        </Section>

        <Section>
          <Tabs renderActiveTabPanelOnly id="tabs-outputs">
            <Tab id="output-table" title="Summary Table" panel={<OutputTable output_sort={this.sortOutputs} new_commit={new_commit_filtered} ref_commit={ref_commit_filtered}/>} />
            <Tab id="output-list" title="Details" panel={<OutputList output_sort={this.sortOutputs} new_commit={new_commit_filtered} ref_commit={ref_commit_filtered} />} />
            <Tabs.Expander />
            <div className="pt-input-group .modifier">
              <span className="pt-icon pt-icon-search"></span>
              <input onChange={this.handleFilterChange} className="pt-input" type="search" placeholder="Filter outputs" dir="auto" />
            </div>
            <div className="pt-select">
              <select defaultValue="translation_aape" onChange={this.selectSortBy}>
                <option value="translation_aape">Sort by AAPE</option>
                <option value="recording_path">Sort by recording path</option>
                <option value="rotation_mean">Sort by mean rotation error</option>
              </select>
              <select defaultValue="descending" onChange={this.selectOrder}>
                <option value={-1}>descending</option>
                <option value={1}>ascending</option>
              </select>
            </div>
          </Tabs>
        </Section>

      </Container>
    );
    // <form onSubmit={this.handleReferenceSubmit}><input onChange={this.handleReferenceChange} className="pt-input" type="text" placeholder="Compare to a different commit..." /></form>
    return result;
  }
}



const CommitCompareCard = ({new_commit, ref_commit, onConfirmReference}) => (
  <Section>
    <Card elevation={4}>
      <div style={{display:'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <div style={{flex:'1 1 auto'}}>
          <h1><Avatar alt={new_commit.committer_name} src={new_commit.committer_avatar_url} />{new_commit.type==='git' ? new_commit.id.substring(0,8) : new_commit.id} </h1>
            <Link to={`/branch/${new_commit.branch}`}><Button className="pt-minimal" iconName="git-branch">{new_commit.branch}</Button></Link>
            <br/>
            <DoneAtTag commit={new_commit} /> <Tag>{new_commit.valid_slam_outputs.length} LSF outputs</Tag> <Tag intent={Intent.WARNING}>New</Tag>
            <p style={{marginTop: '10px', maxWidth:'450px'}} className="pt-monospace-text">{new_commit.message}</p>
          </div>
        <div><Icon iconName="small-cross"></Icon></div>
        <div style={{flex:'1 1 auto', float:'right', textAlign: 'right'}}>
          <h1><EditableText onConfirm={onConfirmReference} intent={Intent.PRIMARY} defaultValue={ref_commit.type==='git' ? ref_commit.id.substring(0,8) : ref_commit.id} /></h1>
            <Link to={`/branch/${ref_commit.branch}`}><Button className="pt-minimal" iconName="git-branch">{ref_commit.branch}</Button></Link>
            <br/>
            <DoneAtTag commit={ref_commit} /> <Tag>{ref_commit.valid_slam_outputs.length} LSF outputs</Tag> {ref_commit.failed_slam_outputs.length>0 && <Tag intent={Intent.DANGER}>{ref_commit.failed_slam_outputs.length} crashed</Tag>} {ref_commit.failed_slam_outputs.length>0 && <Tag intent={Intent.WARNING}>{ref_commit.pending_slam_outputs.length} pending</Tag>} <Tag>Reference</Tag>
            <p style={{marginTop: '10px'}} className="pt-monospace-text">{ref_commit.message}</p>
        </div>
      </div>
    </Card>
  </Section>
)



class OutputList extends React.Component {
  render() {
    const {new_commit, ref_commit, output_sort} = this.props;
    // https://github.com/bvaughn/react-virtualized/blob/master/docs/List.md
    return <Fragment>
            <div style={{display:'flex', justifyContent: 'space-between', flexFlow: 'row wrap'}}>
              {Object.entries(new_commit.slam_outputs)
                     .sort(output_sort)
                     .map( ([id, output]) => {
                        // we need to find a matching output - by path name for now...
                        // ideally we'd split the list of outputs by recording name and not id, 
                        // and display lsf/s8 curves serparately,,,
                        let matching_ref_outputs = Object.values(ref_commit.slam_outputs)
                          .filter(o => o.recording_path===output.recording_path)
                        let output_ref = matching_ref_outputs[0];
                        return <OutputCard
                          key={id}
                          output_new={output}
                          output_ref={output_ref}
                        />;
              })}
            </div>
           </Fragment>

  }
}



export default withRouter(CiCommitResults);
