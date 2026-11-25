// Accessibility: axe on a few key pages, against a mocked API, light and dark. Checks only the rules fixed in
// November 2026 (webapp/TODO.md, "Accessibility"), so that they don't regress; the ones left open there aren't checked.
// AXE_ALL=1 npm run e2e -- accessibility logs every rule's violations instead, to see what's left.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const RULES = [
  // landmarks
  'region', 'landmark-one-main', 'landmark-no-duplicate-main', 'landmark-no-duplicate-banner',
  'landmark-no-duplicate-contentinfo', 'landmark-unique', 'landmark-banner-is-top-level',
  'landmark-main-is-top-level', 'landmark-complementary-is-top-level', 'landmark-contentinfo-is-top-level',
  // names
  'label', 'button-name', 'link-name', 'image-alt', 'input-button-name', 'select-name', 'aria-input-field-name',
  // structure, colors
  'list', 'listitem', 'link-in-text-block', 'color-contrast',
];

const project = 'group/repo';
const qatools_metrics = {
  available_metrics: {
    psnr: { label: 'PSNR', short_label: 'PSNR', target: 40, smaller_is_better: false, scale: 1, suffix: 'dB' },
    latency: { label: 'Latency', short_label: 'Latency', target: 10, smaller_is_better: true, scale: 1, suffix: 'ms' },
  },
  default_metric: 'psnr', main_metrics: ['psnr', 'latency'], summary_metrics: ['psnr', 'latency'],
};
const qatools_config = { outputs: { visualizations: [{ name: 'Log', path: 'log.txt', type: 'text/plain' }] } };
const output = (id, metrics) => ({
  id, platform: 'linux', configurations: ['base'], extra_parameters: {}, metrics, data: {},
  is_failed: false, is_pending: false, is_running: false, deleted: false, created_date: '2026-09-01T10:00:00Z',
  output_dir_url: `/s/mnt/qaboard/${id}/output`, test_input_database: '/mnt/database', test_input_path: 'images/A.png', test_input_metadata: {},
});
const commit = (hexsha, message, batch_id, metrics) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config, qatools_metrics },
  batches: { default: {
    id: batch_id, label: 'default', data: {}, valid_outputs: 1, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
    outputs: { [batch_id]: output(batch_id, metrics) },
    aggregated_metrics: Object.fromEntries(Object.entries(metrics).flatMap(([key, value]) => [[`${key}_median`, value], [`${key}_average`, value]])),
  } },
});
// the new commit misses the PSNR target and gets slower: danger tags
const commits = {
  new: commit('new', 'Faster denoiser', 1, { psnr: 35.2, latency: 12 }),
  ref: commit('ref', 'Release 1.0', 2, { psnr: 41.0, latency: 8 }),
};

// Longest matching prefix wins
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local', is_admin: true, status: 'active' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config, qatools_metrics }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
  '/api/v1/project': { qatools_config, qatools_metrics },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commits': Object.values(commits),
  '/api/v1/commit-counts': { all: 2, mine: 2, without_ci: 0 },
  '/api/v1/batches': [],
  '/api/v1/commit/new': commits.new,
  '/api/v1/commit/ref': commits.ref,
  '/api/v1/commit': commits.new,
  '/api/v1/admin/storage-locations': {
    storage_roots: ['/mnt/qaboard'],
    default: { path: '/mnt/qaboard/default', reachable: true },
    // two: the default's row, muted, is striped
    locations: [
      { id: 1, url: 's3://team-a-bucket/qaboard/', path: '/mnt/qaboard/team-a', projects: [project], runs: 12, reachable: true, outside_storage_roots: false },
      { id: 2, url: 's3://team-b-bucket/qaboard/', path: '/mnt/qaboard/team-b', projects: [], runs: 0, reachable: true, outside_storage_roots: false },
    ],
  },
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  // the release notes' popup would cover the page
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  // the runs' files
  await page.route('**/s/mnt/**', route => route.fulfill({ body: 'Denoising images/A.png\nDone.\n', contentType: 'text/plain' }));
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen, 'errors in the browser console').toEqual([]);
});

const pages = [
  { name: 'home', path: '/', ready: page => page.getByRole('main') },
  { name: 'projects', path: '/projects', ready: page => page.getByPlaceholder('Filter projects...') },
  { name: 'commits list', path: `/${project}/commits`, ready: page => page.getByText('Faster denoiser').first() },
  { name: 'commit page', path: `/${project}/commit/new?reference=ref`, ready: page => page.getByText('Release 1.0').first() },
  // the runs' cards, with their metrics' tags
  { name: 'commit page, visualizations', path: `/${project}/commit/new?reference=ref&selected_views=output-list`, ready: page => page.getByText('images/A.png').first() },
  { name: 'admin, storage', path: '/admin/storage', ready: page => page.getByRole('table', { name: 'Storage locations' }) },
];

for (const theme of ['light', 'dark']) {
  for (const { name, path, ready } of pages) {
    test(`${name} (${theme})`, async ({ page }) => {
      // the theme follows the system's by default
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(path);
      await expect(ready(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      const builder = new AxeBuilder({ page });
      const { violations } = await (process.env.AXE_ALL ? builder : builder.withRules(RULES)).analyze();
      const found = violations.map(v => ({ rule: v.id, nodes: v.nodes.map(n => `${n.target.join(' ')}: ${n.failureSummary.split('\n').slice(1).join(' ').trim()}`) }));
      if (process.env.AXE_ALL) console.log(name, theme, JSON.stringify(found, null, 1));
      else expect(found).toEqual([]);
    });
  }
}
