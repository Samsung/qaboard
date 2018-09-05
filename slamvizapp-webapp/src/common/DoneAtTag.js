import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";

import Moment from "react-moment";
import "moment-timezone";

import { Icon, Tooltip, Classes } from "@blueprintjs/core";


const defaults = {
  committer_name: 'Place Holder',
  date: '1 days ago',
}

class DoneAtTagUnstyled extends React.Component {
  render() {
    const { commit, className } = this.props;
    let maybe_skeletton = !commit ? Classes.SKELETON : null; 
    return (
      <span className={className}>
        <Icon
          style={{ color: "#999", marginRight: "4px" }}
          icon="calendar"
        />
        <Tooltip content={!!commit && commit.authored_datetime}>
          <Moment className={maybe_skeletton} fromNow tz="Asia/Jerusalem" date={!!commit ? commit.authored_datetime : defaults.date} />
        </Tooltip>{" "}
        by{" "}
        <Link className={maybe_skeletton} to={`/committer/${!!commit && commit.committer_name}`}>
          {!!commit ? commit.committer_name : defaults.committer_name}
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
