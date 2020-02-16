import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { Classes } from "@blueprintjs/core";

const AvatarCell = styled.div`
  width: ${props => props.size || '45px'};
  color: rgba(0, 0, 0, 0.85);

  align-self: center;
`;

const AvatarImg = styled.img`
  width: ${props => props.size || '45px'};
  height: ${props => props.size || '45px'};
  margin-right: 10px;
  padding: 0;

  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.1);
  float: left;
  transition: border-color 100ms linear;

  vertical-align: middle;
  align-self: center;

  filter: ${props => props.filter || null};
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
  width: ${props => props.size || '45px'};
  height: ${props => props.size || '45px'};
  margin: 0;

  vertical-align: middle;
  align-self: center;
`;

class Avatar extends React.PureComponent {
  render() {
    const { src, href, alt, size, style={}, img_style={} } = this.props;
    const no_image = src === null || src === undefined || src === false;
    const avatar = no_image ? <AvatarPlaceholder size={size} style={style}>{(!!alt && alt[0].toUpperCase()) || ''}</AvatarPlaceholder>
                            : <AvatarImg size={size} style={{...style, ...img_style}} alt={alt||''} src={src||''} />;
    if (href !== undefined && href !== null)
      return <AvatarCell size={size} style={style}><Link to={href || '#'}>{avatar}</Link></AvatarCell>;
    else 
      return <AvatarCell size={size} style={style}>{avatar}</AvatarCell>;

  }
}


class CommitAvatar extends React.PureComponent {
  render() {
    const { commit, size } = this.props;
    let maybe_skeleton = (!commit || !commit.committer_name) ? Classes.SKELETON : null;
    return <Avatar
      href={!!commit && !!commit.committer_name && `/committer/${commit.committer_name}`}
      alt={!!commit ? commit.committer_name : ''}
      src={!!commit && commit.committer_avatar_url}
      className={maybe_skeleton}    
      style={this.props.style}
      size={size}
    />

  }
}


export { Avatar, CommitAvatar };
