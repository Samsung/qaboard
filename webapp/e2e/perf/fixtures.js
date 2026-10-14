// Large, realistic-looking API responses for the performance benchmark
export const project = 'group/repo';

const metric_keys = ['psnr', 'ssim', 'runtime', 'memory', 'error_rate', 'recall'];
const available_metrics = Object.fromEntries(metric_keys.map((key, i) => [key, {
  label: key.toUpperCase(), short_label: key, scale: 1, suffix: i === 2 ? 's' : '',
  smaller_is_better: i >= 2, target: 1,
}]));
const qatools_metrics = { available_metrics, main_metrics: metric_keys.slice(0, 4), summary_metrics: metric_keys, default_metric: 'psnr' };
const qatools_config = {
  project: { name: project, reference_branch: 'master' },
  outputs: { visualizations: [{ name: 'Output', path: 'output.txt', type: 'text/plain' }] },
};

// Deterministic pseudo-random numbers, so runs are comparable
const random = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const make_output = (id, i, rand, batch) => ({
  id, test_input_database: '/db', test_input_path: `scenes/scene_${String(i % 400).padStart(4, '0')}/clip_${Math.floor(i / 400)}.raw`,
  test_input_metadata: {}, platform: 'linux', configurations: ['base', { iso: 100 * (1 + (i % 4)) }],
  extra_parameters: {}, output_type: '', is_pending: false, is_running: false, is_failed: i % 97 === 0, deleted: false,
  output_dir_url: `/s/outputs/${id}`, data: { batch, storage: 1000 },
  metrics: Object.fromEntries(metric_keys.map(m => [m, Math.round(rand() * 1000) / 10])),
});

export const make_commit = ({ id, nb_outputs, seed, with_outputs = true, authored_datetime = '2026-09-01T10:00:00Z' }) => {
  const rand = random(seed);
  const outputs = {};
  if (with_outputs)
    for (let i = 0; i < nb_outputs; i++) outputs[`${seed}${i}`] = make_output(`${seed}${i}`, i, rand, 'default');
  return {
    id, hexsha: id, project_id: project, branch: 'master', committer_name: 'Alice', message: `Commit ${id}`,
    authored_datetime, committed_datetime: authored_datetime, latest_output_datetime: authored_datetime,
    authored_date: authored_datetime.slice(0, 10), parents: [], artifacts_url: '/s/artifacts',
    data: { qatools_config, qatools_metrics },
    batches: {
      default: {
        id: seed, label: 'default', batch_dir_url: '/s/batch', data: {},
        aggregated_metrics: Object.fromEntries(metric_keys.flatMap(m => [[`${m}_median`, 50], [`${m}_average`, 51]])),
        valid_outputs: nb_outputs, running_outputs: 0, pending_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
        ...(with_outputs ? { outputs } : {}),
      },
    },
  };
};

export const make_api = ({ nb_outputs, nb_commits }) => {
  const commits = Array.from({ length: nb_commits }, (_, i) => make_commit({
    id: `c${String(i).padStart(4, '0')}`, nb_outputs, seed: i + 1, with_outputs: false,
    authored_datetime: new Date(Date.UTC(2026, 8, 1, 10) - i * 3600 * 1000).toISOString(),
  }));
  const commit_details = Object.fromEntries(commits.slice(0, 2).map((c, i) => [c.id, make_commit({ ...c, nb_outputs, seed: i + 1 })]));
  return {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { id: project, data: { qatools_config, qatools_metrics }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: nb_commits } },
    '/api/v1/project/branches': ['master', 'develop'],
    '/api/v1/project': { qatools_config, qatools_metrics },
    '/api/v1/commits': commits,
    ...Object.fromEntries(Object.entries(commit_details).map(([id, c]) => [`/api/v1/commit/${id}`, c])),
    '/api/v1/commit': commit_details[commits[0].id],
  };
};
