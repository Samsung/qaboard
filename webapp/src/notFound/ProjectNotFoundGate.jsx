// Every URL the app's pages don't take is a project's page (src/routes.js): when the server has no such project
// (404), users get a 404 page instead of an empty project. The Access page stays: grants can be on groups of projects.
import { Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";

import { projectQuery } from "../api/queries";
import { useSelected } from "../selection";
import EmptyLoading from "../components/EmptyLoading";

const NotFoundPage = lazy(() => import("./NotFoundPage"));

const is_not_found = error => error?.response?.status === 404;

export const ProjectNotFoundGate = ({ children }) => {
  const { project, route } = useSelected();
  const { error } = useQuery(projectQuery(project));
  if (!route.is_access && is_not_found(error))
    return <Suspense fallback={<EmptyLoading/>}><NotFoundPage project={project}/></Suspense>;
  return children;
};
