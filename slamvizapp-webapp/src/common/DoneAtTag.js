import React from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";

import Moment from "react-moment";
import "moment-timezone";

import { Icon, Tooltip } from "@blueprintjs/core";

class DoneAtTagUnstyled extends React.Component {
  render() {
    const { commit, className } = this.props;
    return (
      <span className={className}>
        <Icon
          style={{ color: "#999", marginRight: "4px" }}
          iconName="pt-icon-calendar"
        />
        <Tooltip content={commit.authored_datetime}>
          <Moment fromNow tz="Asia/Jerusalem" date={commit.authored_datetime} />
        </Tooltip>{" "}
        by{" "}
        <Link to={`/committer/${commit.committer_name}`}>
          {commit.committer_name}
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
