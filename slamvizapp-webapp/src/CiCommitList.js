import React, { Fragment } from "react";
import { withRouter } from 'react-router'
import { Link } from "react-router-dom";
import { get } from "axios";
import styled from "styled-components";

import Moment from 'react-moment';
import moment from 'moment';
import 'moment-timezone';

import { Button, Icon, Intent, Tooltip, NonIdealState, Spinner, Tag, Callout } from "@blueprintjs/core";
import { DateRangeInput } from "@blueprintjs/datetime";
import { CopyToClipboard } from 'react-copy-to-clipboard';

import { Container, Section } from "./common/containers";
import { DoneAtTag } from "./common/DoneAtTag";
import { Avatar } from "./common/Avatar";
import { groupBy, calendarStrings } from "./common/utils";
import { CommitsEvolution } from './CommitsEvolution'
import { slam_metrics, main_metrics } from './slam/metrics'
import { shortId } from "./common/utils";


import { Toaster } from "@blueprintjs/core";
export const OurToaster = Toaster.create();


const HeaderDay = styled.li`
  border-top-width: 0;
  padding: 5px 10px;
  background-color: #fafafa;
  border-bottom: 1px solid #eee;
  border-top: 1px solid #eee;
  font-size: 14px;
`;

const DayRows = styled.li``;

const WrapperCommitRows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const CommitRowWrapper = styled.li`
  display: flex;
  border-color: #f0f0f0;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.85);
  padding: 10px 0;
  border-bottom: 1px solid #eee;
  margin: 0;
`;


const Message = styled.span`
  font-weight: 600;
`

const CommitDetails = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-grow: 1;
  padding-left: 10px;
`;

const CommitContent = styled.div`
  padding-right: 10px;
  max-width:750px;
`;



class CommitResults extends React.Component {
  render() {
    const { project, commit } = this.props;
    const gitlab_commit_url = `http://gitlab-srv/dvs/psp_swip/commit/${commit.id}`;
    let ci_batch = commit.batches.default;
    if (ci_batch===undefined || (ci_batch.failed_outputs===0 && ci_batch.valid_outputs===0 && ci_batch.pending_outputs===0))
      return (<a style={{color:'grey'}} href={gitlab_commit_url}><Button intent={Intent.WARNING} className="pt-minimal">Check the pipeline status..</Button></a>);

    let formatter = new Intl.NumberFormat('en-US', {style:'decimal', minimumFractionDigits:2, maximumFractionDigits:2});
    let status_messages = (
      <Fragment>
         {ci_batch.pending_outputs-ci_batch.running_outputs>0 &&
            <Tag className="pt-minimal" style={{marginRight:'4px'}}>{ci_batch.pending_outputs-ci_batch.running_outputs} pending</Tag>}
         {ci_batch.running_outputs>0 &&
            <Tag className="pt-minimal" style={{marginRight:'4px'}} intent={Intent.PRIMARY}>{ci_batch.running_outputs} running</Tag>}
         {ci_batch.failed_outputs>0 &&
            <Link style={{marginLeft: '10px'}} to={`/commit/${commit.id}`}>
              <Button intent={Intent.DANGER} className="pt-minimal">{ci_batch.failed_outputs} crashed</Button>
            </Link>}
         { Object.keys(commit.batches).length > 1 &&
            <Tooltip>
              <Tag intent={Intent.SUCCESS} className="pt-minimal" style={{marginRight:'4px'}}>{Object.keys(commit.batches).length-1} tuning experiments</Tag>
              <ul>{ Object.keys(commit.batches).filter(n=>n!=='default').map( name =>
                <li key={name}><strong>{name}</strong></li>
              )}</ul>
            </Tooltip>
         }
         {ci_batch.valid_outputs>0 && ci_batch.aggregated_metrics.translation_rmse_median>0 &&
            <Fragment>
              <Tag className="pt-minimal" style={{marginRight:'4px'}}><strong>{formatter.format(100*ci_batch.aggregated_metrics.translation_aape_median)}cm</strong> median </Tag>
              <Tag style={{marginRight:'4px'}} className="pt-minimal"><strong>{formatter.format(100*ci_batch.aggregated_metrics.translation_aape_average)}cm</strong> avg AAPE</Tag>
              <Tooltip modifiers>
                <Tag className="pt-minimal pt-round">...</Tag>
                <ul>
                { Object.entries(ci_batch.aggregated_metrics).map( ([k,v]) =>
                  <li key={k}><strong>{k}:</strong> {formatter.format(v)}</li>
                )}
                </ul>
              </Tooltip>
            </Fragment>
            }
      </Fragment>
    );
    return (
      <div>
      {status_messages}
      {ci_batch.valid_outputs>0 &&
          <Link style={{marginLeft: '10px'}} to={`/commit/${commit.id}?project=${project}`}>
            <Button intent={Intent.SUCCESS} text={`${ci_batch.valid_outputs} results`}/>
          </Link>
      }
      </div>
    )
  }
}
const CommitResultsStyled = styled(CommitResults)`
  margin-left: auto;
`;



