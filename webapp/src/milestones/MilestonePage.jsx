// Milestone links open the milestone's results:
//   /<project>/milestone/<id>-<label>                     the milestone, as the new results
//   /<project>/milestone/<id>-<label>?vs=<id>-<label>     compared with another milestone
// When one of them doesn't exist anymore (or can't be seen), we say which, and what users can do.
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Classes, Intent, NonIdealState } from "@blueprintjs/core";

import { Link, history, useRouter } from "../router";
import { path_segment, useSelected } from "../selection";
import { toaster } from "../toaster";
import { milestoneQuery, milestone_id_from_path, milestone_name_from_path, milestone_location, milestone_name, milestone_path } from "./api";
import { openManageMilestones } from "./ManageMilestones";


// "the milestone “best denoiser” (#12)": what the link said about it
const describe = (id, path) => {
  const name = milestone_name_from_path(path);
  return name ? `the milestone “${name}” (#${id})` : `the milestone #${id}`;
};

// Why we can't open a milestone: deleted, not allowed, or the link is wrong
const problem = (id, path, error) => {
  if (id === null) return { icon: 'disable', title: "This link doesn't point to a milestone", description: `Milestone links look like /<project>/milestone/12-its-name, not “${path ?? ''}”.` };
  const status = error?.response?.status;
  const what = describe(id, path);
  if (status === 404) return { icon: 'star-empty', title: `${what[0].toUpperCase()}${what.slice(1)} doesn't exist anymore`, description: 'Its owner deleted it. Its results may still be there: look for its commit, or ask who shared the link.' };
  if (status === 403) return { icon: 'lock', title: `You can't see ${what}`, description: "It's in a project you don't have access to. Ask the project's admins for access." };
  return { icon: 'error', title: `Could not open ${what}`, description: error?.response?.data?.error ?? error?.message };
};


const MilestonePage = () => {
  const { match } = useRouter();
  const { project, query } = useSelected();
  const path = match.params.name;
  const vs_path = typeof query.vs === 'string' ? query.vs : null;
  const id = milestone_id_from_path(path);
  const vs_id = milestone_id_from_path(vs_path);
  const main = useQuery(milestoneQuery(id));
  const reference = useQuery(milestoneQuery(vs_id));
  const vs_problem = vs_path !== null && (vs_id === null || reference.error);
  const ready = main.data && (vs_path === null || reference.data || vs_problem);
  // we leave this page once: after that, the URL no longer says what to open
  const redirected = useRef(false);

  useEffect(() => {
    if (!ready || redirected.current) return;
    redirected.current = true;
    if (vs_problem) {
      const { title } = problem(vs_id, vs_path, reference.error);
      toaster.show({ message: `${title}: the results are compared with the default reference instead.`, intent: Intent.WARNING, icon: 'warning-sign', timeout: 10000 });
    }
    history.replace(milestone_location(main.data, vs_problem ? undefined : reference.data));
  }, [ready, vs_problem, vs_id, vs_path, main.data, reference.data, reference.error]);

  if (id === null || main.error) {
    const { icon, title, description } = problem(id, path, main.error);
    return <NonIdealState
      icon={icon}
      title={title}
      description={description}
      action={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {reference.data && <Link to={milestone_path(reference.data)}><Button intent={Intent.PRIMARY} icon="star" text={<>Open the other milestone, “{milestone_name(reference.data)}”</>}/></Link>}
        <Button icon="properties" text="The project's milestones" onClick={() => openManageMilestones({ project })}/>
        <Link to={`/${path_segment(project)}`}><Button icon="arrow-left" text="The project's commits"/></Link>
      </div>}
    />;
  }
  return <NonIdealState icon="star" title={<span className={Classes.SKELETON}>Opening the milestone</span>}/>;
};

export default MilestonePage;
