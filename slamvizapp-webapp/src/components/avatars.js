import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { Classes } from "@blueprintjs/core";

const AvatarCell = styled.div`
  width: 46px;
  color: rgba(0, 0, 0, 0.85);
`;

const AvatarImg = styled.img`
  width: 45px;
  height: 45px;
  margin-right: 10px;
  padding: 0;

  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  float: left;
  transition: border-color 100ms linear
  vertical-align: middle;
`;

const AvatarPlaceholder = styled.div`
  background-color: #E3F2FD;
  color: #555;
  text-decoration: none;

  font-size: 16px;
  line-height: 38px;
  text-align: center;
  vertical-align: top;

  border-radius: 50%;
  border: none;
  height: auto;
  width: 100%;
  margin: 0;
  align-self: center;

`;

class Avatar extends React.PureComponent {
  render() {
    const { src, href, alt } = this.props;
    if (src === null || src === undefined) {
      return <AvatarCell>
        <Link to={href||'#'}>
          <AvatarPlaceholder style={this.props.style}>{(!!alt && alt[0].toUpperCase()) || ''}</AvatarPlaceholder>
        </Link>
      </AvatarCell>      
    }
    return <AvatarCell>
      <Link to={href||'#'}>
        <AvatarImg style={this.props.style} alt={alt||''} src={src||''} />
      </Link>
    </AvatarCell>
  }
}


class CommitAvatar extends React.PureComponent {
  render() {
    const { commit } = this.props;
    return <Avatar
      href={!!commit && !!commit.committer_name && `/committer/${commit.committer_name}`}
      alt={!!commit && commit.committer_name}
      src={!!commit && commit.committer_avatar_url}
      className={(!commit || !commit.committer_name) ? Classes.SKELETON : null}    
      style={this.props.style}
    />

  }
}


export { Avatar, CommitAvatar };
