/**
 * Metrics that scripts added to runs after the fact are marked, with who added them, when and with which script.
 * Run with: cd webapp && npm test -- AddedMetricMark
 */
import { screen, fireEvent } from '@testing-library/react';
import { DateTime } from 'luxon';

import { AddedMetricMark, addedMetricText, addedMetricsHint } from '../AddedMetricMark';
import { MetricsTags } from '../metrics';
import { TableCompare, TableKpi } from '../tables';
import { normalize_output } from '../../api/normalize';
import { renderWithProviders } from '../../test-utils';

const two_days_ago = DateTime.utc().minus({ days: 2 }).toISO();
const sharpness = { value: 0.41, at: two_days_ago, user: 'alice', token: 'laptop', script: 'sharpness.py', qaboard_version: '1.1.1' };
const metric = (key, extra) => ({ key, label: key, short_label: key, scale: 1, suffix: '', smaller_is_better: false, ...extra });
const available_metrics = { sharpness: metric('sharpness'), psnr: metric('psnr', { suffix: 'dB' }) };


test('the text says who added the metric, when and with which script', () => {
  expect(addedMetricText(sharpness)).toBe('Added 2 days ago by alice with sharpness.py.');
  expect(addedMetricText({ ...sharpness, replaced: 30, note: 'new blur kernel' }, metric('psnr', { suffix: 'dB' })))
    .toBe("Added 2 days ago by alice with sharpness.py. It replaced the run's value, 30dB. Note: new blur kernel");
  expect(addedMetricText({ value: 1 })).toBe('Added by a script.');
});

test('normalize_output exposes the added metrics', () => {
  expect(normalize_output({ metrics: { sharpness: 0.41 }, data: { added_metrics: { sharpness } } }).added_metrics).toEqual({ sharpness });
  expect(normalize_output({ metrics: {} }).added_metrics).toEqual({});
});

test('the mark shows its tooltip on hover, only for added metrics', async () => {
  const { unmount } = renderWithProviders(<AddedMetricMark added={sharpness}/>);
  fireEvent.mouseEnter(screen.getByTestId('added-metric'));
  expect(await screen.findByText('Added 2 days ago by alice with sharpness.py.')).toBeInTheDocument();
  unmount();
  renderWithProviders(<AddedMetricMark added={undefined}/>);
  expect(screen.queryByTestId('added-metric')).not.toBeInTheDocument();
});

test("the run cards' metric tags mark the added metrics", () => {
  renderWithProviders(<MetricsTags
    metrics_new={{ sharpness: 0.41, psnr: 30 }}
    available_metrics={available_metrics}
    added_metrics={{ sharpness }}
  />);
  const marks = screen.getAllByTestId('added-metric');
  expect(marks).toHaveLength(1);
  expect(marks[0].closest('.bp6-compound-tag')).toHaveTextContent('sharpness');
});

const run = (id, metrics, added_metrics, extra) => normalize_output({
  id, test_input_database: '/', test_input_path: `${id}.jpg`, configurations: [], extra_parameters: {}, metrics, data: { added_metrics }, ...extra,
});
const batches = () => ({
  new_batch: {
    outputs: {
      a: run('a', { sharpness: 0.41, psnr: 30 }, { sharpness }, { reference_id: 'r' }),
      b: run('b', { sharpness: 0.5, psnr: 31 }, undefined, { reference_id: 'r' }),
    },
    filtered: { outputs: ['a', 'b'] },
    used_metrics: new Set(['sharpness', 'psnr']),
    metrics_with_refs: new Set(['sharpness', 'psnr']),
  },
  ref_batch: { outputs: { r: run('r', { sharpness: 0.3, psnr: 29 }, { psnr: { ...sharpness, value: 29, replaced: 28 } }) } },
});

test('the Metrics Table marks the cells with added values, and says how many runs have some', () => {
  const { new_batch, ref_batch } = batches();
  renderWithProviders(<TableKpi new_batch={new_batch} ref_batch={ref_batch} metrics={['sharpness', 'psnr']} available_metrics={available_metrics}/>);
  const [row_a, row_b] = screen.getAllByRole('row').slice(2);
  const [sharpness_a, , psnr_a, psnr_ref] = row_a.querySelectorAll('td');
  expect(sharpness_a.querySelector('[data-testid="added-metric"]')).toHaveAttribute('aria-label', 'Added 2 days ago by alice with sharpness.py.');
  expect(psnr_a.querySelector('[data-testid="added-metric"]')).toBeNull();
  // the reference's value replaced the run's own
  expect(psnr_ref.querySelector('[data-testid="added-metric"]').getAttribute('aria-label')).toContain("replaced the run's value, 28dB");
  // b's own sharpness, the reference's added psnr
  expect(row_b.querySelectorAll('[data-testid="added-metric"]')).toHaveLength(1);
  expect(addedMetricsHint(Object.values(new_batch.outputs), 'sharpness')).toBe('1 run has a value added by scripts after they ran.');
  expect(addedMetricsHint(Object.values(new_batch.outputs), 'psnr')).toBeUndefined();
});

test('the Metrics Diff marks the differences of added values, saying which run they come from', () => {
  const { new_batch, ref_batch } = batches();
  renderWithProviders(<TableCompare new_batch={new_batch} ref_batch={ref_batch} metrics={['sharpness', 'psnr']} available_metrics={available_metrics} labels={['New', 'Reference']}/>);
  const [sharpness_a, psnr_a] = screen.getAllByRole('row')[2].querySelectorAll('td');
  expect(sharpness_a.querySelector('[data-testid="added-metric"]').getAttribute('aria-label')).toMatch(/^New: Added 2 days ago by alice/);
  expect(psnr_a.querySelector('[data-testid="added-metric"]').getAttribute('aria-label')).toMatch(/^Reference: Added/);
});
