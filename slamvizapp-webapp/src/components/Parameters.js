import React, { Component, Fragment, lazy, Suspense } from "react";
import { get } from "axios";
import { NonIdealState, InputGroup } from "@blueprintjs/core";


const LoadableGenericTextViewer = lazy(() => import('../viewers/text' /* webpackChunkName: "generic-text-viewer" */));



class CommitParameters extends Component {
  constructor(props) {
    super(props);
    this.state = {
      is_loaded: false,
      // configuration filenames
      configurations: [],
    };
  }


  getConfigurations() {
    get(`/api/v1/commit/${this.props.new_commit.id}?project=${this.props.project}&artifacts=configurations`)
    .then( response => {
      // to be user-friendly we show at the top the base configuration
      // this will be a list of configurations, the "default" ones at the beginning
      var configurations = [];
      // we separate the base/default configurations from the rest
      var base_configurations = [];
      response.data.forEach(c => {
        let is_base_configuration = (
          c === 'params.json' ||
          c.includes('base.json') ||
          c.includes('default.json') ||
          c.includes('base.yaml') ||
          c.includes('default.yaml')
        )
        if (is_base_configuration)
          base_configurations.push(c);
        else
          configurations.push(c);
      })
      configurations.unshift(...base_configurations)
      this.setState({configurations, is_loaded: true}, this.getParameters)      
    })
  }

  componentDidMount() {
    if (this.props.project === undefined || this.props.project === null)
      return
    if (this.props.new_commit === undefined || this.props.new_commit === null)
      return
    if (this.props.new_commit.id === undefined || this.props.id === null)
      return
    this.getConfigurations()
  }

  componentDidUpdate(previousProps) {
    let changed_project = this.props.project !== previousProps.project
    let changed_commit = (!!this.props.new_commit && !!this.props.new_commit.id) && (!!!previousProps.new_commit || !!!previousProps.new_commit.id || (this.props.new_commit.id !== previousProps.new_commit.id));
    if (changed_project || changed_commit) {
      this.setState({configurations: []})
      this.getConfigurations()
    }
  }

  render() {
    const { is_loaded, error } = this.state;
    const { new_commit, ref_commit } = this.props;
    if (new_commit === null || new_commit === undefined) return <span />;


    if (!is_loaded) return <span />;
    if (error)
      return (
        <NonIdealState
          title="An error occurred"
          description={JSON.stringify(error.response)}
        />
      );

    const many_files = this.state.configurations.length > 5
    let filter = this.state.filter || ''
    const parameters =  this.state.configurations.filter(filename => filename.toLowerCase().includes(filter.toLowerCase()))
                                                 .map(c => (
      <Fragment key={c}>
        <Suspense fallback={<span></span>}>
          <LoadableGenericTextViewer
            show
            filename={c}
            text_url_new={(!!new_commit && !!new_commit.commit_dir_url) ? `${new_commit.commit_dir_url}/${c}` : null}
            text_url_ref={(!!ref_commit && !!ref_commit.commit_dir_url) ? `${ref_commit.commit_dir_url}/${c}` : null}
          />
        </Suspense>
      </Fragment>
    ));
    return <>
      {many_files && <InputGroup style={{marginBottom: '20px'}} leftIcon='filter' placeholder="Filter by configuration name" onChange={e => this.setState({filter: e.target.value})} />}
      {parameters}
    </>
  }

}

export { CommitParameters };
