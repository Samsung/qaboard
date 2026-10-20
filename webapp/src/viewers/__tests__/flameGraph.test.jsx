/**
 * The flame graph viewer compares the new profile with the reference's.
 * Run with: cd webapp && npm test -- flameGraph
 */
import { screen } from '@testing-library/react';

import FlameGraphViewer from '../flame-graph';
import { renderWithProviders } from '../../test-utils';

// d3-flame-graph draws SVGs that jsdom can't lay out: we check what users pick from
vi.mock('d3-flame-graph', () => {
  const chart = () => {};
  ['transitionDuration', 'width', 'title', 'onClick', 'computeDelta', 'inverted', 'setColorMapper', 'setDetailsElement']
    .forEach(method => { chart[method] = () => chart; });
  chart.destroy = () => {};
  return { flamegraph: () => chart, differentialColorMapper: () => {} };
});

const profile = { name: 'all', value: 10, children: [] };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

const render = props => renderWithProviders(<FlameGraphViewer path="flame.json" output_new={{ output_dir_url: '/s/new' }} output_ref={{ output_dir_url: '/s/ref' }} {...props}/>);


describe('FlameGraphViewer', () => {
  it('compares the new profile with the reference', async () => {
    render();
    expect(await screen.findByRole('option', { name: 'After (new)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Before (reference)' })).toBeInTheDocument();
  });

  it('uses the names of what the commit page compares', async () => {
    render({ labels: { new: 'ISP v2', reference: 'v1.4' } });
    expect(await screen.findByRole('option', { name: 'After (ISP v2)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Before (v1.4)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /runtimes from ISP v2, colored by the improvement vs v1.4/ })).toBeInTheDocument();
  });
});
