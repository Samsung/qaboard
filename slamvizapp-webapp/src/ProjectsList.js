import React from "react";
import { withRouter } from 'react-router'
import { Link } from "react-router-dom";
import { get } from "axios";
import Moment from 'react-moment';

import { Container } from "./common/containers";
import { Intent, Card, Callout, NonIdealState, Spinner } from "@blueprintjs/core";
import { Icon, Tooltip } from "@blueprintjs/core";


class LastCommitAt extends React.Component {
  render() {
    const { project, className } = this.props;
    let date = project.latest_commit_datetime
    return (
      <span className={className}>
        <Icon style={{color: '#1aaa55', marginRight: '3px'}} icon='updated'/>
        <Tooltip content={date}>
          <Moment style={{color: '#555'}} fromNow tz='Asia/Jerusalem' date={date} />
        </Tooltip>
      </span>
    )
  }
}


class ProjectsList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
      is_loaded: false,
      projects: {}
    };
  }

  componentDidMount() {
    get("/api/v1/projects")
    .then(response=>{
       this.setState({
         projects: response.data,
         is_loaded: true,
       });
    })
    .catch(error => {
      this.setState({is_loaded: true});
      console.error(error);
    })
  };


  render() {
    const { error, is_loaded, projects } = this.state;
    let warnings;
    if (error)
      warnings = <NonIdealState description={error.message} visual="error"/>;
    if (!is_loaded)
      warnings = <NonIdealState title="Loading" visual={<Spinner/>} />;

    let list_projects = <div>
      {Object.entries(projects)
             .sort( ([id0, d0], [id1, d1]) => new Date(d1.latest_commit_datetime) - new Date(d0.latest_commit_datetime))
             .map( ([id, details]) => {
               return <Card
                        key={id}
                        style={{margin: '15px'}}
                        interactive
                        elevation={2}
                        onClick={e => this.props.history.push(`/?project=${id}`)}
                      >
                        <h5><Link to={`/?project=${id}`}>{id}</Link> {details.information && details.information.git && <a href={details.information.git.homepage}><Icon icon="link"/></a>}</h5>
                          <LastCommitAt project={details}/><br/>
                          <span style={{color: '#555'}}>{details.total_commits} commits</span>
                </Card>})}
    </div>

    return <Container>
      <Callout intent={Intent.PRIMARY}>
        <h4>Your project is missing?</h4>
        <p>Ask <a href="mailto:arthur.flam@samsung.com">Arthur</a>!</p>
      </Callout>
      {warnings}
      {list_projects}
    </Container>
  }
}

export default withRouter(ProjectsList);
