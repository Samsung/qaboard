/**
 * The benchmark viewer: the run's benchmarks against the reference's, the summary, filters, sorting, the machines.
 * Run with: cd webapp && npm test -- benchmarksViewer
 */
import { fireEvent, screen, within } from '@testing-library/react';

import BenchmarksViewer from '../benchmarks-viewer';
import { BenchmarksReport } from '../benchmarks/BenchmarksReport';
import { is_benchmarks } from '../OutputViewer';
import { renderWithProviders } from '../../test-utils';

// jsdom has no layout: the list's virtualizer would render no row
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 900, height: 440, top: 0, left: 0, right: 900, bottom: 440, x: 0, y: 0 });
});
afterEach(() => vi.restoreAllMocks());

const pytest = (benchmarks, cpu = { brand_raw: 'AMD EPYC 7763 64-Core Processor', count: 8 }) => JSON.stringify({
  machine_info: { node: 'ci-runner-07', cpu },
  benchmarks: benchmarks.map(([name, mean, stddev, group = 'codec']) => ({
    group, name, fullname: `tests/test_${group}.py::${name}`, params: null,
    stats: { mean, stddev, median: mean, min: mean, max: mean, rounds: 100, iterations: 1 },
  })),
  datetime: '2026-11-02T09:15:02.418935+00:00',
  version: '5.1.0',
});

const REF = pytest([
  ['test_encode', 1e-6, 1e-8],
  ['test_decode', 2e-6, 2e-7],
  ['test_crc', 5e-6, 1e-8],
  ['test_gone', 1e-3, 1e-5, 'maps'],
]);
const NEW = pytest([
  ['test_encode', 1.5e-6, 1e-8],      // 50% slower
  ['test_decode', 2.1e-6, 2e-7],      // within noise
  ['test_crc', 4e-6, 1e-8],           // faster
  ['test_route', 3e-3, 1e-5, 'maps'], // new
]);

const render = props => renderWithProviders(<BenchmarksReport text={NEW} ref_text={REF} path="pytest.benchmarks.json" {...props}/>);
const table = () => screen.getByRole('grid', { name: 'Benchmarks' });
const names = () => within(table()).getAllByRole('row').filter(r => !r.classList.contains('qa-bench-header') && !r.classList.contains('qa-bench-group'))
  .map(r => r.querySelector('.qa-bench-name').textContent);

