import { Link } from "../router";
import styled from "styled-components";

import { DateTime } from 'luxon';
import { Classes } from "@blueprintjs/core";


const DoneAtTagUnstyled = ({ project, commit, className, style }) => {
  // While it loads: a skeleton whose words say so (screen readers and agents read them, people see a gray bar)
  if (!commit?.authored_datetime)
    return <span className={className} style={style} aria-busy="true">
      <span className={Classes.SKELETON}>Loading when and by whom</span>
    </span>;
  return (
    <span className={className} style={style}>
      <span title={commit.authored_datetime}>
        {DateTime.fromISO(commit.authored_datetime, { zone: 'utc' }).toRelative()}
      </span>
      {" "}
      <Link
       className="done-at-by"
       to={`/${project}/committer/${commit.committer_name}`}
      >
        by {commit.committer_name}
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
