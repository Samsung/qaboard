/**
 * The project's Quality gate page: everyone reads the rules of qaboard.yaml and the project rules, owners edit
 * the project rules.
 * Run with: cd webapp && npm test -- projectAdmin
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { routes } from '../../routes';
import { selection_from_url } from '../../selection';
import { renderWithProviders } from '../../test-utils';
import { toaster } from '../../toaster';
import { ProjectAccessGate } from '../../access/NoProjectAccess';
import { GatePage } from '../GatePage';
import { projectSettingsQuery } from '../api';
import { check_text, limit_text, rule_rows, form_from_gate, gate_from_form, scope_text, expect_batches_text, expect_batches_from_text } from '../rules';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Answers by "METHOD /path", see calls() for what was sent
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));
const body = call => JSON.parse(call[1].body);

const project = 'group/repo';
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice', is_admin: false };
const bob = { is_logged: true, user_id: 3, user_name: 'bob', full_name: 'Bob', is_admin: false };

const reference = props => ({
  exists: true, branch: 'main', has_config: true, has_gate: true, error: null, reference: 'main', batches: ['default'],
  rules: [
    { metric: 'psnr', kind: 'max_regression', limit: 0.01, aggregate: 'median' },
    { metric: 'psnr', kind: 'per_test_max_regression', limit: 0.25, aggregate: null },
    { metric: 'latency_p99', kind: 'max', limit: 120, aggregate: 'mean' },
  ],
  max_failed_runs: 0, require_bit_accuracy: false,
  ...props,
});
const project_gate = props => ({
  rules: [{ metric: 'psnr', max_regression: '1%' }],
  max_failed_runs: 0, require_bit_accuracy: false, on_looser_rules: 'warn',
  ...props,
});
const settings = props => ({ project, can_manage: false, gate: null, gate_updated: null, reference: reference(), ...props });

const settings_api = '/api/v1/project/settings';
const gate_api = '/api/v1/project/settings/gate';

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  const { route, match } = matchRoutes(routes, pathname);
  return { route, ...renderWithProviders(<HistoryRouter history={history}><RouteMatch match={match}>{ui}</RouteMatch></HistoryRouter>, options) };
};
const renderPage = (answers, options = { user: alice }) => {
  const fetch = mockApi(answers);
  return { fetch, ...renderAt(`/${project}/admin/gate`, <GatePage/>, options) };
};

// The cells of a table's rows, without the header
const rows_of = table => within(table).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
const rule = number => within(screen.getByRole('group', { name: `Rule ${number}` }));

beforeEach(() => toaster.show.mockClear());
afterEach(() => vi.restoreAllMocks());


describe('routes', () => {
  it('has its route, under the project', () => {
    const { route, match } = matchRoutes(routes, '/a/b/c/admin/gate');
    expect(route.name).toBe('project_admin');
    expect(match.params).toMatchObject({ project_id: 'a/b/c', section: 'gate' });
    const { route: info, project: selected_project } = selection_from_url(match, '');
    expect(selected_project).toBe('a/b/c');
    expect(info).toMatchObject({ is_project_admin: true, section: 'gate', is_access: false, is_list: false, is_commit: false });
  });

  it('keeps the Access page where it was', () => {
    const { route, match } = matchRoutes(routes, `/${project}/access`);
    expect(route.name).toBe('access');
    expect(match.params.project_id).toBe(project);
    expect(selection_from_url(match, '').route).toMatchObject({ is_access: true, is_project_admin: false, section: null });
  });

  it("doesn't take over projects named admin", () => {
    const { route, match } = matchRoutes(routes, '/group/admin');
    expect(route.name).toBe('project');
    expect(match.params.project_id).toBe('group/admin');
    // nor their pages
    expect(matchRoutes(routes, '/group/admin/commits/main').route.name).toBe('branch');
    expect(matchRoutes(routes, '/group/admin/admin/gate').match.params).toMatchObject({ project_id: 'group/admin', section: 'gate' });
  });

  it("keeps the URLs of projects with admin or access in their ids", () => {
    const page = pathname => {
      const { route, match } = matchRoutes(routes, pathname);
      return [route.name, match.params.project_id];
    };
    expect(page('/admin/tools')).toEqual(['project', 'admin/tools']);
    expect(page('/team/admin/tools/commits')).toEqual(['commits', 'team/admin/tools']);
    expect(page('/team/access/tools')).toEqual(['project', 'team/access/tools']);
    expect(page('/team/access/tools/commit/abc')).toEqual(['commit', 'team/access/tools']);
    expect(page('/team/admin/settings')).toEqual(['project', 'team/admin/settings']);
    // only `admin/gate` is a page: `admin/<anything else>` stays the project's
    expect(page('/team/admin/gates')).toEqual(['project', 'team/admin/gates']);
    expect(page('/admin/gate')).toEqual(['project', 'admin/gate']);
  });
});


describe('Quality gate page, for viewers', () => {
  it('shows the rules of qaboard.yaml and the project rules, read-only', async () => {
    const { fetch } = renderPage({
      [`GET ${settings_api}`]: settings({
        gate: project_gate({ rules: [{ metric: 'psnr', max_regression: '2%' }, { metric: 'unsafe', max: 0, aggregate: 'max' }], max_failed_runs: 1, on_looser_rules: 'fail' }),
        gate_updated: { at: '2026-11-10T10:00:00Z', by: 'alice' },
      }),
    }, { user: bob });
    const yaml = await screen.findByRole('table', { name: 'Rules in qaboard.yaml' });
    expect(calls(fetch, 'GET', settings_api)[0][0]).toBe(`${settings_api}?project=${encodeURIComponent(project)}`);
    expect(within(yaml).getAllByRole('columnheader').map(th => th.textContent)).toEqual(['Metric', 'Check', 'Limit']);
    expect(rows_of(yaml)).toEqual([
      ['psnr', 'median may get worse by at most', '1%'],
      ['psnr', 'each test may get worse by at most', '25%'],
      ['latency_p99', 'mean is at most', '120'],
    ]);
    const yaml_section = screen.getByRole('region', { name: 'Rules in qaboard.yaml' });
    expect(yaml_section).toHaveTextContent('Failed runs allowed: 0');
    expect(yaml_section).not.toHaveTextContent(/bit-accurate/);
    expect(yaml_section).toHaveTextContent('From the reference branch (main). Commits are checked against the rules in their own qaboard.yaml: change them there.');

    const project_section = screen.getByRole('region', { name: 'Project rules' });
    expect(project_section).toHaveTextContent("Checked on every commit, on top of the commit's own rules. No commit can change them.");
    expect(rows_of(screen.getByRole('table', { name: 'Project rules' }))).toEqual([
      ['psnr', 'median may get worse by at most', '2%'],
      ['unsafe', 'max is at most', '0'],
    ]);
    expect(project_section).toHaveTextContent('Failed runs allowed: 1');
    expect(project_section).toHaveTextContent('When a commit loosens its own rules: fail the gate');
    expect(project_section).toHaveTextContent(/Last changed by alice on .*2026/);
    expect(project_section).toHaveTextContent('Project rules need a recent qa in your CI: older versions ignore them.');
    // they can't change them
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('says which runs a rule checks, and which batches the gate waits for', async () => {
    renderPage({
      [`GET ${settings_api}`]: settings({
        reference: reference({
          rules: [
            { metric: 'psnr', kind: 'max_regression', limit: 0.01, aggregate: 'median', batch: null, label: null },
            { metric: 'latency_p99', kind: 'max_regression', limit: 0.1, aggregate: 'median', batch: ['perf'], label: null },
            { metric: 'coverage', kind: 'min', limit: 80, aggregate: 'median', batch: ['unit', 'integration-*'], label: ['nightly'] },
          ],
          expect_batches: { '*': ['ci', 'perf'] },
        }),
        gate: project_gate({ rules: [{ metric: 'accuracy', min: 0.9, label: 'nightly' }], expect_batches: { default: ['ci'], nightly: ['all'] } }),
      }),
    }, { user: bob });
    const yaml = await screen.findByRole('table', { name: 'Rules in qaboard.yaml' });
    expect(within(yaml).getAllByRole('columnheader').map(th => th.textContent)).toEqual(['Metric', 'Check', 'Limit', 'Runs']);
    expect(rows_of(yaml)).toEqual([
      ['psnr', 'median may get worse by at most', '1%', 'every run'],
      ['latency_p99', 'median may get worse by at most', '10%', 'only qa batch perf'],
      ['coverage', 'median is at least', '80', 'only qa batch unit or qa batch integration-*, only the label nightly'],
    ]);
    expect(within(yaml).getByText('qa batch perf').tagName).toBe('CODE');
    expect(screen.getByRole('region', { name: 'Rules in qaboard.yaml' })).toHaveTextContent('Waits for runs from: ci, perf');
    expect(rows_of(screen.getByRole('table', { name: 'Project rules' }))).toEqual([['accuracy', 'median is at least', '0.9', 'only the label nightly']]);
    expect(screen.getByRole('region', { name: 'Project rules' })).toHaveTextContent('Waits for runs from: default: ci; nightly: all');
  });

  it('says so when the project has no rules of its own', async () => {
    renderPage({ [`GET ${settings_api}`]: settings({ reference: reference({ max_failed_runs: null, require_bit_accuracy: true }) }) }, { user: bob });
    expect(await screen.findByText('No project rules.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Project rules' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Project rules' })).not.toHaveTextContent(/Last changed/);
    const yaml_section = screen.getByRole('region', { name: 'Rules in qaboard.yaml' });
    expect(yaml_section).toHaveTextContent('Failed runs allowed: not checked');
    expect(yaml_section).toHaveTextContent('Outputs must be bit-accurate');
  });

  it('is readable signed out, links to the docs, and has the tabs of the Admin pages', async () => {
    renderPage({ [`GET ${settings_api}`]: settings() }, { user: { is_logged: false }, siteConfig: { docs_root: '/qa/' } });
    expect(await screen.findByRole('table', { name: 'Rules in qaboard.yaml' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quality gate', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quality gate docs' })).toHaveAttribute('href', '/qa/docs/quality-gate');
    const tabs = within(screen.getByRole('navigation', { name: 'Project admin' }));
    expect(tabs.getByRole('link', { name: 'Quality gate' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Access' })).toHaveAttribute('href', `/${project}/access`);
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Quality gate · repo'));
  });

  it("isn't shown for projects they can't see: the page says whom to ask", async () => {
    const forbidden = { error: 'Forbidden', reason: 'missing_role', required: 'viewer', project, owners: [{ type: 'user', id: 2, name: 'alice' }], can_request: true };
    mockApi({ 'GET /api/v1/project': () => [forbidden, 403], [`GET ${settings_api}`]: () => [forbidden, 403] });
    renderAt(`/${project}/admin/gate`, <ProjectAccessGate><GatePage/></ProjectAccessGate>, { user: bob });
    expect(await screen.findByText(`You don't have access to ${project}`)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Quality gate' })).not.toBeInTheDocument();
  });

  it('says why it could not load', async () => {
    renderPage({ [`GET ${settings_api}`]: () => [{ error: 'The database is away' }, 500] });
    expect(await screen.findByText("Could not load the gate's rules")).toBeInTheDocument();
    expect(screen.getByText('The database is away')).toBeInTheDocument();
  });
});


describe('the rules of qaboard.yaml', () => {
  const yaml_section = async () => {
    await screen.findByRole('region', { name: 'Project rules' });
    return screen.getByRole('region', { name: 'Rules in qaboard.yaml' });
  };

  it('says when the project never sent results', async () => {
    renderPage({ [`GET ${settings_api}`]: settings({ reference: reference({ exists: false, has_config: false, has_gate: false, rules: [], max_failed_runs: null }) }) });
    const section = await yaml_section();
    expect(section).toHaveTextContent("QA-Board hasn't received results from this project yet.");
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent(/From the reference branch/);
  });

  it('says what qa gate does without a gate section', async () => {
    renderPage({ [`GET ${settings_api}`]: settings({ reference: reference({ has_gate: false, rules: [] }) }) });
    const section = await yaml_section();
    expect(section).toHaveTextContent("This project's qaboard.yaml has no gate section: qa gate only checks that no run failed.");
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(section).toHaveTextContent('From the reference branch (main).');
  });

  it('shows the error qa gate would stop with', async () => {
    const error = 'gate.rules: expected a list, e.g. [{metric: psnr, max_regression: 1%}]';
    renderPage({ [`GET ${settings_api}`]: settings({ reference: reference({ error, rules: [], max_failed_runs: null }) }) });
    const section = await yaml_section();
    expect(section).toHaveTextContent(`qa gate would stop with: ${error}`);
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent(/Failed runs allowed/);
  });

  it('shows the other checks of a gate section without rules on metrics', async () => {
    renderPage({ [`GET ${settings_api}`]: settings({ reference: reference({ rules: [], max_failed_runs: 2 }) }) });
    const section = await yaml_section();
    expect(section).toHaveTextContent('No rules on metrics.');
    expect(section).toHaveTextContent('Failed runs allowed: 2');
  });
});


describe('Quality gate page, for owners', () => {
  const manager = props => settings({ can_manage: true, gate: project_gate(), ...props });

  it('loads the project rules in the editor, and has nothing to save until they change', async () => {
    renderPage({ [`GET ${settings_api}`]: manager({ gate: project_gate({ max_failed_runs: 3, require_bit_accuracy: true, on_looser_rules: 'fail' }) }) });
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.getAllByRole('group', { name: /^Rule \d+$/ })).toHaveLength(1);
    expect(rule(1).getByLabelText('Metric')).toHaveValue('psnr');
    expect(rule(1).getByLabelText('Metric')).toHaveAttribute('placeholder', 'metric, e.g. psnr');
    expect(rule(1).getByLabelText('Check')).toHaveValue('max_regression');
    expect(within(rule(1).getByLabelText('Check')).getAllByRole('option').map(option => option.textContent)).toEqual([
      'median may get worse by at most', 'each test may get worse by at most', 'median is at least', 'median is at most',
    ]);
    expect(rule(1).getByLabelText('Limit')).toHaveValue('1%');
    expect(rule(1).getByLabelText('Aggregate')).toHaveValue('median');
    expect(within(rule(1).getByLabelText('Aggregate')).getAllByRole('option').map(option => option.value)).toEqual(['median', 'mean', 'min', 'max']);
    expect(screen.getByLabelText('Failed runs allowed')).toHaveValue(3);
    expect(screen.getByLabelText('Outputs must be bit-accurate')).toBeChecked();
    const looser = within(screen.getByRole('radiogroup', { name: 'When a commit loosens its own rules' }));
    expect(looser.getByLabelText('Fail the gate')).toBeChecked();
    expect(looser.getByLabelText("Say so in the gate's output and comment")).not.toBeChecked();
    expect(screen.getByText("Compared with the rules of the reference's qaboard.yaml.")).toBeInTheDocument();
    // the rules of qaboard.yaml stay read-only
    expect(screen.getByRole('table', { name: 'Rules in qaboard.yaml' })).toBeInTheDocument();

    // an empty row isn't a change, a limit is. Reset undoes both.
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    expect(save).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).not.toBeDisabled();
    fireEvent.change(rule(1).getByLabelText('Limit'), { target: { value: '2%' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getAllByRole('group', { name: /^Rule \d+$/ })).toHaveLength(1);
    expect(rule(1).getByLabelText('Limit')).toHaveValue('1%');
    expect(save).toBeDisabled();
  });

  it('warns before the page is closed with unsaved changes', async () => {
    renderPage({ [`GET ${settings_api}`]: manager() });
    await screen.findByRole('button', { name: 'Save' });
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    fireEvent.change(rule(1).getByLabelText('Limit'), { target: { value: '2%' } });
    expect(leave()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(leave()).toBe(false);
  });

  it('starts empty without project rules', async () => {
    renderPage({ [`GET ${settings_api}`]: manager({ gate: null }) });
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: /^Rule/ })).not.toBeInTheDocument();
    expect(screen.getByText('No project rules.')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed runs allowed')).toHaveValue(null);
    expect(screen.getByLabelText('Outputs must be bit-accurate')).not.toBeChecked();
    expect(screen.getByLabelText("Say so in the gate's output and comment")).toBeChecked();
  });

  it('shows one row per limit of the saved rules', async () => {
    renderPage({ [`GET ${settings_api}`]: manager({ gate: project_gate({
      rules: [{ metric: 'psnr', max_regression: 0.05, min: 30, aggregate: 'mean' }, { metric: 'ssim', per_test_max_regression: '10%' }],
    }) }) });
    await screen.findByRole('button', { name: 'Save' });
    expect(screen.getAllByRole('group', { name: /^Rule \d+$/ })).toHaveLength(3);
    expect(rule(1).getByLabelText('Metric')).toHaveValue('psnr');
    expect(rule(1).getByLabelText('Check')).toHaveValue('max_regression');
    // as it was written
    expect(rule(1).getByLabelText('Limit')).toHaveValue('0.05');
    expect(rule(1).getByLabelText('Limit')).toHaveAttribute('placeholder', '5%');
    expect(rule(1).getByLabelText('Aggregate')).toHaveValue('mean');
    expect(rule(2).getByLabelText('Metric')).toHaveValue('psnr');
    expect(rule(2).getByLabelText('Check')).toHaveValue('min');
    expect(rule(2).getByLabelText('Check')).toHaveDisplayValue('mean is at least');
    expect(rule(2).getByLabelText('Limit')).toHaveValue('30');
    expect(rule(2).getByLabelText('Limit')).toHaveAttribute('placeholder', '0.42');
    expect(rule(2).getByLabelText('Aggregate')).toHaveValue('mean');
    // each test is checked: no aggregate
    expect(rule(3).getByLabelText('Check')).toHaveValue('per_test_max_regression');
    expect(rule(3).queryByLabelText('Aggregate')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the edited rules in the format of qaboard.yaml, then shows what the server saved', async () => {
    const saved = manager({
      gate: project_gate({ rules: [{ metric: 'psnr', max_regression: '2%' }, { metric: 'unsafe', max: 0, aggregate: 'max' }], max_failed_runs: null, require_bit_accuracy: true, on_looser_rules: 'fail' }),
      gate_updated: { at: '2026-11-10T10:00:00Z', by: 'alice' },
    });
    const { fetch, queryClient } = renderPage({ [`GET ${settings_api}`]: manager(), [`POST ${gate_api}`]: saved });
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(screen.getByRole('region', { name: 'Project rules' })).not.toHaveTextContent(/Last changed/);

    fireEvent.change(rule(1).getByLabelText('Limit'), { target: { value: ' 2% ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(rule(2).getByLabelText('Metric'), { target: { value: 'unsafe' } });
    fireEvent.change(rule(2).getByLabelText('Check'), { target: { value: 'max' } });
    expect(rule(2).getByLabelText('Limit')).toHaveAttribute('placeholder', '0.42');
    fireEvent.change(rule(2).getByLabelText('Limit'), { target: { value: '0' } });
    fireEvent.change(rule(2).getByLabelText('Aggregate'), { target: { value: 'max' } });
    expect(rule(2).getByLabelText('Check')).toHaveDisplayValue('max is at most');
    // rows left empty aren't sent
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(screen.getByLabelText('Failed runs allowed'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Outputs must be bit-accurate'));
    fireEvent.click(screen.getByLabelText('Fail the gate'));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => expect(calls(fetch, 'POST', gate_api)).toHaveLength(1));
    expect(body(calls(fetch, 'POST', gate_api)[0])).toStrictEqual({
      project,
      gate: {
        rules: [{ metric: 'psnr', max_regression: '2%' }, { metric: 'unsafe', max: 0, aggregate: 'max' }],
        max_failed_runs: null,
        require_bit_accuracy: true,
        on_looser_rules: 'fail',
      },
    });
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith({ message: "Saved the project's gate rules", intent: 'success', icon: 'tick', timeout: 3000 }));
    // the form is the server's answer: the empty row is gone, nothing left to save
    await waitFor(() => expect(screen.getAllByRole('group', { name: /^Rule \d+$/ })).toHaveLength(2));
    expect(rule(1).getByLabelText('Limit')).toHaveValue('2%');
    expect(save).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Project rules' })).toHaveTextContent(/Last changed by alice on .*2026/);
    // other components read the saved settings, without asking the server again
    expect(queryClient.getQueryData(projectSettingsQuery(project).queryKey).gate.on_looser_rules).toBe('fail');
    expect(calls(fetch, 'GET', settings_api)).toHaveLength(1);
  });

  it('follows rules another owner saved, unless they are being edited', async () => {
    const { queryClient } = renderPage({ [`GET ${settings_api}`]: manager() });
    const save = await screen.findByRole('button', { name: 'Save' });
    // the page refreshed, e.g. when they come back to its tab
    const refreshed = async (limit, by) => {
      queryClient.setQueryData(projectSettingsQuery(project).queryKey, manager({
        gate: project_gate({ rules: [{ metric: 'psnr', max_regression: limit }] }),
        gate_updated: { at: '2026-11-10T10:00:00Z', by },
      }));
      await screen.findByText(new RegExp(`Last changed by ${by}`));
    };
    await refreshed('3%', 'carol');
    expect(rule(1).getByLabelText('Limit')).toHaveValue('3%');
    expect(save).toBeDisabled();
    // what they typed stays
    fireEvent.change(rule(1).getByLabelText('Metric'), { target: { value: 'ssim' } });
    await refreshed('4%', 'dave');
    expect(rule(1).getByLabelText('Metric')).toHaveValue('ssim');
    expect(rule(1).getByLabelText('Limit')).toHaveValue('3%');
    expect(save).not.toBeDisabled();
    // Reset shows the latest
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(rule(1).getByLabelText('Metric')).toHaveValue('psnr');
    expect(rule(1).getByLabelText('Limit')).toHaveValue('4%');
  });

  it('removes rules, and sends what is not a number as typed', async () => {
    const { fetch } = renderPage({
      [`GET ${settings_api}`]: manager({ gate: project_gate({ rules: [{ metric: 'psnr', max_regression: '1%' }, { metric: 'ssim', min: 0.9 }] }) }),
      [`POST ${gate_api}`]: manager(),
    });
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(rule(1).getByRole('button', { name: 'Remove the rule' }));
    expect(screen.getAllByRole('group', { name: /^Rule \d+$/ })).toHaveLength(1);
    expect(rule(1).getByLabelText('Metric')).toHaveValue('ssim');
    fireEvent.change(rule(1).getByLabelText('Limit'), { target: { value: 'high' } });
    // Enter in a field saves
    fireEvent.submit(screen.getByRole('form', { name: 'Project rules' }));
    await waitFor(() => expect(calls(fetch, 'POST', gate_api)).toHaveLength(1));
    expect(body(calls(fetch, 'POST', gate_api)[0]).gate).toStrictEqual({
      rules: [{ metric: 'ssim', min: 'high' }], max_failed_runs: 0, require_bit_accuracy: false, on_looser_rules: 'warn',
    });
  });

  it('shows what the server refuses next to the form, and keeps what was typed', async () => {
    const refusal = 'gate.rules[1]: give a limit for ssim: max_regression, per_test_max_regression, min, max';
    const { fetch } = renderPage({ [`GET ${settings_api}`]: manager(), [`POST ${gate_api}`]: () => [{ error: refusal }, 400] });
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(rule(2).getByLabelText('Metric'), { target: { value: 'ssim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(body(calls(fetch, 'POST', gate_api)[0]).gate.rules).toStrictEqual([{ metric: 'psnr', max_regression: '1%' }, { metric: 'ssim', max_regression: '' }]);
    expect(toaster.show).not.toHaveBeenCalled();
    expect(rule(2).getByLabelText('Metric')).toHaveValue('ssim');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    // Reset forgets the error too
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('limits rules to some batches or labels, and sets the batches the gate waits for', async () => {
    const { fetch } = renderPage({
      [`GET ${settings_api}`]: manager({ gate: project_gate({ rules: [{ metric: 'psnr', max_regression: '1%' }, { metric: 'latency', max: 12, batch: 'perf' }] }) }),
      [`POST ${gate_api}`]: manager(),
    });
    const save = await screen.findByRole('button', { name: 'Save' });
    // a rule on every run: closed, without clutter
    expect(rule(1).getByRole('button', { name: 'Only for…' })).toHaveAttribute('aria-expanded', 'false');
    expect(rule(1).queryByLabelText('Only the batches')).not.toBeInTheDocument();
    // a scoped rule: open, with its batches
    expect(rule(2).getByRole('button', { name: 'Only for…' })).toHaveAttribute('aria-expanded', 'true');
    expect(rule(2).getByLabelText('Only the batches')).toHaveValue('perf');
    expect(rule(2).getByLabelText('Only the labels')).toHaveValue('');
    expect(screen.getByLabelText('Wait for runs from')).toHaveValue('');
    // opening isn't a change, a batch is
    fireEvent.click(rule(1).getByRole('button', { name: 'Only for…' }));
    expect(save).toBeDisabled();
    fireEvent.change(rule(1).getByLabelText('Only the batches'), { target: { value: ' unit, integration-* ' } });
    fireEvent.change(rule(1).getByLabelText('Only the labels'), { target: { value: 'nightly' } });
    // closing it checks every run again
    fireEvent.click(rule(2).getByRole('button', { name: 'Only for…' }));
    expect(rule(2).queryByLabelText('Only the batches')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Wait for runs from'), { target: { value: 'ci, perf' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls(fetch, 'POST', gate_api)).toHaveLength(1));
    expect(body(calls(fetch, 'POST', gate_api)[0]).gate).toStrictEqual({
      rules: [{ metric: 'psnr', max_regression: '1%', batch: ['unit', 'integration-*'], label: 'nightly' }, { metric: 'latency', max: 12 }],
      max_failed_runs: 0, require_bit_accuracy: false, on_looser_rules: 'warn', expect_batches: ['ci', 'perf'],
    });
  });

  it("says which role is missing when the server doesn't let them", async () => {
    renderPage({ [`GET ${settings_api}`]: manager(), [`POST ${gate_api}`]: () => [{ error: 'Forbidden', reason: 'missing_role', required: 'owner', project }, 403] });
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(screen.getByLabelText('Outputs must be bit-accurate'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`You need the owner role on ${project}. Ask an owner, or request access.`);
  });
});


describe('gate rules', () => {
  it('says what each limit checks', () => {
    expect(check_text('max_regression', 'mean')).toBe('mean may get worse by at most');
    expect(check_text('per_test_max_regression', null)).toBe('each test may get worse by at most');
    expect(check_text('min')).toBe('median is at least');
    expect(check_text('max', 'max')).toBe('max is at most');
  });

  it('shows regressions as percentages, other limits as they are', () => {
    expect(limit_text('max_regression', 0.01)).toBe('1%');
    expect(limit_text('per_test_max_regression', 0.07)).toBe('7%');
    expect(limit_text('max_regression', 0.125)).toBe('12.5%');
    expect(limit_text('max_regression', ' 5% ')).toBe('5%');
    expect(limit_text('max_regression', '0.05')).toBe('5%');
    expect(limit_text('min', 0.9)).toBe('0.9');
    expect(limit_text('max', 0)).toBe('0');
    expect(limit_text('max', null)).toBe('');
  });

  it('gives saved rules one row per limit', () => {
    expect(rule_rows([{ metric: 'psnr', max_regression: '5%', per_test_max_regression: 0.2 }, { metric: 'loss', max: 1, aggregate: 'max' }, null])).toEqual([
      { metric: 'psnr', kind: 'max_regression', limit: '5%', aggregate: 'median' },
      { metric: 'psnr', kind: 'per_test_max_regression', limit: 0.2, aggregate: null },
      { metric: 'loss', kind: 'max', limit: 1, aggregate: 'max' },
    ]);
    expect(rule_rows(undefined)).toEqual([]);
  });

  it('writes the form back as it read it', () => {
    const gate = {
      rules: [{ metric: 'psnr', max_regression: '5%' }, { metric: 'psnr', per_test_max_regression: '20%' }, { metric: 'loss', max: 1.5, aggregate: 'max' }],
      max_failed_runs: 2, require_bit_accuracy: true, on_looser_rules: 'fail',
    };
    expect(gate_from_form(form_from_gate(gate))).toStrictEqual(gate);
    expect(gate_from_form(form_from_gate(null))).toStrictEqual({ rules: [], max_failed_runs: null, require_bit_accuracy: false, on_looser_rules: 'warn' });
    // the median is the default, and per-test limits have no aggregate
    const form = { ...form_from_gate(null), rules: [
      { metric: ' psnr ', kind: 'min', limit: ' 30 ', aggregate: 'median' },
      { metric: 'ssim', kind: 'per_test_max_regression', limit: '0.1', aggregate: 'mean' },
      { metric: '', kind: 'max', limit: ' ', aggregate: 'median' },
    ] };
    expect(gate_from_form(form).rules).toStrictEqual([{ metric: 'psnr', min: 30 }, { metric: 'ssim', per_test_max_regression: '0.1' }]);
  });

  it('writes scopes and the batches to wait for back as it read them', () => {
    const gate = {
      rules: [{ metric: 'latency', max_regression: '10%', batch: 'perf' }, { metric: 'coverage', min: 80, batch: ['unit', 'integration-*'], label: ['nightly', 'weekly'] }],
      max_failed_runs: null, require_bit_accuracy: false, on_looser_rules: 'warn', expect_batches: { default: ['ci', 'perf'], nightly: ['all'] },
    };
    const form = form_from_gate(gate);
    expect(form.rules.map(({ batch, label }) => [batch, label])).toEqual([['perf', ''], ['unit, integration-*', 'nightly, weekly']]);
    expect(form.expect_batches).toBe('default: ci, perf; nightly: all');
    expect(gate_from_form(form)).toStrictEqual(gate);
    expect(gate_from_form(form_from_gate({ ...gate, expect_batches: ['ci', 'perf'] })).expect_batches).toStrictEqual(['ci', 'perf']);
    // as qa gate reads a list: for every label
    expect(expect_batches_text({ '*': ['ci', 'perf'] })).toBe('ci, perf');
    expect(expect_batches_text('perf')).toBe('perf');
    expect(expect_batches_text(null)).toBe('');
    expect(expect_batches_from_text(' ')).toBe(null);
    expect(expect_batches_from_text('nightly: all')).toStrictEqual({ nightly: ['all'] });
    expect(scope_text({ batch: ['perf'] })).toBe('only qa batch perf');
    expect(scope_text({ label: 'nightly' })).toBe('only the label nightly');
    expect(scope_text({ batch: null, label: [] })).toBe(null);
    expect(rule_rows([{ metric: 'a', min: 1, batch: 'perf' }])).toEqual([{ metric: 'a', kind: 'min', limit: 1, aggregate: 'median', batch: ['perf'] }]);
  });
});
