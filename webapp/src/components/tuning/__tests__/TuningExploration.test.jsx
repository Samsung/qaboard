/**
 * Tests for the analysis of tuning experiments.
 * Run with: cd webapp && npm test -- TuningExploration
 */
import { screen, fireEvent, act } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import TuningExploration from '../TuningExploration';
import { history } from '../../../router';
import { renderWithProviders } from '../../../test-utils';

const plots = [];
vi.mock('../../Plot', () => ({ default: ({ data, layout }) => { plots.push({ data, layout }); return <div data-testid="plot"/>; } }));

const output = (id, input, threshold, loss) => ({
  id, test_input_path: input, configurations: [], params: { threshold }, metrics: { loss },
});
const outputs = {
  1: output(1, 'a.jpg', 1, 10), 2: output(2, 'a.jpg', 2, 20),
  3: output(3, 'b.jpg', 1, 30), 4: output(4, 'b.jpg', 2, 50),
};
const batch = Object.freeze({
  outputs,
  filtered: { outputs: ['1', '2', '3', '4'] },
  extra_parameters: { threshold: new Set([1, 2]) },
  sorted_extra_parameters: ['threshold'],
  data: {},
});
const available_metrics = { loss: { key: 'loss', label: 'Loss', short_label: 'loss', scale: 1, suffix: '', smaller_is_better: true } };

describe('TuningExploration', () => {
  it('aggregates runs by tuning parameters', async () => {
    history.replace('/p/commit/x?aggregation=average');
    renderWithProviders(<HistoryRouter history={history}>
      <TuningExploration batch={batch} selected_metrics={['loss']} available_metrics={available_metrics}/>
    </HistoryRouter>);
    expect(screen.getByText('4 runs')).toBeInTheDocument();
    expect(screen.getByText('2 different inputs')).toBeInTheDocument();
    const parcoords = plots.findLast(p => p.data[0].type === 'parcoords');
    expect(parcoords.data[0].dimensions).toEqual([
      { label: 'loss', values: [20, 35] },
      { label: 'threshold', values: [1, 2], integer: true },
    ]);
    await act(async () => fireEvent.change(screen.getByDisplayValue('Average aggregation'), { target: { value: 'median' } }));
    // the default isn't in the URL
    expect(history.location.search).toBe('');
  });

  it('explains how to start tuning', () => {
    renderWithProviders(<HistoryRouter history={history}>
      <TuningExploration batch={{ ...batch, sorted_extra_parameters: [], extra_parameters: {} }} selected_metrics={[]} available_metrics={{}}/>
    </HistoryRouter>);
    expect(screen.getByText('How to start tuning?')).toBeInTheDocument();
  });
});
