import { Link } from "../router";
import styled from "styled-components";

import { DateTime } from 'luxon';
import { Classes } from "@blueprintjs/core";


const defaults = {
  committer_name: 'Place Holder',
  date: '2018-08-08T06:00:00Z',
}

const DoneAtTagUnstyled = ({ project, commit, className, style }) => {
  const has_data = !!commit?.authored_datetime
  const maybe_skeletton = has_data ? null : Classes.SKELETON;
  return (
    <span className={className} style={style}>
      <span className={maybe_skeletton} title={commit?.authored_datetime ?? defaults.date}>
        {DateTime.fromISO(commit?.authored_datetime ?? defaults.date, { zone: 'utc' }).toRelative()}
      </span>
      {" "}
      <Link
       className={`done-at-by ${maybe_skeletton ?? ''}`}
       to={`/${project}/committer/${commit?.committer_name}`}
      >
        by {commit?.committer_name ?? defaults.committer_name}
      </Link>
    </span>
  );
}

const DoneAtTag = styled(DoneAtTagUnstyled)`
  color: var(--qa-text-muted);
  white-space: nowrap;
  box-sizing: border-box;
  margin-left: 5px;
`;

export { DoneAtTag };
