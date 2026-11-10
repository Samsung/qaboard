/**
 * The flame graph viewer compares the new profile with the reference's.
 * Run with: cd webapp && npm test -- flameGraph
 */
import { fireEvent, screen, within } from '@testing-library/react';

import FlameGraphViewer from '../flame-graph';
import { is_flame_graph } from '../OutputViewer';
import { renderWithProviders } from '../../test-utils';

// d3-flame-graph draws SVGs that jsdom can't lay out: we check what users pick from, and what it's given
const charts = vi.hoisted(() => []);
vi.mock('d3-flame-graph', () => {
  const flamegraph = () => {
    const chart = () => {};
    chart.options = {};
    ['transitionDuration', 'width', 'title', 'onClick', 'computeDelta', 'inverted', 'sort', 'minFrameSize', 'tooltip',
      'setSearchHandler', 'setDetailsHandler', 'setSearchMatch', 'setColorMapper']
      .forEach(method => { chart[method] = value => { chart.options[method] = value; return chart; }; });
    chart.searches = [];
    chart.search = term => chart.searches.push(term);
    chart.clear = () => chart.searches.push(null);
    chart.destroy = () => {};
    charts.push(chart);
    return chart;
  };
  return { flamegraph };
});

const files = {
  '/s/new/cpu.folded': '# unit: microseconds\nworker;respond 20\nworker;respond;lock_contended 30\nworker;model 50\nworker 100\n',
  '/s/ref/cpu.folded': 'worker;respond 20\nworker;model 80\nworker 100\n',
  '/s/new/flame.json': JSON.stringify({ name: 'all', value: 10, children: [] }),
  '/s/ref/flame.json': JSON.stringify({ name: 'all', value: 10, children: [] }),
};

beforeEach(() => {
  charts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = new URL(url, 'http://localhost').pathname;
    return files[path] === undefined ? new Response('', { status: 404 }) : new Response(files[path], { headers: { 'Content-Type': 'text/plain' } });
  }));
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

  it('reads folded stacks, and compares shares of each profile by default', async () => {
    render({ path: 'cpu.folded' });
    expect(await screen.findByText(/Comparing shares of each profile: new 200 µs, reference 200 µs/)).toBeInTheDocument();
    const chart = charts.at(-1);
    expect(chart.options.computeDelta).toBe(true);
    expect(chart.options.inverted).toBe(true);
    // the top functions: self and total, in the unit and in %, and the change
    const table = screen.getByRole('table');
    const lock = within(table).getByText('lock_contended').closest('tr');
    expect(lock).toHaveTextContent('30 µs 15%');
    expect(lock).toHaveTextContent('new');
    expect(lock).toHaveTextContent('+15 pp');
    const model = within(table).getByText('model').closest('tr');
    expect(model).toHaveTextContent('−15 pp');

    fireEvent.click(screen.getByRole('radio', { name: 'Absolute' }));
    expect(await screen.findByText(/Comparing absolute values/)).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('model').closest('tr')).toHaveTextContent('−30 µs');
  });

  it('searches the profile, and says what share it matches', async () => {
    render({ path: 'cpu.folded' });
    const search = await screen.findByPlaceholderText('Highlight frames');
    fireEvent.change(search, { target: { value: 'lock|model' } });
    expect(await screen.findByRole('status')).toHaveTextContent('2 frames · 40% of new · 40% of reference');
    expect(charts.at(-1).searches.at(-1)).toBe('lock|model');
    // the table shows the functions that match
    expect(within(screen.getByRole('table')).queryByText('respond')).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 frames');
  });

  it('changes the layout and the order', async () => {
    render({ path: 'cpu.folded' });
    fireEvent.click(await screen.findByRole('radio', { name: /Flame/ }));
    expect(charts.at(-1).options.inverted).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Heaviest first' }));
    expect(typeof charts.at(-1).options.sort).toBe('function');
  });

  it('says how to convert what it does not read', async () => {
    files['/s/new/perf.stacks.txt'] = 'java 25607 4794564.109216: 1 cycles: \n\t7f00aa10 main (/usr/bin/java)\n\n';
    render({ path: 'perf.stacks.txt', output_ref: undefined });
    expect(await screen.findByText(/qaboard.flamegraphs.save_flame_graph/)).toBeInTheDocument();
  });
});

describe('is_flame_graph', () => {
  it('picks the viewer for profile files', () => {
    for (const path of ['cpu.folded', 'out/cpu.collapsed', 'cpu.folded.gz', 'perf.stacks.txt', 'cpu.flame.json', 'flame.json',
      'py-spy.speedscope.json', 'CPU.20261110.cpuprofile'])
      expect(is_flame_graph(path)).toBe(true);
    for (const path of ['plot.json', 'log.txt', 'cpu.pb.gz', 'folded.png', 'flame.json.bak'])
      expect(is_flame_graph(path)).toBe(false);
  });
});