const CommitShortId = styled.a`
  font-family: "Menlo", "Liberation Mono", "Consolas", "DejaVu Sans Mono", "Ubuntu Mono", "Courier New", "andale mono", "lucida console", monospace;
  font-weight: 600;
  color: #1b69b6;
`

class CommitRow extends React.Component {
  render() {
    const {commit, project, className} = this.props;
    const commit_url = project === 'dvs/psp_swip' ? `http://gitlab-srv/${project}/commit/${commit.id}` : '#sorry-not-yet-available';
    return (
      <CommitRowWrapper className={className}>
        <Avatar alt={commit.committer_name} href={`/committer/${commit.committer_name}?project=${project}`} src={commit.committer_avatar_url} />

        <CommitDetails>
          <CommitContent style={{maxWidth: '600px'}}>
            <Message>{commit.message}</Message>
            <div>
              <CommitShortId project={project} href={commit_url}>{shortId(project, commit.id)}</CommitShortId>
              <Tooltip>
                <CopyToClipboard text={commit.id} onCopy={() => {OurToaster.show({ message: "Copied to clipboard!", intent: Intent.PRIMARY})}}>
                  <Icon title="copy to clipboard" intent={Intent.PRIMARY} className="pt-minimal pt-small" icon="clipboard" />
                </CopyToClipboard>
                <span>Copy to clipboard</span>
              </Tooltip>
              <Icon icon="pt-icon-git-branch"/> 
              <Link style={{color:'rgba(0,0,0,0.85)'}} to={`/branch/${commit.branch}?project=${project}`}>{commit.branch}</Link> 
              <DoneAtTag commit={commit}/>
            </div>
          </CommitContent>

          <CommitResultsStyled project={project} commit={commit} />
        </CommitDetails>
      </CommitRowWrapper>);

  }
};






const CommitRows = ({ commits, project, className }) => (
  <div className={className}>
    <DayRows>
      <WrapperCommitRows>
        {commits.map(commit => (
          <CommitRow commit={commit} project={project} key={commit.id} />
        ))}
      </WrapperCommitRows>
    </DayRows>
  </div>
);

