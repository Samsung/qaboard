import React, { Fragment } from "react";
import { withRouter } from 'react-router'
import { Link } from "react-router-dom";
import queryString from "query-string";

import { get } from "axios";
import styled from "styled-components";

import { Button, Icon, Intent, Tooltip, NonIdealState, Spinner, ButtonGroup, Tag, Callout } from "@blueprintjs/core";
import { Container, Section } from "./Common";
import {CopyToClipboard} from 'react-copy-to-clipboard';
import Avatar from "./Avatar";
import { DoneAtTag } from "./DoneAtTag";

import Moment from 'react-moment';
import 'moment-timezone';


const groupBy = (array, prop) => {
  return array.reduce(function(groups, item) {
    var val = item[prop];
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {});
};


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
    const {commit} = this.props;
    const gitlab_commit_url = `http://gitlab-srv/dvs/psp_swip/commit/${commit.id}`;
    if (commit.valid_slam_outputs.length === 0 && commit.pending_slam_outputs.length === 0)
      return (<a style={{color:'grey'}} href={gitlab_commit_url}><Button intent={Intent.WARNING} className="pt-minimal">Check the pipeline status..</Button></a>);

    let formatter = new Intl.NumberFormat('en-US', {style:'decimal', minimumFractionDigits:2, maximumFractionDigits:2});
    let status_messages = (
      <Fragment>
         {commit.pending_slam_outputs.length>0 &&
            <Tag className="pt-minimal">{commit.pending_slam_outputs.length} pending...</Tag>}
         {commit.failed_slam_outputs.length>0 &&
            <a href={`${commit.commit_dir_url}/lsf.log`}><Button intent={Intent.DANGER} className="pt-minimal">{commit.failed_slam_outputs.length} crashed</Button></a>}
         {commit.valid_slam_outputs.length>0 && commit.aggregated_metrics.translation_rmse_median>0 &&
            <Fragment>
              <Tag className="pt-minimal" style={{marginRight:'4px'}}><strong>{formatter.format(100*commit.aggregated_metrics.translation_aape_median)}cm</strong> median </Tag>
              <Tag style={{marginRight:'4px'}} className="pt-minimal"><strong>{formatter.format(100*commit.aggregated_metrics.translation_aape_average)}cm</strong> avg AAPE</Tag>
              <Tooltip modifiers>
                <Tag style={{marginTop:'3px'}} className="pt-minimal pt-round">...</Tag>
                <ul>
                { Object.entries(commit.aggregated_metrics).map( ([k,v]) =>
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
      {commit.valid_slam_outputs.length>0 &&
          <Link style={{marginLeft: '10px'}} to={`/commit/${commit.id}`}>
            <Button intent={Intent.SUCCESS} text={`${commit.valid_slam_outputs.length} results`}/>
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
    const {commit, className} = this.props;
    const gitlab_commit_url = `http://gitlab-srv/dvs/psp_swip/commit/${commit.id}`;
    return (
      <CommitRowWrapper className={className}>
        <Avatar alt={commit.committer_name} href={`/committer/${commit.committer_name}`} src={commit.committer_avatar_url} />

        <CommitDetails>
          <CommitContent>
            <Message>{commit.message}</Message>
            <div>
              <CommitShortId href={gitlab_commit_url}>{commit.id.substring(0,8)}</CommitShortId> 
              <CopyToClipboard text={commit.id} onCopy={() => {}}>
                <Icon title="copy to clipboard" style={{color:'rgba(27, 105, 182, .8)', marginRight: '3px'}} iconName="pt-icon-clipboard" />
              </CopyToClipboard>
              <Icon iconName="pt-icon-git-branch"/> 
              <Link style={{color:'rgba(0,0,0,0.85)'}} to={`/branch/${commit.branch}`}>{commit.branch}</Link> 
              <DoneAtTag commit={commit}/>
            </div>
          </CommitContent>

          <CommitResultsStyled commit={commit} />
        </CommitDetails>
      </CommitRowWrapper>);

  }
};






const CommitRows = ({ commits, className }) => (
  <div className={className}>
    <DayRows>
      <WrapperCommitRows>
        {commits.map(commit => (
          <CommitRow commit={commit} key={commit.id} />
        ))}
      </WrapperCommitRows>
    </DayRows>
  </div>
);

class CiCommitList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      page: 0,
      error: null,
      isLoaded: false,
      commits: []
    };
  }

  componentWillReceiveProps(nextProps) {
    if (this.props.location.pathname!==nextProps.location.pathname || this.props.location.search!==nextProps.location.search) {
      this.getData(nextProps);
    }
  }

  getData(props) {
    const { match } = props;
    const params = new URLSearchParams(props.location.search);
    const count = params.get('count') || 20;
    const page = parseFloat(params.get('page')) || 0;
    this.setState({page});

    var url;
    if (match.path.startsWith('/committer')) {
      url = `/api/v1/commits?committer=${match.params[0]}`;      
    } else {
      var branch = ''
      if (match.params[0])
        branch = `/${match.params[0]}`
      url = `/api/v1/commits${branch}`;
    }

    get(url, {
      params: {
        page, count,
      },
    })
      .then(response => {
        // console.log(response.data);
        this.setState({
          isLoaded: true,
          commits: response.data
        });
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

  paginatorOnClick = (event) => {
    const page = event.target.value;
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: queryString.stringify(Object.assign({}, queryString.parse(this.props.location.search), { page }))
    })
  }

  render() {
    const { error, isLoaded, commits, page } = this.state;

    let information = (
      <Fragment>
        <Section>
          <Callout iconName="info-sign" intent={Intent.PRIMARY} title="Useful links" style={{marginBottom:'20px'}}>
          <ul>
            <li><a href="http://gitlab-srv/dvs/psp_swip/pipelines">Gitlab CI pipelines</a></li>
            <li><a href="http://gitlab-srv/dvs/psp_swip/wikis/faq/ci-failures">FAQ: When did my CI fail?</a></li>
          </ul>
          </Callout>
        </Section>
        <Section>
          <h3>Reports for branch <code><Icon iconName="git-branch"/>develop</code></h3>
          <p><a href="http://gitlab-srv/dvs/psp_swip/commits/develop"><img src="http://gitlab-srv/dvs/psp_swip/badges/develop/build.svg" alt="build status"/></a><a href="/s/branches/develop/coverage/index.html"> <img alt="coverage report" src="http://gitlab-srv/dvs/psp_swip/badges/develop/coverage.svg"/></a><a href="/s/branches/develop/doxygen/index.html"> <img src="https://img.shields.io/badge/docs-develop-green.svg" alt="documentation"/></a></p>
        </Section>
      </Fragment>
    );


    var list;
    var warning_messages;
    if (error)
      warning_messages = <NonIdealState description={error.message} visual="pt-icon-error"/>;
    if (!isLoaded)
      warning_messages = <NonIdealState title="Loading" visual={<Spinner/>} />;
    if (commits.length===0 && isLoaded)
      warning_messages = <NonIdealState title="No results" description="Your search didn't return any commit." visual="pt-icon-folder-open" />; 

    let commits_by_day = groupBy(commits, "authored_date");
    // we should do something like this instead.
    // https://github.com/bvaughn/react-virtualized/blob/master/source/InfiniteLoader/InfiniteLoader.example.js
    //  active ? Link
    let paginator =  (
      <ButtonGroup large style={{marginTop: '25px'}} onClick={this.paginatorOnClick}>
        {page>0 && <Button value={page-1} iconName="pt-icon-arrow-left">Previous</Button>}
        {page>0 && <Button value={page-1}>{page-1}</Button>}
        {page>1 && <Button value={page-2}>{page-2}</Button>}
        <Button value={page} disabled intent={Intent.PRIMARY} >{page}</Button>
        <Button value={page+1}>{page+1}</Button>
        <Button value={page+2}>{page+2}</Button>
        <Button value={page+3}>{page+3}</Button>
        <Button value={page+1} iconName="pt-icon-arrow-right">Next</Button>
      </ButtonGroup>
    )

    list = (
      <Fragment>
        <h3>Recent commits</h3>
        {Object.keys(commits_by_day).map(day => (
          <Fragment key={day}>
            <HeaderDay>
              <Moment calendar={calendarStrings} tz='Asia/Jerusalem' date={day}></Moment> &#8212; {commits_by_day[day].length} commits
            </HeaderDay>
            <CommitRows commits={commits_by_day[day]} />


          </Fragment>
        ))}
        {paginator}
      </Fragment>
    );
    return (
      <Container>
        {information}
        {warning_messages}
        {isLoaded && list}
      </Container>
    );
  }
}


const calendarStrings = {
    lastDay : '[Yesterday]',
    sameDay : '[Today]',
    nextDay : '[Tomorrow]',
    lastWeek : '[last] dddd',
    nextWeek : 'dddd',
    sameElse : 'L'
};

export default withRouter(CiCommitList);
