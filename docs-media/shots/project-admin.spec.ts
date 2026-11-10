// A project's Admin pages other than Access (docs-media/shots.yaml: project-admin/*): the Quality gate tab.
//
// The snapshot has no project rules: before the shot, the admin (Adaeze) saves rules for the inference gateway, one of
// them only for `qa batch capacity`, and makes a commit that loosens its own rules fail. They're removed afterwards.
import { test } from '@playwright/test';
import { shot } from './lib';
import { demo } from './lib/demo';
import { ADMIN, apiAs, setProjectGate } from './demoState';

const GATEWAY = 'kitefin/inference-gateway';
const RULES = {
  rules: [
    { metric: 'latency_p99', max_regression: '10%' },
    { metric: 'throughput', max_regression: '5%', batch: 'capacity' },
  ],
  max_failed_runs: 0, require_bit_accuracy: false, on_looser_rules: 'fail', expect_batches: ['ci'],
};

async function withAdmin(change: (api: Awaited<ReturnType<typeof apiAs>>) => Promise<void>) {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await change(admin);
  } finally {
    await admin.dispose();
  }
}

test.beforeEach(() => withAdmin(admin => setProjectGate(admin, GATEWAY, RULES)));
test.afterAll(() => withAdmin(admin => setProjectGate(admin, GATEWAY, null)));

shot('project-admin/gate', {
  project: 'serving-latency',
  login: ADMIN,
  url: d => `${d.baseUrl}/${GATEWAY}/admin/gate`,
  alt: 'The Quality gate tab of kitefin/inference-gateway, as an owner: the rules of the reference\'s qaboard.yaml '
    + '(p99 and throughput may get 10% and 5% worse), then the project rules no commit can change: p99 10% for every '
    + 'run, throughput 5% only for qa batch capacity, no failed run, waiting for the ci batch, and "Fail the gate" when '
    + 'a commit loosens its own rules.',
  caption: 'Owners add rules that every commit is held to, whatever its qaboard.yaml says, here one only for the capacity batch.',
  viewport: { width: 1440, height: 1200 },
  actions: async ui => {
    await ui.page.getByRole('heading', { name: 'Project rules' }).waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 1180 });
    await ui.settle();
  },
  target: page => [page.getByRole('heading', { name: 'Quality gate', exact: true }), page.getByText('Last changed by')],
  padding: 16,
});
