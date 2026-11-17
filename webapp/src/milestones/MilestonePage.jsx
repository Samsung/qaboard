// Milestone links open the milestone's results:
//   /<project>/milestone/<id>-<label>                     the milestone, as the new results
//   /<project>/milestone/<id>-<label>?vs=<id>-<label>     compared with another milestone
//   ...?vs=<id>-<label>&vs=<id>-<label>                   with several, stacked as references
// When one of them doesn't exist anymore (or can't be seen), we say which, and what users can do.
import { useEffect, useRef } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Button, Classes, Intent, NonIdealState } from "@blueprintjs/core";

import { Link, history, useRouter } from "../router";
import { path_segment, useSelected } from "../selection";
import { toaster } from "../toaster";
import { milestoneQuery, milestone_id_from_path, milestone_name_from_path, milestone_location, milestone_name, milestone_path } from "./api";
import { openManageMilestones } from "./ManageMilestones";
import { usePageTitle, join_title, project_name } from "../pageTitle";


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
  // the references: ?vs= once or several times
  const vs_paths = [query.vs ?? []].flat().filter(v => typeof v === 'string');
  const id = milestone_id_from_path(path);
  const vs_ids = vs_paths.map(milestone_id_from_path);
  usePageTitle(join_title(milestone_name_from_path(path) || 'Milestone', project_name(project)));
  const main = useQuery(milestoneQuery(id));
  const references = useQueries({ queries: vs_ids.map(vs_id => milestoneQuery(vs_id)) });
  const vs_problems = vs_paths.map((_, i) => vs_ids[i] === null || !!references[i].error);
  const ready = main.data && references.every((r, i) => r.data || vs_problems[i]);
  // we leave this page once: after that, the URL no longer says what to open
  const redirected = useRef(false);

  useEffect(() => {
    if (!ready || redirected.current) return;
    redirected.current = true;
    const found = references.filter((_, i) => !vs_problems[i]).map(r => r.data);
    vs_paths.forEach((vs_path, i) => {
      if (!vs_problems[i]) return;
      const { title } = problem(vs_ids[i], vs_path, references[i].error);
      const instead = found.length > 0 ? 'the results are compared with the other milestones' : 'the results are compared with the default reference instead';
      toaster.show({ message: `${title}: ${instead}.`, intent: Intent.WARNING, icon: 'warning-sign', timeout: 10000 });
    });
    history.replace(milestone_location(main.data, found));
  });

  const reference = references.find(r => r.data) ?? {};
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
