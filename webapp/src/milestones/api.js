// Milestones: results (a commit's batch, maybe filtered) saved to compare with later.
// They are saved in the user's account: personal ones are listed only for them, shared ones for everyone on the project.
// Anyone who can see the project can open a milestone from its link: /<project>/milestone/<id>-<label>
// The API is backend/backend/api/milestones.py
import { queryOptions } from "@tanstack/react-query";
import { DateTime } from "luxon";

import { http } from "../api/http";
import { path_segment, stringify_query } from "../selection";
import { pretty_label } from "../utils";


// What lookups need, computed once per answer: by id, by commit, and those with a short commit id (rare)
export const index_milestones = (list = []) => {
  const by_id = {};
  const by_commit = {};
  for (const m of list) {
    by_id[m.id] = m;
    (by_commit[m.commit] ??= []).push(m);
  }
  const short = list.filter(m => (m.commit?.length ?? 40) < 40);
  return { list, by_id, by_commit, short };
};
export const no_milestones = index_milestones([]);

export const milestonesQuery = project => queryOptions({
  queryKey: ['milestones', project],
  queryFn: async ({ signal }) => index_milestones((await http.get('/api/v1/milestones', { params: { project }, signal })).data.milestones),
  enabled: !!project,
  staleTime: 60 * 1000,
});

export const milestoneQuery = id => queryOptions({
  queryKey: ['milestone', id],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/milestones/${id}`, { signal })).data,
  enabled: id !== undefined && id !== null,
  retry: false,
});


// Where its results are
export const results_project = m => m.commit_project ?? m.project;

// e.g. "/acme/vision/milestone/12-best-denoiser". Only the id matters: renaming a milestone keeps its links.
export const milestone_path = m => `/${path_segment(m.project)}/milestone/${m.id}${m.slug ? `-${m.slug}` : ''}`;
export const milestone_url = m => `${window.location.origin}${milestone_path(m)}`;
// "12-best-denoiser" => 12
export const milestone_id_from_path = name => {
  const match = /^(\d+)(-|$)/.exec(name ?? '');
  return match ? Number(match[1]) : null;
};

// Older milestones may have no label
export const milestone_name = m => m.label || [m.branch ?? m.commit?.slice(0, 8), m.batch !== 'default' ? pretty_label({ label: m.batch }) : null].filter(Boolean).join(' · ');

export const owner_name = m => m.owner?.full_name || m.owner?.user_name || null;

export const relative_date = date => date ? DateTime.fromISO(date).toRelative() : null;

const same_commit = (a, b) => !!a && !!b && (a === b || (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b)));

// The milestones of a commit, maybe only those of a batch (and filter), in the project whose results they are.
// The user's own milestones first.
export const milestones_of = (index, { project, commit, batch, filter }) => {
  if (!commit) return [];
  // milestones may have a short commit id
  // milestones with a short id, or all of them if we're given a short id: commit lists call this for each row
  const maybe_same = commit.length < 40 ? index.list : (index.short ?? index.list);
  const candidates = [...(index.by_commit[commit] ?? []), ...maybe_same.filter(m => m.commit !== commit && same_commit(m.commit, commit))];
  return candidates
    .filter(m => !project || results_project(m) === project)
    .filter(m => batch === undefined || (m.batch ?? 'default') === batch)
    .filter(m => filter === undefined || (m.filter ?? '') === (filter ?? ''))
    .sort((a, b) => Number(b.is_mine) - Number(a.is_mine));
};

// The commit page that shows a milestone's results, as the new commit
export const milestone_location = m => ({
  pathname: `/${path_segment(m.project)}/commit/${path_segment(m.commit)}`,
  search: stringify_query({
    new_project: results_project(m) !== m.project ? results_project(m) : undefined,
    batch: m.batch && m.batch !== 'default' ? m.batch : undefined,
    filter: m.filter || undefined,
  }),
});

// What the web app selects to show a milestone
export const milestone_selection = m => ({
  project: results_project(m),
  commit: m.commit,
  batch: m.batch || 'default',
  filter: m.filter || '',
});

// e.g. "tuning/denoiser" => ["tuning", "denoiser"]
export const group_parts = group => (group ?? '').split('/').map(part => part.trim()).filter(Boolean);


// -- Changes. They answer the milestone as the server saved it.
export const createMilestone = async fields => (await http.post('/api/v1/milestones', fields)).data;
export const updateMilestone = async (id, fields) => (await http.post(`/api/v1/milestones/${id}`, fields)).data;
export const deleteMilestone = async id => (await http.delete(`/api/v1/milestones/${id}`)).data;
export const setFavorite = async (id, is_favorite) => (await (is_favorite ? http.put(`/api/v1/milestones/${id}/favorite`) : http.delete(`/api/v1/milestones/${id}/favorite`))).data;
// {project: {key: milestone}}, as older versions saved them in browsers
export const importMilestones = async milestones => (await http.post('/api/v1/milestones/import', { milestones })).data;
