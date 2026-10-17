// The view options of the commit page: the dynamic options shared by the output cards, and the panel docked on the right
import { act, fireEvent, render, screen } from '@testing-library/react';

import ViewOptionsPanel from '../ViewOptionsPanel';
import { useSidePanelExpanded } from '../SidePanel';
import { configureOption } from '../../utils/dynamicOptions';

// The panel starts collapsed on narrow screens like jsdom's: most tests look at its content
const window_width = window.innerWidth;
const resize = width => act(() => {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
});
beforeEach(() => localStorage.setItem('controls-panel-expanded', 'true'));
afterEach(() => {
  localStorage.clear();
  window.innerWidth = window_width;
});

const frame = configureOption({ name: 'frame', views: ['Out'], paths: [':frame/out.png'] }, ['1', '2', '10']);
const camera = configureOption({ name: 'camera', views: ['Out'], paths: [':camera/out.png'] }, ['left', 'right']);

// like the commit page, which owns whether the panel is open
const Panel = props => {
  const [expanded, setExpanded] = useSidePanelExpanded();
  return <ViewOptionsPanel expanded={expanded} setExpanded={setExpanded} {...props} />;
};
const panel_props = (controls, props = {}) => ({
  controls: { show: {}, dynamic_options: {}, dynamic_options_sync: {}, ...controls },
  visualizations: [{ name: 'Out', path: ':frame/out.png' }],
  controls_extra: [],
  selected_views: ['output-list'],
  new_batch: { used_metrics: [] },
  available_metrics: {},
  sort_by: "id",
  sort_order: -1,
  onToggle: () => () => {},
  onToggleShow: () => () => {},
  onUpdate: () => () => {},
  has_tuning: false,
  tuned_params: [],
  dynamic_options: { frame, camera },
  ...props,
});
const panel = (controls, props = {}) => render(<Panel {...panel_props(controls, props)} />);

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


describe('the docked panel', () => {
  const space = () => document.documentElement.style.getPropertyValue('--qa-side-panel-space');

  test('starts open when the content area has room for it, else collapsed to a rail', () => {
    localStorage.clear();
    resize(1920);
    const { unmount } = panel({});
    expect(screen.getByRole('button', { name: 'Collapse the view options' })).toBeInTheDocument();
    // the content area makes room for it
    expect(space()).toBe('300px');
    unmount();
    expect(space()).toBe('');

    resize(1440);
    panel({});
    expect(screen.getByRole('button', { name: 'Show the view options' })).toBeInTheDocument();
    expect(space()).toBe('40px');
  });

  test('o shows or hides it, unless typing', () => {
    resize(1920);
    panel({});
    fireEvent.keyDown(document.body, { key: 'o' });
    expect(screen.getByRole('button', { name: 'Show the view options' })).toBeInTheDocument();
    expect(localStorage.getItem('controls-panel-expanded')).toBe('false');
    // with a modifier, or while typing, it's not for us
    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'o' });
    input.remove();
    expect(screen.getByRole('button', { name: 'Show the view options' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'o' });
    expect(screen.getByRole('button', { name: 'Collapse the view options' })).toBeInTheDocument();
    expect(localStorage.getItem('controls-panel-expanded')).toBe('true');
  });

  test('collapsed, its rail says what each section is set to, and opens one', () => {
    localStorage.setItem('controls-panel-expanded', 'false');
    panel({ dynamic_options: { frame: ['2'] } });
    const files = screen.getByRole('button', { name: "Files to show: Frame 2, Camera each run's first (changed)" });
    // a dot on the sections that differ from the defaults
    expect(screen.getByTestId('changed-dynamic_options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort runs: Run id, newest first (changed)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Visualizations: 1 of 1 shown' })).toBeInTheDocument();
    expect(screen.queryByTestId('changed-visualizations')).not.toBeInTheDocument();
    fireEvent.click(files);
    const section = screen.getByRole('button', { name: 'Files to show' });
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(section).toHaveFocus();
  });

  test('counts what differs from the defaults, and Reset leaves the sorting', () => {
    const onResetControls = vi.fn();
    panel({ dynamic_options: { frame: ['2'] } }, { has_changes: true, onResetControls });
    // Frame, and sorting by run id
    expect(screen.getByLabelText('2 changed from the defaults')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onResetControls).toHaveBeenCalled();
  });

  test('remembers its width, resized from its left edge', () => {
    localStorage.setItem('view-options-width', '400');
    resize(1920);
    panel({});
    const aside = screen.getByRole('complementary', { name: 'View options' });
    expect(aside).toHaveStyle({ width: '400px' });
    const handle = screen.getByRole('separator', { name: 'Resize the view options' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(aside).toHaveStyle({ width: '416px' });
    expect(localStorage.getItem('view-options-width')).toBe('416');
    expect(space()).toBe('416px');
    // within limits
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '480');
    fireEvent.doubleClick(handle);
    expect(localStorage.getItem('view-options-width')).toBe('300');
  });

  test('covers narrow content areas instead of narrowing them, and Esc closes it then', () => {
    resize(1100);
    panel({});
    expect(space()).toBe('40px');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Show the view options' })).toBeInTheDocument();
  });

  test('brings the files to show into view when asked, e.g. after a run card links its option again', () => {
    resize(1920);
    const { rerender } = panel({});
    fireEvent.click(screen.getByRole('button', { name: 'Files to show' }));
    expect(screen.getByRole('button', { name: 'Files to show' })).toHaveAttribute('aria-expanded', 'false');
    rerender(<Panel {...panel_props({}, { revealFiles: 1 })} />);
    const section = screen.getByRole('button', { name: 'Files to show' });
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(section).toHaveFocus();
  });

  test('wide enough, Esc leaves it open', () => {
    resize(1920);
    panel({});
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Collapse the view options' })).toBeInTheDocument();
  });
});
