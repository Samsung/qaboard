/**
 * The export dialog: the web app names the runs, the server previews what the export does, then exports.
 * Run with: cd webapp && npm test -- ExportPlugin
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { ExportPlugin } from '../ExportPlugin';
import { history } from '../../router';
import { renderWithProviders } from '../../test-utils';
import { usePrefsStore } from '../../stores/prefs';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const new_batch = {
  filtered: { outputs: [1, 2] },
  outputs: {
    1: { id: 1, test_input_path: 'scenes/a.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux', reference_id: 11 },
    2: { id: 2, test_input_path: 'scenes/b.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux', reference_id: 12 },
  },
};
const ref_batch = {
  outputs: {
    11: { id: 11, test_input_path: 'scenes/a.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux' },
    12: { id: 12, test_input_path: 'scenes/b.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux' },
  },
};

const plan = (overrides = {}) => ({
  folder: '/exports/alice/p/2026-11-05-abcd1234', folder_exists: false, ours: true, existing_policy: 'replace', type: 'link',
  nb_files: 4, nb_runs: 4, runs_without_files: 0, folders_skipped: 0, nb_collisions: 0, collisions: [], nb_existing: 0, existing: [],
  errors: [], nb_errors: 0,
  files: [
    { to: 'scenes_a__out__new.png', run: 1, side: 'new', file: 'out.png', exists: false },
    { to: 'scenes_a__out__v1.0.png', run: 11, side: 'reference', file: 'out.png', exists: false },
  ],
  ...overrides,
});

const server = ({ preview = plan(), exported } = {}) => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
  if (url.startsWith('/api/v1/exports/preview')) return json(typeof preview === 'function' ? preview(JSON.parse(init.body)) : preview);
  if (url.startsWith('/api/v1/exports')) return json(exported ?? { ...plan(), nb_files_exported: 4, export_id: 7, mapping: '0.export.csv', skipped: [], nb_skipped: 0 });
  return json({});
});

const open = props => {
  renderWithProviders(<HistoryRouter history={history}>
    <ExportPlugin project="p" new_commit_id="abc" ref_commit_id="def" selected_batch_new="default" selected_batch_ref="default"
      config={{ outputs: { visualizations: [{ path: 'debug/:frame/out.png' }] } }}
      new_batch={new_batch} ref_batch={ref_batch} labels={{ new: 'new', reference: 'v1.0' }} {...props}/>
  </HistoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Export files' }));
};

describe('ExportPlugin', () => {
  beforeEach(() => usePrefsStore.setState({ exportLast: {}, exportPresets: [] }));
  afterEach(() => vi.restoreAllMocks());

  it('shows the names before exporting, then exports with them', async () => {
    const fetch = server();
    open();
    // the files of the first visualization
    expect(await screen.findByDisplayValue('debug/*/out.png')).toBeInTheDocument();
    // what the export would do, from the server
    expect(await screen.findByText('scenes_a__out__v1.0.png')).toBeInTheDocument();
    const preview = fetch.mock.calls.find(([url]) => url.startsWith('/api/v1/exports/preview'));
    const body = JSON.parse(preview[1].body);
    expect(body).toMatchObject({ project: 'p', files: 'debug/*/out.png', template: '{input}__{settings}__{file}__{side}', separator: '_', type: 'link', windows: true });
    expect(body.runs).toEqual([
      { id: 1, side: 'new', fields: { side: 'new', settings: '', input: 'scenes/a', input_name: 'a' } },
      { id: 2, side: 'new', fields: { side: 'new', settings: '', input: 'scenes/b', input_name: 'b' } },
      { id: 11, side: 'reference', fields: { side: 'v1.0', settings: '', input: 'scenes/a', input_name: 'a' } },
      { id: 12, side: 'reference', fields: { side: 'v1.0', settings: '', input: 'scenes/b', input_name: 'b' } },
    ]);
    expect(body.folder.id).toMatch(/^[0-9a-f]{8}$/);

    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    expect(await screen.findByText(/4 files exported from 4 runs/)).toBeInTheDocument();
    const exported = fetch.mock.calls.find(([url, init]) => url.startsWith('/api/v1/exports?') && init.method === 'POST');
    expect(JSON.parse(exported[1].body).folder.id).toBe(body.folder.id);
    expect(screen.getByText('0.export.csv')).toBeInTheDocument();
    expect(screen.getAllByText('/exports/alice/p/2026-11-05-abcd1234').length).toBeGreaterThan(0);
    // the next export goes to a new folder
    await waitFor(() => {
      const ids = fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/exports/preview')).map(([, init]) => JSON.parse(init.body).folder.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  it("doesn't export names used by several files, and says how to fix them", async () => {
    server({ preview: plan({ nb_collisions: 1, collisions: [{ to: 'out.png', count: 4, sources: [{ run: 1, side: 'new', file: 'out.png' }, { run: 2, side: 'new', file: 'out.png' }] }] }) });
    open();
    expect(await screen.findByText('1 name is used by several files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeDisabled();
    // one click adds the run's id
    fireEvent.click(screen.getByRole('button', { name: /the run's id: always unique/ }));
    expect(screen.getByLabelText('Template')).toHaveValue('{input}__{settings}__{file}__{side}__{run}');
  });

  it('checks that Windows can open the paths, unless users turn it off', async () => {
    server({ preview: body => body.windows
      ? plan({ nb_too_long: 4, too_long: [{ to: 'scenes_a__out__new.png', length: 270 }], max_path: 259 })
      : plan() });
    open();
    expect(await screen.findByText('4 paths are too long for Windows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Turn off Windows-compatible names/ }));
    expect(screen.getByRole('checkbox', { name: 'Windows-compatible names' })).not.toBeChecked();
    // the preview comes back without the problem
    await waitFor(() => expect(screen.queryByText('4 paths are too long for Windows')).not.toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeEnabled(), { timeout: 3000 });
  });

  it('lists the settings that differ, and lets users pick them', async () => {
    const fetch = server();
    const tuning = {
      filtered: { outputs: [1, 2] },
      outputs: {
        1: { id: 1, test_input_path: 'a.raw', configurations: ['base'], extra_parameters: { gain: 1, iso: 100 }, platform: 'linux' },
        2: { id: 2, test_input_path: 'a.raw', configurations: ['base'], extra_parameters: { gain: 2 }, platform: 'linux' },
      },
    };
    open({ new_batch: tuning, ref_batch: { outputs: {} } });
    const settings = await screen.findByRole('group', { name: 'Settings in names' });
    expect(screen.getByRole('checkbox', { name: /gain/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /iso/ })).toBeChecked();
    expect(settings).toBeInTheDocument();
    const sent = () => JSON.parse(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/exports/preview')).at(-1)[1].body).runs.map(r => r.fields.settings);
    await waitFor(() => expect(sent()).toEqual(['gain=1,iso=100', 'gain=2,iso=default']));
    fireEvent.click(screen.getByRole('checkbox', { name: /iso/ }));
    fireEvent.change(screen.getByLabelText('Parameters and their values'), { target: { value: '-' } });
    await waitFor(() => expect(sent()).toEqual(['gain-1', 'gain-2']));
  });

  it('starts with the last export\'s settings, and saves presets', async () => {
    server();
    usePrefsStore.setState({ exportLast: { p: { template: '{side}/{input}__{file}', separator: '_', files: '*.tif', windows: false } } });
    open();
    expect(await screen.findByDisplayValue('*.tif')).toBeInTheDocument();
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{file}');
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'For my script' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only for this project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(usePrefsStore.getState().exportPresets).toMatchObject([{ name: 'For my script', project: 'p', settings: { files: '*.tif', windows: false } }]);
    // another layout, then the preset again
    fireEvent.click(screen.getByRole('radio', { name: 'One folder' }));
    expect(screen.getByLabelText('Template')).toHaveValue('{input}__{settings}__{file}__{side}');
    const preset = usePrefsStore.getState().exportPresets[0];
    fireEvent.change(screen.getByLabelText('Saved settings'), { target: { value: preset.id } });
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{file}');
  });

  it('says a script may be all users need', async () => {
    server();
    open();
    expect(await screen.findByText(/You may not need an export/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the Python snippet' })).toBeInTheDocument();
  });

  it('remembers the settings of the last export', async () => {
    server();
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'A folder per side' }));
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{settings}__{file}');
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: '{input}__{nope}' } });
    expect(await screen.findByText(/Unknown field \{nope\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'A folder per side' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    await waitFor(() => expect(usePrefsStore.getState().exportLast.p).toMatchObject({ layout: 'by-side', template: '{side}/{input}__{settings}__{file}', files: 'debug/*/out.png', settings_keys: null }));
  });
});