describe('BenchmarksReport', () => {
  it('summarizes the changes against the reference', () => {
    render();
    const summary = screen.getByRole('toolbar', { name: 'Summary' });
    expect(summary).toHaveTextContent('4 benchmarks');
    expect(summary).toHaveTextContent('1 slower');
    expect(summary).toHaveTextContent('1 faster');
    expect(summary).toHaveTextContent('1 within noise');
    expect(summary).toHaveTextContent('1 new');
    expect(summary).toHaveTextContent('1 missing');
  });

  it('lists the regressions first, in their groups', () => {
    render();
    expect(names()).toEqual(['test_encode', 'test_decode', 'test_crc', 'test_gone', 'test_route']);
    const rows = within(table()).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('codec');
    const encode = rows.find(r => r.textContent.includes('test_encode'));
    expect(encode).toHaveTextContent('1.5 µs');
    expect(encode).toHaveTextContent('1 µs');
    expect(encode).toHaveTextContent('+50.0%');
    expect(encode.querySelector('.qa-bench-change')).toHaveClass('qa-bench-slower');
    const decode = rows.find(r => r.textContent.includes('test_decode'));
    // within noise: neither red nor green
    expect(decode.querySelector('.qa-bench-change')).toHaveClass('qa-bench-noise');
    expect(decode.getAttribute('title')).toMatch(/Within noise/);
    expect(rows.find(r => r.textContent.includes('test_gone'))).toHaveTextContent('missing');
  });

  it('filters', () => {
    render();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only changed' }));
    expect(names()).not.toContain('test_decode');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter the benchmarks' }), { target: { value: 'crc' } });
    expect(names()).toEqual(['test_crc']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter the benchmarks' }), { target: { value: '' } });
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Summary' })).getByText('1 faster'));
    expect(names()).toEqual(['test_crc']);
  });

  it('sorts', () => {
    render();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'name' } });
    expect(names()).toEqual(['test_crc', 'test_decode', 'test_encode', 'test_gone', 'test_route']);
  });

  it('collapses a group', () => {
    render();
    fireEvent.click(within(table()).getAllByRole('row').find(r => r.classList.contains('qa-bench-group') && r.textContent.includes('maps')));
    expect(names()).not.toContain('test_route');
  });

  it('shows the details of a benchmark', () => {
    render();
    fireEvent.click(within(table()).getAllByRole('row').find(r => r.textContent.includes('test_encode')));
    const details = screen.getByLabelText('Benchmark details');
    expect(details).toHaveTextContent('tests/test_codec.py::test_encode');
    expect(details).toHaveTextContent(/stddev\s*10 ns\s*10 ns/);
  });

  it('warns when the machines differ', () => {
    render({ ref_text: pytest([['test_encode', 1e-6, 1e-8]], { brand_raw: 'Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', count: 4 }) });
    expect(screen.getByText(/ran on different machines/)).toHaveTextContent('CPU count: 8 vs 4');
  });

  it('shows a run alone', () => {
    render({ ref_text: null });
    expect(screen.getByRole('toolbar', { name: 'Summary' })).toHaveTextContent('4 benchmarks');
    expect(screen.queryByText(/slower/)).not.toBeInTheDocument();
    expect(names()).toEqual(['test_crc', 'test_decode', 'test_encode', 'test_route']);
  });

  it('says when the file is not a benchmark file', () => {
    render({ text: '<html/>' });
    expect(screen.getByText(/unknown benchmark file/)).toBeInTheDocument();
  });

  it('says when the reference file is not readable', () => {
    render({ ref_text: 'oops' });
    expect(screen.getByText(/The reference's file could not be read/)).toBeInTheDocument();
  });

  it('stays fast with thousands of benchmarks', () => {
    const many = Array.from({ length: 5000 }, (_, i) => [`test_${i}`, 1e-6 * (1 + i % 7), 1e-8, `m${i % 20}`]);
    render({ text: pytest(many), ref_text: pytest(many.map(([n, v, s, g]) => [n, v * 1.01, s, g])) });
    expect(screen.getByRole('toolbar', { name: 'Summary' })).toHaveTextContent('5,000 benchmarks');
    // only the rows in view
    expect(within(table()).getAllByRole('row').length).toBeLessThan(60);
  });
});

describe('BenchmarksViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).includes('/ref/') ? REF : NEW, { headers: { 'Content-Type': 'text/plain' } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads the run\'s file and the reference\'s', async () => {
    renderWithProviders(<BenchmarksViewer path="pytest.benchmarks.json" output_new={{ output_dir_url: '/s/new' }} output_ref={{ output_dir_url: '/s/ref' }}/>);
    expect(await screen.findByRole('toolbar', { name: 'Summary' })).toHaveTextContent('1 slower');
  });

  it('shows files picked by their name that are not benchmark files as text, as before the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"threads": 4, "cache": "on"}', { headers: { 'Content-Type': 'text/plain' } })));
    renderWithProviders(<BenchmarksViewer path="benchmarks.json" output_new={{ output_dir_url: '/s/new' }} fallback_to_text/>);
    expect(await screen.findByText(/Not a benchmark file the viewer reads \(unknown benchmark file.*\): shown as text/)).toBeInTheDocument();
  });

  it('says why it cannot read a file it was told to read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"threads": 4}', { headers: { 'Content-Type': 'text/plain' } })));
    renderWithProviders(<BenchmarksViewer path="results.json" output_new={{ output_dir_url: '/s/new' }}/>);
    expect(await screen.findByText(/unknown benchmark file/)).toBeInTheDocument();
    expect(screen.queryByText(/shown as text/)).not.toBeInTheDocument();
  });
});

describe('is_benchmarks', () => {
  it('recognizes the names of benchmark files', () => {
    expect(['benchmarks.json', 'out/benchmark.json', 'pytest.benchmarks.json', 'codec-bench.jsonl', 'gbench_benchmark.json', 'a/b/perf.bench.ndjson'].every(is_benchmarks)).toBe(true);
    // a bare bench.json isn't picked: projects had files with that name before the viewer
    expect(['results.json', 'benchmarks.json.bak', 'workbench.json', 'bench.json', 'out/bench.json', 'benchmarks.txt'].some(is_benchmarks)).toBe(false);
  });
});
