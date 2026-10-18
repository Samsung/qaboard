// Milestone links, /<project>/milestone/<id>-<label>, open the milestone's results.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, NonIdealState } from "@blueprintjs/core";

import { Link, history, useRouter } from "../router";
import { path_segment, useSelected } from "../selection";
import { milestoneQuery, milestone_id_from_path, milestone_location } from "./api";


const MilestonePage = () => {
  const { match } = useRouter();
  const { project } = useSelected();
  const id = milestone_id_from_path(match.params.name);
  const { data: milestone, error } = useQuery(milestoneQuery(id));

  useEffect(() => {
    if (milestone) history.replace(milestone_location(milestone));
  }, [milestone]);

  if (id === null || error) {
    const status = error?.response?.status;
    return <NonIdealState
      icon={status === 403 ? 'lock' : 'star-empty'}
      title={status === 403 ? "You can't see this milestone" : "This milestone doesn't exist anymore"}
      description={error?.response?.data?.error ?? (id === null ? 'The link is not a link to a milestone.' : error.message)}
      action={<Link to={`/${path_segment(project)}`}><Button icon="arrow-left" text="The project's commits"/></Link>}
    />;
  }
  return <NonIdealState icon="star" title={<span className={Classes.SKELETON}>Opening the milestone</span>}/>;
};

export default MilestonePage;
