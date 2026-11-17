/**
 * The export dialog: the web app names the runs, the server previews what the export does, then exports.
 * Run with: cd webapp && npm test -- ExportPlugin
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  errors: [], nb_errors: 0, file_in_names: true, max_files_per_run: 1, nb_crops: 0,
  files: [
    { to: 'scenes_a__out__new.png', run: 1, item: 0, side: 'new', file: 'out.png', region: null, exists: false },
    { to: 'scenes_a__out__v1.0.png', run: 11, item: 2, side: 'reference', file: 'out.png', region: null, exists: false },
  ],
  ...overrides,
});

// where two images differ: 8 regions, the largest first
const differences = Array.from({ length: 8 }, (_, i) => ({ x: 10 * i, y: 0, w: 8, h: 8, value: 1 - i / 10, diff: 1 - i / 10 }));
const server = ({ preview = plan(), exported } = {}) => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
  if (url.startsWith('/api/v1/output/image/diff')) return json(differences);
  if (url.startsWith('/api/v1/exports/preview')) return json(typeof preview === 'function' ? preview(JSON.parse(init.body)) : preview);
  if (url.startsWith('/api/v1/exports')) return json(exported ?? { ...plan(), nb_files_exported: 4, export_id: 7, mapping: '0.export.csv', skipped: [], nb_skipped: 0 });
  return json({});
});
const previews = fetch => fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/exports/preview')).map(([, init]) => JSON.parse(init.body));

const open = (props, options) => {
  renderWithProviders(<HistoryRouter history={history}>
    <ExportPlugin project="p" new_commit_id="abc" ref_commit_id="def" selected_batch_new="default" selected_batch_ref="default"
      config={{ outputs: { visualizations: [{ path: 'debug/:frame/out.png' }] } }}
      new_batch={new_batch} ref_batch={ref_batch} labels={{ new: 'new', reference: 'v1.0' }} {...props}/>
  </HistoryRouter>, options);
  fireEvent.click(screen.getByRole('button', { name: 'Export files' }));
};
const moreOptions = () => fireEvent.click(screen.getByRole('button', { name: /More options/ }));

describe('ExportPlugin', () => {
  beforeEach(() => usePrefsStore.setState({ exportLast: {}, exportPresets: [] }));
  afterEach(() => vi.restoreAllMocks());

  it('shows the names before exporting, in color, then exports with them', async () => {
    const fetch = server();
    open();
    // the files of the first visualization
    expect(await screen.findByDisplayValue('debug/*/out.png')).toBeInTheDocument();
    // what the export would do, from the server: each part of the names in its color, and what it is on hover
    const files = await screen.findByRole('list', { name: 'Exported files' });
    await waitFor(() => expect(within(files).getAllByRole('listitem').map(i => i.querySelector('span').textContent)).toEqual(['scenes_a__out__new.png', 'scenes_a__out__v1.0.png']));
    const side = within(files).getAllByTitle('new or reference').at(-1);
    expect(side).toHaveTextContent('v1.0');
    expect(within(files).getAllByTitle('input')[0]).toHaveTextContent('scenes_a');
    // what each part says, with the values it takes
    const parts = screen.getByLabelText('What names say');
    expect(parts).toHaveTextContent('New or referencenew and v1.0, as on the page');
    const body = previews(fetch)[0];
    expect(body).toMatchObject({ project: 'p', files: 'debug/*/out.png', template: '{input}__{settings}__{file}__{region}__{side}', separator: '_', type: 'link', windows: true, file_in_names: 'auto' });
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
    await waitFor(() => expect(new Set(previews(fetch).map(b => b.folder.id)).size).toBe(2));
  });

  it("says once what went wrong when nothing was exported, with what to do and a reference for admins", async () => {
    const problem = (count, overrides = {}) => ({
      step: 'folder', actor: 'alice', code: 'EACCES', about: 'destination', count,
      message: "Your account (alice) can't write in the export's folder (creating folders).",
      hint: 'Check that you can write in /exports/alice/p/2026-11-05-abcd1234, or export into a new folder.',
      examples: [{ file: 'out.png', to: 'new/scenes_a__out.png', side: 'new', error: "Permission denied: '/exports/alice/p/2026-11-05-abcd1234/new'" }],
      ...overrides,
    });
    const failed = { ...plan(), type: 'copy', nb_files_exported: 0, export_id: 7, mapping: null, skipped: [], nb_skipped: 0,
      nb_failed: 50, nb_not_attempted: 30, reference: '0123456789ab', problems: [problem(50)],
      errors: ["Your account (alice) can't write in the export's folder (creating folders). (50 files) E.g. new/scenes_a__out.png: Permission denied"] };
    server({ exported: failed });
    open(undefined, { siteConfig: { support_url: 'mailto:qa-admins@example.com' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    const result = await screen.findByRole('region', { name: 'Last export' });
    expect(within(result).getByText('Nothing was exported')).toBeInTheDocument();
    expect(result).not.toHaveTextContent('files exported from');
    // one line for the 50 files, what to do, and why the others weren't tried
    expect(within(result).getAllByText(/can't write in the export's folder/)).toHaveLength(1);
    expect(result).toHaveTextContent('50 files');
    expect(result).toHaveTextContent('Check that you can write in');
    expect(result).toHaveTextContent("QA-Board stopped after the first 50 files failed: the other 30 files weren't tried.");
    expect(result).toHaveTextContent('Reference 0123456789ab');
    const report = within(result).getByRole('link', { name: 'Report it' });
    expect(decodeURIComponent(report.getAttribute('href'))).toContain('Reference: 0123456789ab');
    // the server's error, for those who look
    expect(within(result).getByText('Examples')).toBeInTheDocument();
    // no success message, no "copied" toast
    expect(screen.queryByText(/Copied the export folder/)).not.toBeInTheDocument();
  });

  it("checks what the user's account can do before copying, and offers links instead", async () => {
    const fetch = server({ preview: body => body.type === 'copy'
      ? plan({ type: 'copy', copy_check: { user: 'alice', groups_known: false, nb_checked: 4, error: null, folder_error: "Permission denied: '/exports/alice/p/2026-11-05-abcd1234'",
          unreadable: [{ side: 'reference', error: "Permission denied: '/runs/ref/out.png'" }] } })
      : plan() });
    open();
    moreOptions();
    fireEvent.click(await screen.findByRole('radio', { name: 'Copies' }));
    expect(await screen.findByText("You can't write in this folder")).toBeInTheDocument();
    expect(screen.getByText("Your account can't read some runs' files")).toBeInTheDocument();
    expect(screen.getByText(/1 of the 4 files checked can't be read by your account \(alice\), from the reference runs/)).toBeInTheDocument();
    expect(screen.getByText(/QA-Board only knows your account's primary group/)).toBeInTheDocument();
    // the copies would fail: no export
    expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Export links instead' })[0]);
    expect(screen.getByRole('radio', { name: 'Links' })).toBeChecked();
    expect(previews(fetch).some(body => body.type === 'copy')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeEnabled());
    expect(screen.queryByText("You can't write in this folder")).not.toBeInTheDocument();
  });

  it('says how many files failed when others were exported', async () => {
    server({ exported: { ...plan(), nb_files_exported: 3, export_id: 7, mapping: '0.export.csv', skipped: [], nb_skipped: 0, nb_failed: 1, nb_not_attempted: 0,
      reference: 'abcdefabcdef', errors: ['The storage is full. E.g. scenes_b__out__new.png: No space left on device'],
      problems: [{ step: 'link', actor: 'server', code: 'ENOSPC', about: 'destination', count: 1, message: 'The storage is full.', hint: 'Free some space.', examples: [] }] } });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    const result = await screen.findByRole('region', { name: 'Last export' });
    expect(result).toHaveTextContent('3 files exported from 4 runs, 1 file failed');
    expect(result).toHaveTextContent('The storage is full.');
    expect(result).toHaveTextContent('1 file');
    // the problem's line in `errors` isn't shown twice
    expect(result).not.toHaveTextContent('No space left on device');
    // with the default support address, QA-Board's public issue tracker, no report link: it has the folders' paths
    expect(within(result).queryByRole('link', { name: 'Report it' })).not.toBeInTheDocument();
  });

  it("says the file only when runs have several, and doesn't talk about new and reference without a reference", async () => {
    const fetch = server({ preview: plan({ file_in_names: false, files: [{ to: 'scenes_a.png', run: 1, item: 0, side: 'new', file: 'out.png', region: null, exists: false }] }) });
    const alone = { ...new_batch, outputs: { 1: { ...new_batch.outputs[1], reference_id: null }, 2: { ...new_batch.outputs[2], reference_id: null } } };
    open({ new_batch: alone, ref_batch: { outputs: {} }, config: { outputs: { visualizations: [{ path: 'out.png' }] } } });
    const parts = await screen.findByLabelText('What names say');
    expect(parts).toHaveTextContent('new or reference (no reference: one version)');
    expect(screen.queryByRole('radio', { name: 'A folder for new, one for reference' })).not.toBeInTheDocument();
    await waitFor(() => expect(parts).toHaveTextContent('file (one out.png per run)'));
    expect(previews(fetch)[0].runs.map(r => r.fields.side)).toEqual(['', '']);
    // users can always say it
    fireEvent.click(screen.getByRole('button', { name: 'Always say it' }));
    await waitFor(() => expect(previews(fetch).at(-1).file_in_names).toBe(true));
  });

  it('names a batch exported alone, e.g. after its tuning', async () => {
    const fetch = server();
    const alone = { ...new_batch, outputs: { 1: { ...new_batch.outputs[1], reference_id: null }, 2: { ...new_batch.outputs[2], reference_id: null } } };
    open({ new_batch: alone, ref_batch: { outputs: {} }, selected_batch_new: 'tuning-gain' });
    const parts = await screen.findByLabelText('What names say');
    fireEvent.click(within(parts).getByRole('button', { name: 'Name them' }));
    fireEvent.click(within(parts).getByRole('button', { name: /The batch: tuning-gain/ }));
    expect(screen.getByLabelText('Label in names')).toHaveValue('tuning-gain');
    await waitFor(() => expect(previews(fetch).at(-1).runs.map(r => r.fields.side)).toEqual(['tuning-gain', 'tuning-gain']));
    expect(previews(fetch).at(-1).sides.new.label).toBe('tuning-gain');
    expect(parts).not.toHaveTextContent('no reference: one version');
    fireEvent.click(within(parts).getByRole('button', { name: 'Remove' }));
    expect(parts).toHaveTextContent('no reference: one version');
  });

  it('exports the folders the pattern matches, with their files', async () => {
    const fetch = server({ preview: body => body.folders
      ? plan({ nb_folders: 1, nb_in_folders: 2, files: [
        { to: 'scenes_a__dma_out__new/frame_0.bin', run: 1, item: 0, side: 'new', file: 'dma_out/frame_0.bin', folder: { to: 'scenes_a__dma_out__new', file: 'dma_out' }, region: null, exists: false },
      ] })
      : plan({ folders_skipped: 2, nb_files: 0, files: [] }) });
    open({ config: { outputs: { visualizations: [{ path: 'dma_out' }] } } });
    expect(await screen.findByText(/1 folder with the 2 files in it/)).toBeInTheDocument();
    expect(previews(fetch)[0].folders).toBe(true);
    // the folder's name in colors, then its file
    const list = await screen.findByRole('list', { name: 'Exported files' });
    await waitFor(() => expect(within(list).getByTitle('file')).toHaveTextContent('dma_out'));
    expect(list).toHaveTextContent('scenes_a__dma_out__new/frame_0.bin');
    fireEvent.click(screen.getByRole('button', { name: 'Only files' }));
    expect(await screen.findByText(/2 folders match the pattern, not exported/)).toBeInTheDocument();
    expect(previews(fetch).at(-1).folders).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Export them with their files' }));
    // the preview of the folders, again (cached)
    expect(await screen.findByText(/1 folder with the 2 files in it/)).toBeInTheDocument();
  });

  it('says when links are symbolic: Windows may not open them', async () => {
    server({ exported: { ...plan(), nb_files_exported: 4, nb_symlinks: 4, export_id: 7, mapping: '0.export.csv', skipped: [], nb_skipped: 0 } });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    const result = await screen.findByRole('region', { name: 'Last export' });
    expect(result).toHaveTextContent('4 files are symbolic links');
  });

  it("doesn't export names used by several files, and says how to fix them", async () => {
    server({ preview: plan({ nb_collisions: 1, collisions: [{ to: 'out.png', count: 4, sources: [{ run: 1, side: 'new', file: 'out.png' }, { run: 2, side: 'new', file: 'out.png' }] }] }) });
    open();
    expect(await screen.findByText('1 name is used by several files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeDisabled();
    // one click adds the run's id
    fireEvent.click(screen.getByRole('button', { name: /the run's id: always unique/ }));
    expect(screen.getByLabelText('Template')).toHaveValue('{input}__{settings}__{file}__{region}__{side}__{run}');
  });

  it('checks that Windows can open the paths, unless users turn it off', async () => {
    server({ preview: body => body.windows
      ? plan({ nb_too_long: 4, too_long: [{ to: 'scenes_a__out__new.png', length: 270 }], max_path: 259 })
      : plan() });
    open();
    expect(await screen.findByText('4 paths are too long for Windows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export 4 files' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Turn off Windows-compatible names/ }));
    moreOptions();
    expect(screen.getByRole('checkbox', { name: 'Windows-compatible names' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /More options/ })).toHaveTextContent('1 changed');
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
    const parts = await screen.findByLabelText('What names say');
    // gain is enough to tell them apart
    expect(parts).toHaveTextContent('what tells runs on the same input apart: gain=1, gain=2');
    fireEvent.click(within(parts).getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('group', { name: 'Settings in names' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /gain/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /iso/ })).not.toBeChecked();
    const sent = () => previews(fetch).at(-1).runs.map(r => r.fields.settings);
    await waitFor(() => expect(sent()).toEqual(['gain=1', 'gain=2']));
    // a run only says the parameters it sets...
    fireEvent.click(screen.getByRole('checkbox', { name: /iso/ }));
    await waitFor(() => expect(sent()).toEqual(['gain=1,iso=100', 'gain=2']));
    // ...unless every name should say every setting, for scripts
    fireEvent.click(screen.getByRole('checkbox', { name: /Only in the names that need them/ }));
    await waitFor(() => expect(sent()).toEqual(['gain=1,iso=100', 'gain=2,iso=default']));
    fireEvent.click(screen.getByRole('checkbox', { name: /Only in the names that need them/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /iso/ }));
    fireEvent.change(screen.getByLabelText('Parameters and their values'), { target: { value: '-' } });
    await waitFor(() => expect(sent()).toEqual(['gain-1', 'gain-2']));
  });

  it('exports only the new results or only the reference, renames them, and puts @ before them', async () => {
    const fetch = server();
    open({ nb_references: 2 });
    const runs = () => previews(fetch).at(-1)?.runs.map(r => [r.id, r.side, r.fields.side]);
    await waitFor(() => expect(runs()).toHaveLength(4));
    // several references on the page: the one shown is exported
    expect(screen.getByText(/The page compares with 2 references/)).toHaveTextContent('the export takes the one shown, v1.0');
    // names only for this export, and what's before them
    fireEvent.click(within(screen.getByLabelText('What names say')).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'baseline' } });
    fireEvent.change(screen.getByLabelText('Before it'), { target: { value: '@' } });
    await waitFor(() => {
      expect(previews(fetch).at(-1).template).toBe('{input}__{settings}__{file}__{region}@{side}');
      expect(runs()).toEqual([[1, 'new', 'new'], [2, 'new', 'new'], [11, 'reference', 'baseline'], [12, 'reference', 'baseline']]);
    });
    // it's still the layout "One folder"
    expect(screen.getByRole('radio', { name: 'One folder' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Only new' }));
    await waitFor(() => expect(runs()).toEqual([[1, 'new', ''], [2, 'new', '']]));
    expect(screen.getByLabelText('What names say')).toHaveTextContent('new or reference (only the new results exported)');
    expect(screen.queryByRole('radio', { name: 'A folder for new, one for reference' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Only v1.0' }));
    await waitFor(() => expect(runs()).toEqual([[11, 'reference', ''], [12, 'reference', '']]));
  });

  it('asks for feedback after an export', async () => {
    server();
    open({}, { siteConfig: { support_url: 'mailto:qaboard@example.com' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }));
    const link = await screen.findByRole('link', { name: 'Tell us' });
    expect(link.getAttribute('href')).toMatch(/^mailto:qaboard@example\.com\?subject=Feedback%20on%20the%20new%20Export&body=/);
  });

  it('separates runs from different batches of qaboard.yaml on the same input', async () => {
    const fetch = server();
    const batches = {
      filtered: { outputs: [1, 2] },
      outputs: {
        1: { id: 1, test_input_path: 'a.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux', data: { batch: 'night' } },
        2: { id: 2, test_input_path: 'a.raw', configurations: ['base'], extra_parameters: {}, platform: 'linux', data: { batch: 'day' } },
      },
    };
    open({ new_batch: batches, ref_batch: { outputs: {} } });
    await waitFor(() => expect(previews(fetch).at(-1)?.runs.map(r => r.fields.settings)).toEqual(['night', 'day']));
  });

  it("starts with the last export's settings, saves presets, and disables those that don't fit", async () => {
    server();
    usePrefsStore.setState({ exportLast: { p: { template: '{side}/{input}__{file}', separator: '_', files: '*.tif', windows: false } } });
    open();
    expect(await screen.findByDisplayValue('*.tif')).toBeInTheDocument();
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{file}');
    fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save these settings as a preset…' }));
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'For my script' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only for this project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(usePrefsStore.getState().exportPresets).toMatchObject([{ name: 'For my script', project: 'p', settings: { files: '*.tif', windows: false } }]);
    // another layout, then the preset again
    fireEvent.click(screen.getByRole('radio', { name: 'One folder' }));
    expect(screen.getByLabelText('Template')).toHaveValue('{input}__{settings}__{file}__{region}__{side}');
    // a preset whose names don't tell new and reference apart doesn't fit, and says why
    usePrefsStore.getState().saveExportPreset({ name: 'No side', project: null, settings: { template: '{input}__{file}', separator: '_' } });
    fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
    const no_side = await screen.findByRole('menuitem', { name: /No side/ });
    expect(no_side).toHaveAttribute('aria-disabled', 'true');
    expect(no_side).toHaveTextContent("Doesn't fit these runs. Runs would get the same names: they don't say new or reference.");
    fireEvent.click(screen.getByRole('menuitem', { name: /For my script/ }));
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{file}');
    expect(screen.getByRole('button', { name: 'Preset: For my script' })).toBeInTheDocument();
  });

  it('exports crops of regions of interest: the presets, quarters...', async () => {
    const fetch = server();
    const with_rois = { ...new_batch, outputs: {
      ...new_batch.outputs,
      1: { ...new_batch.outputs[1], test_input_metadata: { roi: [{ x: 1, y: 2, w: 3, h: 4, label: 'face' }] } },
    } };
    open({ new_batch: with_rois, config: { outputs: { visualizations: [{ path: 'out.png' }] } } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /crops of the images' regions of interest/ }));
    // the presets, by default: the input's regions
    expect(screen.getByRole('checkbox', { name: /Presets/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Quarters/ }));
    await waitFor(() => {
      const body = previews(fetch).at(-1);
      expect(body.whole_files).toBe(true);
      expect(body.runs.find(r => r.id === 1).regions.map(r => r.name)).toEqual(['face', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
      // the reference is cropped at the same place
      expect(body.runs.find(r => r.id === 11).regions.map(r => r.name)).toEqual(['face', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
      expect(body.runs.find(r => r.id === 2).regions[0]).toEqual({ name: 'top-left', x: 0, y: 0, w: 0.5, h: 0.5, unit: 'fraction', source: 'quarters' });
    });
    // finding where images differ is for one file: here, it's one
    expect(screen.getByLabelText('What names say')).toHaveTextContent('crops only: face, top-left, top-right');
  });

  it('crops the 5 largest differences of each image, or as many as users want', async () => {
    const fetch = server();
    const with_dirs = batch => ({ ...batch, outputs: Object.fromEntries(Object.entries(batch.outputs).map(([id, o]) => [id, { ...o, output_dir_url: `/s/runs/${id}` }])) });
    open({ new_batch: with_dirs(new_batch), ref_batch: with_dirs(ref_batch), config: { outputs: { visualizations: [{ path: 'out.png' }] } } },
      { user: { is_logged: true, user_name: 'alice' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /crops of the images' regions of interest/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Where they differ: perceptual/ }));
    const diffs = run => previews(fetch).at(-1)?.runs.find(r => r.id === run)?.regions?.map(r => r.name);
    await waitFor(() => expect(diffs(1)).toEqual(['diff-01', 'diff-02', 'diff-03', 'diff-04', 'diff-05']), { timeout: 3000 });
    // the reference is cropped at the same places
    expect(diffs(11)).toEqual(diffs(1));
    expect(screen.getByRole('checkbox', { name: /Where they differ: perceptual/ }).closest('label')).toHaveTextContent('10 regions in 2 runs (of 16 found)');
    fireEvent.change(screen.getByLabelText('Differences per image'), { target: { value: '2' } });
    await waitFor(() => expect(diffs(2)).toEqual(['diff-01', 'diff-02']), { timeout: 3000 });
    // what they don't mean yet isn't applied
    fireEvent.change(screen.getByLabelText('Differences per image'), { target: { value: '' } });
    expect(screen.getByLabelText('Differences per image')).toHaveValue(null);
    fireEvent.blur(screen.getByLabelText('Differences per image'));
    expect(screen.getByLabelText('Differences per image')).toHaveValue(2);
  });

  it('says a script may be all users need', async () => {
    server();
    open();
    expect(await screen.findByText(/You may not need an export/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy a Python snippet' })).toBeInTheDocument();
  });

  it('remembers the settings of the last export', async () => {
    server();
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'A folder for new, one for reference' }));
    expect(screen.getByLabelText('Template')).toHaveValue('{side}/{input}__{settings}__{file}__{region}');
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: '{input}__{nope}' } });
    expect(await screen.findByText(/Unknown field \{nope\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'A folder for new, one for reference' }));
    // the button says how many files once the preview is back, after its debounce: like above, slow CI runners need time
    fireEvent.click(await screen.findByRole('button', { name: 'Export 4 files' }, { timeout: 3000 }));
    await waitFor(() => expect(usePrefsStore.getState().exportLast.p).toMatchObject({ layout: 'by-side', template: '{side}/{input}__{settings}__{file}__{region}', files: 'debug/*/out.png', settings_keys: null, file_in_names: 'auto' }));
  });
});
