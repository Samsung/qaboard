/**
 * The Metrics Table's columns line up with their headers.
 * Run with: cd webapp && npm test -- tables
 */
import { render } from '@testing-library/react';
import { Classes } from '@blueprintjs/core';

import { TableKpi } from '../tables';
import { metrics_fill_defaults } from '../../utils';


const available_metrics = metrics_fill_defaults({
  psnr: { label: 'PSNR', target: 30, smaller_is_better: false },
  overshoot: { label: 'Edge overshoot', target: 0.05 },
  runtime: { label: 'Runtime', suffix: ' s' },
});

const output = (id, metrics, extra = {}) => ({
  id, metrics, test_input_path: 'photos/facade.png', configurations: ['low-light'], extra_parameters: {}, platform: 'linux', ...extra,
});

// The runs left by a filter: photos, which have no edge overshoot (only the slanted edge chart has one)
const batches = () => ({
  new_batch: {
    outputs: { 1: output(1, { psnr: 26.7, runtime: 1.44 }, { reference_id: 2 }) },
    filtered: { outputs: [1] },
    used_metrics: new Set(['psnr', 'overshoot', 'runtime']),
    metrics_with_refs: new Set(['psnr', 'runtime']),
  },
  ref_batch: { outputs: { 2: output(2, { psnr: 26.2, runtime: 1.23 }) } },
});


describe('TableKpi', () => {
  it('has a header cell over each column, also for metrics without references', () => {
    const { container } = render(<TableKpi {...batches()} metrics={['psnr', 'overshoot', 'runtime']} available_metrics={available_metrics} />);
    const [, labels] = container.querySelectorAll('thead tr');
    const row = container.querySelector('tbody tr');
    expect(labels.children).toHaveLength(row.children.length);
    // New and Ref over PSNR and Runtime, an empty cell over the overshoot
    expect([...labels.children].slice(1).map(th => th.textContent)).toEqual(['New', 'Ref', '', 'New', 'Ref']);
    expect(labels.children[0].textContent).toBe('1 run');
  });

  it('shows the unit of metrics without a target, without a stray space', () => {
    const { container } = render(<TableKpi {...batches()} metrics={['psnr', 'overshoot', 'runtime']} available_metrics={available_metrics} />);
    const [headers] = container.querySelectorAll('thead tr');
    const units = [...headers.children].slice(1).map(th => th.querySelector(`span.${Classes.TEXT_MUTED}`)?.textContent ?? null);
    expect(units).toEqual(['[30]', '[0.05]', '[s]']);
  });
});
