// The controls panel of the commit page: here, the dynamic options shared by the output cards
import { fireEvent, render, screen } from '@testing-library/react';

import FloatingControlsPanel from '../FloatingControlsPanel';
import { configureOption } from '../../utils/dynamicOptions';

// The panel starts closed on narrow screens like jsdom's: these tests look at its content
beforeEach(() => localStorage.setItem('controls-panel-expanded', 'true'));
afterEach(() => localStorage.removeItem('controls-panel-expanded'));

const frame = configureOption({ name: 'frame', views: ['Out'], paths: [':frame/out.png'] }, ['1', '2', '10']);
const camera = configureOption({ name: 'camera', views: ['Out'], paths: [':camera/out.png'] }, ['left', 'right']);

const panel = (controls, props = {}) => render(<FloatingControlsPanel
  controls={{ show: {}, dynamic_options: {}, dynamic_options_sync: {}, ...controls }}
  visualizations={[{ name: 'Out', path: ':frame/out.png' }]}
  controls_extra={[]}
  selected_views={['output-list']}
  new_batch={{ used_metrics: [] }}
  available_metrics={{}}
  sort_by="id"
  sort_order={-1}
  onToggle={() => () => {}}
  onToggleShow={() => () => {}}
  onUpdate={() => () => {}}
  has_tuning={false}
  tuned_params={[]}
  dynamic_options={{ frame, camera }}
  {...props}
/>);

test("until users pick a value, options say that each run shows its own default", () => {
  const onUpdateDynamicOption = vi.fn();
  panel({}, { onUpdateDynamicOption });
  expect(screen.getByText('Files to show')).toBeInTheDocument();
  const frame_select = screen.getByRole('combobox', { name: 'Frame' });
  // numbers: each run's last, else each run's first
  expect(frame_select).toHaveDisplayValue("Each run's last (default)");
  expect(screen.getByRole('combobox', { name: 'Camera' })).toHaveDisplayValue("Each run's first (default)");
  // the same value for all runs, unless users choose it per run
  screen.getAllByRole('checkbox', { name: 'Per run' }).forEach(per_run => expect(per_run).not.toBeChecked());
  expect(screen.queryByRole('button', { name: 'Reset Frame' })).not.toBeInTheDocument();
  fireEvent.change(frame_select, { target: { value: '2' } });
  expect(onUpdateDynamicOption).toHaveBeenCalledWith('frame', '2');
});

test('a picked value can be reset to the default', () => {
  const onResetDynamicOption = vi.fn();
  panel({ dynamic_options: { frame: ['2'] } }, { onResetDynamicOption });
  const frame_select = screen.getByRole('combobox', { name: 'Frame' });
  expect(frame_select).toHaveValue('2');
  fireEvent.click(screen.getByRole('button', { name: 'Reset Frame' }));
  expect(onResetDynamicOption).toHaveBeenCalledWith('frame');
  // choosing the default in the select does the same
  fireEvent.change(frame_select, { target: { value: '' } });
  expect(onResetDynamicOption).toHaveBeenCalledTimes(2);
});

test('sliders sit at the end of the default until users pick a value', () => {
  const stage = configureOption({ name: 'stage', views: ['Out'], paths: [':stage/out.png'] }, ['1', '2', '3']);
  panel({}, { dynamic_options: { stage } });
  const handle = screen.getByRole('slider', { name: 'Stage' });
  expect(handle).toHaveAttribute('aria-valuenow', '3');
  expect(handle).toHaveAttribute('aria-valuetext', "Each run's last");
  expect(screen.getByText("Default: each run's last")).toBeInTheDocument();
});

test('says when the selected value is not in the runs', () => {
  panel({ dynamic_options: { frame: ['8'] } });
  expect(screen.getByRole('combobox', { name: 'Frame' })).toHaveValue('10');
  expect(screen.getByText('No run has', { exact: false })).toBeInTheDocument();
});

test('says when the batch has no runs, without visualization toggles', () => {
  panel({}, { new_batch: { used_metrics: new Set(), outputs: {} } });
  expect(screen.getByText('No runs yet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Visualizations' })).not.toBeInTheDocument();
});

test('sections tell whether they are expanded', () => {
  panel({});
  const sorting = screen.getByRole('button', { name: 'Sort runs' });
  expect(sorting).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(sorting);
  expect(sorting).toHaveAttribute('aria-expanded', 'false');
});

test('options chosen per run are set in each run card', () => {
  const onToggleDynamicOptionSync = vi.fn();
  panel({ dynamic_options_sync: { frame: false } }, { onToggleDynamicOptionSync });
  expect(screen.getByText("Chosen in each run's card")).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Frame' })).not.toBeInTheDocument();
  const [frame_per_run] = screen.getAllByRole('checkbox', { name: 'Per run' });
  expect(frame_per_run).toBeChecked();
  fireEvent.click(frame_per_run);
  expect(onToggleDynamicOptionSync).toHaveBeenCalledWith('frame');
});

test('the sorting shows the default, e.g. the main metric, before users choose', () => {
  panel({}, {
    sort_by: undefined,
    default_sort_by: 'psnr',
    new_batch: { used_metrics: new Set(['psnr']) },
    available_metrics: { psnr: { key: 'psnr', label: 'PSNR' } },
  });
  expect(screen.getByRole('combobox', { name: 'Sort runs by' })).toHaveValue('psnr');
  expect(screen.getByRole('option', { name: 'PSNR (default)' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Sort order' })).toHaveDisplayValue('Highest first');
});
