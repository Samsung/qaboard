// A project's settings, from its Admin pages (docs/rfcs/project-admin.md): the quality gate's project rules, its audit log.
// Everyone who sees the project reads them, its owners (and admins) change them.
import { queryOptions, infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";

import { http, buildUrl } from "../api/http";
import { path_segment } from "../selection";


const no_reference = {
  exists: false, branch: null, has_config: false, has_gate: false, error: null,
  reference: null, labels: [], batches: [], expect_batches: {}, rules: [], max_failed_runs: null, require_bit_accuracy: false,
};

// What both calls answer, with defaults for what the server doesn't say
const asSettings = (data, project) => ({
  ...data,
  project: data?.project ?? project,
  can_manage: !!data?.can_manage,
  gate: data?.gate ?? null,
  gate_updated: data?.gate_updated ?? null,
  reference: { ...no_reference, ...data?.reference, rules: data?.reference?.rules ?? [] },
});

const settingsKey = project => ['project-settings', project];

// {project, can_manage, gate, gate_updated: {at, by}, reference}
// - gate: the project rules, as qaboard.yaml writes them: {rules: [{metric, max_regression, per_test_max_regression,
//   min, max, aggregate, batch, label}], max_failed_runs, require_bit_accuracy, on_looser_rules: warn | fail,
//   expect_batches: [batches] or {label: [batches]}}, or null
// - reference: the gate: section of the reference branch's qaboard.yaml, as `qa gate` reads it:
//   {exists, branch, has_config, has_gate, error, rules: [{metric, kind, limit, aggregate, batch, label}],
//   max_failed_runs, require_bit_accuracy, labels, expect_batches: {label or '*' for all: [batches]}}
export const projectSettingsQuery = project => queryOptions({
  queryKey: settingsKey(project),
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/project/settings', { params: { project }, signal });
    return asSettings(data, project);
  },
  enabled: !!project,
  staleTime: 30 * 1000,
});

// `gate`: the project rules, or null to remove them. => the settings, as the server saved them.
// It refuses rules `qa gate` couldn't read (400, with a sentence: "gate.rules[0]: give a limit for psnr...")
export const saveGate = async (queryClient, project, gate) => {
  const { data } = await http.post('/api/v1/project/settings/gate', { project, gate });
  const settings = asSettings(data, project);
  queryClient.setQueryData(settingsKey(project), settings);
  return settings;
};


// The project's audit log (and its subprojects'), for its developers and owners: pages of events, newest first,
// without addresses. `params`: the filters, see audit/filters.js filterParams. Viewers get a 403.
export const project_audit_page_size = 50;
export const projectAuditQuery = (project, params = {}) => infiniteQueryOptions({
  queryKey: ['project-audit', project, params],
  queryFn: async ({ signal, pageParam }) => {
    const { data } = await http.get('/api/v1/project/audit', { params: { project, ...params, before_id: pageParam, limit: project_audit_page_size }, signal });
    return { events: data?.events ?? [], next_before_id: data?.next_before_id ?? null };
  },
  initialPageParam: undefined,
  getNextPageParam: last_page => last_page.next_before_id ?? undefined,
  placeholderData: keepPreviousData,
  enabled: !!project,
  staleTime: 30 * 1000,
});
// Every matching event, as a download: `format` is csv or jsonl
export const projectAuditExportUrl = (project, params, format) => buildUrl('/api/v1/project/audit', { project, ...params, format });

// The project's audit log page, about something, e.g. ('batch', 12)
export const project_audit_page = project => `/${path_segment(project)}/admin/audit`;
export const target_audit_location = (project, target_type, target_id) => `${project_audit_page(project)}?${new URLSearchParams({ target: `${target_type}:${target_id}` })}`;
