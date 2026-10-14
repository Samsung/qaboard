// The controls panel of the commit page: here, the dynamic options shared by the output cards
import { fireEvent, render, screen } from '@testing-library/react';

import FloatingControlsPanel from '../FloatingControlsPanel';
import { configureOption } from '../../utils/dynamicOptions';

const frame = configureOption({ name: 'frame', views: ['Out'], paths: [':frame/out.png'] }, ['1', '2', '10']);
const camera = configureOption({ name: 'camera', views: ['Out'], paths: [':camera/out.png'] }, ['left', 'right']);

const panel = (controls, props = {}) => render(<FloatingControlsPanel
  controls={{ show: {}, dynamic_options: {}, dynamic_options_sync: {}, ...controls }}
  visualizations={[{ name: 'Out', path: ':frame/out.png' }]}
  controls_extra={[]}
  selected_views={['output-list']}
  new_batch={{ used_metrics: [] }}
  available_metrics={{}}
  metricTableSelect={null}
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

test('options are shown before users select a value, with their default, linked across outputs', () => {
  const onUpdateDynamicOption = vi.fn();
  panel({}, { onUpdateDynamicOption });
  expect(screen.getByText('frame')).toBeInTheDocument();
  const [frame_select, camera_select] = screen.getAllByRole('combobox');
  expect(frame_select).toHaveValue('10');
  expect(camera_select).toHaveValue('left');
  expect(screen.getAllByText('linked')).toHaveLength(2);
  fireEvent.change(frame_select, { target: { value: '2' } });
  expect(onUpdateDynamicOption).toHaveBeenCalledWith('frame', '2');
});

test('says when the selected value is not in the outputs', () => {
  panel({ dynamic_options: { frame: ['8'] } });
  expect(screen.getAllByRole('combobox')[0]).toHaveValue('10');
  expect(screen.getByText("isn't in these outputs, they show", { exact: false })).toBeInTheDocument();
});

test('unlinked options are chosen in each output', () => {
  const onToggleDynamicOptionSync = vi.fn();
  panel({ dynamic_options_sync: { frame: false } }, { onToggleDynamicOptionSync });
  expect(screen.getByText('per-output')).toBeInTheDocument();
  expect(screen.getByText('Each output has its own control')).toBeInTheDocument();
  expect(screen.getAllByRole('combobox')[0]).toBeDisabled();
  fireEvent.click(screen.getAllByRole('button').find(b => b.querySelector('[data-icon="link"]')));
  expect(onToggleDynamicOptionSync).toHaveBeenCalledWith('frame');
});
