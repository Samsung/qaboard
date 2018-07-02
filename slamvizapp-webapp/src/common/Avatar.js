import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";

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

//  <a href={href}>
//  </a>

const Avatar = ({ src, href, alt }) => (
  <AvatarCell>
    <Link to={href}>
      <AvatarImg alt={alt} src={src} />
    </Link>
  </AvatarCell>
);

export { Avatar };
