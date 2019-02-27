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
  vertical-align: center;

  border-radius: 50%;
  border: none;
  height: auto;
  width: 45px;
  height: 45px;
  margin: 0;
  align-self: center;

`;

class Avatar extends React.PureComponent {
  render() {
    const { src, href, alt } = this.props;
    const no_image = src === null || src === undefined || src === false
    const avatar = no_image ? <AvatarPlaceholder style={this.props.style}>{(!!alt && alt[0].toUpperCase()) || ''}</AvatarPlaceholder>
                            : <AvatarImg style={this.props.style} alt={alt||''} src={src||''} />;
    return <AvatarCell>{!!!href ? <Link to={href||'#'}>{avatar}</Link> : avatar}</AvatarCell>;
  }
}


class CommitAvatar extends React.PureComponent {
  render() {
    const { commit } = this.props;
    let maybe_skeleton = (!commit || !commit.committer_name) ? Classes.SKELETON : null;
    return <Avatar
      href={!!commit && !!commit.committer_name && `/committer/${commit.committer_name}`}
      alt={!!commit ? commit.committer_name : 'x'}
      src={!!commit && commit.committer_avatar_url}
      className={maybe_skeleton}    
      style={this.props.style}
    />

  }
}


export { Avatar, CommitAvatar };
