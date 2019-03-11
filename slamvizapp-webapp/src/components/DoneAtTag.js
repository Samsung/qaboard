import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";

import Moment from "react-moment";
import "moment-timezone";

import { Tooltip, Classes } from "@blueprintjs/core";


const defaults = {
  committer_name: 'Place Holder',
  date: '2018-08-08T06:00:00Z',
}

class DoneAtTagUnstyled extends React.Component {
  render() {
    const { project, commit, className, style } = this.props;
    let maybe_skeletton = (!commit || !commit.authored_datetime) ? Classes.SKELETON : null; 
    return (
      <span className={className} style={style}>
        <Tooltip content={!!commit && commit.authored_datetime}>
          <Moment className={maybe_skeletton} fromNow tz="Asia/Jerusalem" date={(!!commit && !!commit.authored_datetime) ? commit.authored_datetime : defaults.date} />
        </Tooltip>{" "}
        {" "}
        <Link className={maybe_skeletton} to={`/${project}/committer/${!!commit && commit.committer_name}`}>
          by {(!!commit && !!commit.committer_name) ? commit.committer_name : defaults.committer_name}
        </Link>
      </span>
    );
  }
}

const DoneAtTag = styled(DoneAtTagUnstyled)`
  color: rgba(0, 0, 0, 0.55);
  white-space: nowrap;
  box-sizing: border-box;
  margin-left: 5px;
`;

export { DoneAtTag };
