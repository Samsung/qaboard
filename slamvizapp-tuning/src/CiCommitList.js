import React, { Fragment } from "react";
import { Link } from "react-router-dom";

import { get } from "axios";
import styled from "styled-components";

import { Button, Icon, Intent, Tooltip, NonIdealState, Spinner } from "@blueprintjs/core";

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

const Container = styled.div`
  padding-left: 0;
  list-style: none;
  margin-top: 20px;
  margin-bottom: 10px;
  box-sizing: border-box;

  padding-right: 15px;
  padding-left: 15px;
  margin-right: auto;
  margin-left: auto;
  @media (min-width: 768px) {
    width: 750px;
  }
  @media (min-width: 992px) {
    width: 970px;
  }
  @media (min-width: 1200px) {
    width: 1170px;
  }
`;

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

const AvatarCell = styled.div`
  width: 46px;
  padding-left: 10px;
  color: rgba(0,0,0,0.85);
`

const Avatar = styled.img`
  width: 36px;
  height: 36px;
  margin-right: 10px;
  padding: 0;

  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  float: left;
  transition: border-color 100ms linear
  vertical-align: middle;
`

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
    const {ci_commit, className} = this.props;
    const gitlab_commit_url = `http://gitlab-srv/dvs/psp_swip/commit/${ci_commit.id}`;
    if (ci_commit.failed_slam_outputs.length > 0 && ci_commit.pending_slam_outputs.length === 0)
      return (<a style={{color:'darkred'}} href={`${ci_commit.commit_dir_url}}/lsf.log`}>Check the LSF logs</a>)
    if (ci_commit.valid_slam_outputs.length === 0 && ci_commit.pending_slam_outputs.length === 0)
      return (<span className={className}><a style={{color:'grey'}} href={gitlab_commit_url}>Check the pipeline status..</a></span>);

    let formatter = new Intl.NumberFormat('en-US', {style:'decimal', minimumFractionDigits:3, maximumFractionDigits:3});
    let status_messages = (
      <Fragment>
         {ci_commit.pending_slam_outputs.length>0 &&
            <span style={{color: 'grey', marginRight: '10px'}}>{ci_commit.pending_slam_outputs.length} pending...</span>}
         {ci_commit.failed_slam_outputs.length>0 &&
            <a style={{color: "red", textDecoration: "underline", marginRight: '10px'}} href={`${ci_commit.commit_dir_url}/lsf.log`}>{ci_commit.failed_slam_outputs.length} crashed</a>}
         {ci_commit.aggregated_metrics.translation_rmse_median>0 &&
            <Tooltip content={JSON.stringify(ci_commit.aggregated_metrics, null, '\t')}>
              <span><strong>{formatter.format(100*ci_commit.aggregated_metrics.translation_rmse_median)}cm</strong> RMSE</span>
            </Tooltip>
            }
      </Fragment>
    );
    return (
      <div>
      {status_messages}
      {ci_commit.valid_slam_outputs.length>0 &&
          <Link style={{marginLeft: '10px'}} to={`/commit/${ci_commit.id}`}>
            <Button intent={Intent.SUCCESS} text={`${ci_commit.valid_slam_outputs.length} results`}/>
          </Link>
      }
      </div>
    )
  }
}
const CommitResultsStyled = styled(CommitResults)`
  margin-left: auto;
`;

class WhenFinished extends React.Component {
  render() {
    const {ci_commit, className} = this.props;
    return (
      <span className={className}>
        <Icon style={{color:'#999'}} iconName="pt-icon-calendar"/> 
        <Tooltip content={ci_commit.authored_datetime}><Moment fromNow tz='Asia/Jerusalem' date={ci_commit.authored_datetime} /></Tooltip> by {ci_commit.committer_name}
      </span>
    )
  }
}
const WhenFinishedStyled = styled(WhenFinished)`
  color: rgba(0,0,0,0.55);
  white-space: nowrap;
  box-sizing: border-box;
  margin-left: 5px;
`;


const CommitShortId = styled.a`
  font-family: "Menlo", "Liberation Mono", "Consolas", "DejaVu Sans Mono", "Ubuntu Mono", "Courier New", "andale mono", "lucida console", monospace;
  font-weight: 600;
  color: #1b69b6;
`


