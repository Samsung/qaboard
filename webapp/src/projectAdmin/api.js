// A project's settings, from its Admin pages (docs/rfcs/project-admin.md): the quality gate's project rules.
// Everyone who sees the project reads them, its owners (and admins) change them.
import { queryOptions } from "@tanstack/react-query";

import { http } from "../api/http";


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
