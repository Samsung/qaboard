import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { Classes } from "@blueprintjs/core";

const AvatarCell = styled.div`
  width: 46px;
  color: rgba(0, 0, 0, 0.85);
`;

const AvatarImg = styled.img`
  width: 36px;
  height: 36px;
  margin-right: 10px;
  padding: 0;

  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  float: left;
  transition: border-color 100ms linear
  vertical-align: middle;
`;

class Avatar extends React.PureComponent {
  render() {
    const { src, href, alt } = this.props;
    return <AvatarCell>
      <Link to={href||'#'}>
        <AvatarImg alt={alt} src={src} />
      </Link>
    </AvatarCell>
  }
}


class CommitAvatar extends React.PureComponent {
  render() {
    const { commit } = this.props;
    return <Avatar
      href={!!commit && commit.committer_name && commit.committer_name && `/committer/${commit.committer_name}`}
      alt={!!commit && commit.committer_name}
      src={!!commit && commit.committer_avatar_url}
      className={(!!commit &&!!commit.committer_name) ? Classes.SKELETON : null}    
    />

  }
}


export { Avatar, CommitAvatar };