class CommitRow extends React.Component {
  render() {
    const {ci_commit, className} = this.props;
    const gitlab_commit_url = `http://gitlab-srv/dvs/psp_swip/commit/${ci_commit.id}`;
    return (
      <CommitRowWrapper className={className}>
        <AvatarCell>
          <a href={`http://gitlab-srv/${ci_commit.author}`}>
            <Avatar alt={ci_commit.committer_name} src={ci_commit.committer_avatar_url}/>
          </a>
        </AvatarCell>

        <CommitDetails>
          <CommitContent>
            <Message>{ci_commit.message}</Message>
            <div>
              <Icon iconName="pt-icon-git-commit" /> 
              <CommitShortId href={gitlab_commit_url}>{ci_commit.id.substring(0,8)} </CommitShortId> 
              <Icon iconName="pt-icon-fork"/> 
              <Link style={{color:'rgba(0,0,0,0.85)'}} to={`/branch/${ci_commit.branch}`}>{ci_commit.branch} </Link>
              <WhenFinishedStyled ci_commit={ci_commit}/>
            </div>
          </CommitContent>

          <CommitResultsStyled ci_commit={ci_commit} />
        </CommitDetails>
      </CommitRowWrapper>);

  }
};






const CommitRows = ({ ci_commits, className }) => (
  <div className={className}>
    <DayRows>
      <WrapperCommitRows>
        {ci_commits.map(ci_commit => (
          <CommitRow ci_commit={ci_commit} key={ci_commit.id} />
        ))}
      </WrapperCommitRows>
    </DayRows>
  </div>
);

class CiCommitList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
      isLoaded: false,
      ci_commits: []
    };
  }

  componentWillReceiveProps(nextProps) {
    const { match } = this.props;
    if (match.url!==nextProps.match.url)
      this.getData(nextProps);
  }

  getData(props) {
    const {page, max_count, match} = props;
    // if (match.path === '/')
    var uri = `commits`;
    if (match.params[0]) {
      var branch = match.params[0]
      uri = `branch/${branch}`;      
    }
    // else
    //   var uri = `branch/${branch}`;
    var ci_api = "http://gpu09-dt:5000/";


    get(`${ci_api}${uri}`, {
      params: {
        json: true,
        page,
        max_count,
      },
      headers: {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json"
      }
    })
      .then(response => {
        // console.log(response.data);
        this.setState({
          isLoaded: true,
          ci_commits: response.data
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
  }

  render() {
    const { error, isLoaded, ci_commits } = this.state;

    let information = (
      <Fragment>
        <h3>Useful links</h3>
        <ul>
          <li><a href="http://gitlab-srv/dvs/psp_swip/pipelines">Gitlab CI pipelines</a></li>
          <li><a href="http://gitlab-srv/dvs/psp_swip/wikis/faq/ci-failures">FAQ: When did my CI fail?</a></li>
          <li><a href="/admin/recording/">List of all available recordings</a></li>
        </ul>
        <h3>Reports for branch <code>develop</code></h3>
        <p><a href="http://gitlab-srv/dvs/psp_swip/commits/develop"><img src="http://gitlab-srv/dvs/psp_swip/badges/develop/build.svg" alt="build status"/></a><a href="/s/branches/develop/coverage/index.html"> <img alt="coverage report" src="http://gitlab-srv/dvs/psp_swip/badges/develop/coverage.svg"/></a></p>
      </Fragment>
    );

    var list;
    if (error) {
      list = <NonIdealState description={error.message} visual="pt-icon-error"/>;
    } else if (!isLoaded) {
      list = <NonIdealState title="Loading" visual={<Spinner/>} />;
    } else if (ci_commits.length===0) {
      list = <NonIdealState title="No results" description="Your search didn't return any commit." visual="pt-icon-folder-open" />;      
    } else {
      let ci_commits_by_day = groupBy(ci_commits, "authored_date");
      list = (
        <Fragment>
          <h3>Recent commits</h3>
          {Object.keys(ci_commits_by_day).map(day => (
            <Fragment key={day}>
              <HeaderDay>
                <Moment calendar={calendarStrings} tz='Asia/Jerusalem' date={day}></Moment> &#8212; {ci_commits_by_day[day].length} commits
              </HeaderDay>
              <CommitRows ci_commits={ci_commits_by_day[day]} />
            </Fragment>
          ))}
        </Fragment>
      );
    }
    return (
      <Container>
        {information}
        {list}
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

export default CiCommitList;