class CiCommitList extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(this.props.location.search);
    let aggregation_metrics = {}
    main_metrics.forEach(m => aggregation_metrics[m] = slam_metrics[m].threshold)
    this.state = {
      project: params.get('project') || 'dvs/psp_swip',
      date_range: [
        new Date(moment().subtract(3,'d')),
        new Date()
      ],
      error: null,
      isLoaded: false,
      commits: [],
      aggregation_metrics
    };
  }

  componentWillReceiveProps(nextProps) {
    if (this.props.location.pathname!==nextProps.location.pathname || this.props.location.search!==nextProps.location.search) {
      this.getData(nextProps);
    }
  }

  getData(props) {
    const { match } = props;
    const { project, date_range } = this.state;

    var url;
    if (match.path.startsWith('/committer')) {
      url = `/api/v1/commits?committer=${match.params[0]}`;      
    } else {
      var branch = ''
      if (match.params[0])
        branch = `/${match.params[0]}`
      url = `/api/v1/commits${branch}`;
    }
    document.title = match.params[0] || project;

    get(url, {
      params: {
        project,
        from: date_range[0],
        to: date_range[1],
        metrics: JSON.stringify(this.state.aggregation_metrics)
      },
    })
      .then(response => {
        let commits = response.data;
        this.setState({
          isLoaded: true,
          commits,
        });
        if (commits.length > 0)
          this.setState({
            date_range: [
              new Date(commits[commits.length-1].authored_datetime),
              new Date(commits[0].authored_datetime)
            ],            
          })
      })
      .catch(error => {
        this.setState({
          isLoaded: true,
          error
        });
        if (error.response) {
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

  componentDidMount() {
    this.getData(this.props);
    this.interval = setInterval(x=>this.getData(this.props), 60*1000);
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  render() {
    const { error, isLoaded, project, commits, date_range } = this.state;
    const { match } = this.props;
    let is_committer = match.path.startsWith('/committer');
    let is_branch = match.path.startsWith('/branch');
    if (is_branch || is_committer)
      var tag = this.props.match.params[0]
    else
      tag = 'all latest commits';

    // commits.filter( c => c.batches.default!==undefined )
           // .map( c => c.batches.default.aggregated_metrics.translation_aape_average )
    var information = (
      <Fragment>
        <Section>
          <Callout icon="info-sign" intent={Intent.PRIMARY} title="Useful links" style={{marginBottom:'20px'}}>
          <ul>
            <li><a href="http://gitlab-srv/dvs/psp_swip/pipelines">Gitlab CI pipelines</a></li>
            <li><a href="http://gitlab-srv/dvs/psp_swip/wikis/faq/ci-failures">FAQ: When did my CI fail?</a></li>
          </ul>
          </Callout>
        </Section>
        <Section>
          <h3>Reports for <Link to="/branch/origin/develop"><Button icon="git-branch">develop</Button></Link></h3>
          <p><a href="http://gitlab-srv/dvs/psp_swip/commits/develop"><img src="http://gitlab-srv/dvs/psp_swip/badges/develop/build.svg" alt="build status"/></a><a href="/s/branches/develop/coverage/index.html"> <img alt="coverage report" src="http://gitlab-srv/dvs/psp_swip/badges/develop/coverage.svg"/></a><a href="/s/branches/develop/doxygen/index.html"> <img src="https://img.shields.io/badge/docs-develop-green.svg" alt="documentation"/></a></p>
        </Section>
      </Fragment>
    );
    if (project !== 'dvs/psp_swip')
      information = (
        <Fragment>
          <Section>
            <Callout icon="info-sign" intent={Intent.PRIMARY} title="How do we make a CI like the SLAM's ?" style={{marginBottom:'20px'}}>
            <ul>
              <li><strong>TODO</strong> Output viewer</li>
              <li><strong>TODO</strong> KPI, metrics</li>
              <li><strong>TODO</strong> Links to the build status, docs, jenkins/gitlab, coverage reports...</li>
              <li><strong>TODO</strong> Links to build status, docs</li>
              <li><strong>TODO</strong> Dashboard</li>
              <li><strong>TODO</strong> Hooks to keep in sync</li>
              <li><strong>TODO</strong> Tuning</li>
            </ul>
            </Callout>
          </Section>
        </Fragment>
      );

    let link_to_tag = is_branch ? <Link to={`/branch/${tag}`}><Button icon="git-branch">{tag}</Button></Link>
                                 : (is_committer ? <Link to={`/committer/${tag}`}><Button icon="user">{tag}</Button></Link>
                                                 : tag)
    let qa_report = <Section>{isLoaded && !error && 
      <div>
        <h3>Evolution for {link_to_tag}</h3>
        <DateRangeInput
          value={date_range}
          maxDate={new Date()}
          allowSingleDayRange
          formatDate={date => (date == null ? "" : date.toLocaleDateString())}
          parseDate={str => new Date(Date.parse(str))}
          onChange={new_date_range => {this.setState({ date_range: new_date_range, isLoaded: false }, c => this.getData(this.props))} }
          shortcuts
        />
        <CommitsEvolution project={this.state.project} commits={commits} style={{marginTop: '20px'}}/>
      </div>
    }</Section>;

    var list;
    var warning_messages;
    if (error)
      warning_messages = <NonIdealState description={error.message} visual="error"/>;
    if (!isLoaded)
      warning_messages = <NonIdealState title="Loading" visual={<Spinner/>} />;
    if (commits.length===0 && isLoaded)
      warning_messages = <NonIdealState title="No results" description={`Searched commits from ${date_range[0]} to ${date_range[1]}`} visual="folder-open" />; 

    let commits_by_day = groupBy(commits, "authored_date");

    list = (
      <Fragment>
        <h3>Selected commits</h3>
        {Object.keys(commits_by_day).map(day => (
          <Fragment key={day}>
            <HeaderDay>
              <Moment calendar={calendarStrings} tz='Asia/Jerusalem' date={day}></Moment> &#8212; {commits_by_day[day].length} commits
            </HeaderDay>
            <CommitRows project={project} commits={commits_by_day[day]} />


          </Fragment>
        ))}
      </Fragment>
    );
    return (
      <Container>
        {information}
        {qa_report}
        {warning_messages}
        {isLoaded && list}
      </Container>
    );
  }
}




export default withRouter(CiCommitList);
