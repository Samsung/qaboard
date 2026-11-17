/**
 * The series viewer: one plot per series a run logged, the reference run's on the same axes.
 * Run with: cd webapp && npm test -- seriesViewer
 */
import { fireEvent, screen } from '@testing-library/react';

import SeriesViewer, { series_traces } from '../series';
import { OutputViewer } from '../OutputViewer';
import { side_color } from '../../sideColors';
import { renderWithProviders } from '../../test-utils';

// Plotly doesn't run in jsdom: we only check what would be plotted
vi.mock('../../components/Plot', () => ({
  default: ({ data, layout }) => <div
    data-testid="plot"
    data-title={layout.title.text}
    data-yaxis={layout.yaxis.type}
    data-traces={data.filter(t => t.name).map(t => `${t.name} ${t.line.color} ${t.line.dash ?? 'solid'} x=${t.x.join(' ')} y=${t.y.join(' ')}`).join(',')}
  />,
}));

const summary = series => JSON.stringify({ format: 'qaboard-series', version: 1, started_at: 100, series });
const files = {
  '/s/new/series.json': summary({
    'train/loss': { points: 3, step: [0, 10, 20], time: [0, 60, 120], value: [4, 2, 1] },
    lr: { points: 1, step: [0], time: [0], value: [0.001] },
  }),
  '/s/ref/series.json': summary({ 'train/loss': { points: 2, step: [0, 10], time: [0, 30], value: [5, 3] } }),
  '/s/new/series.jsonl': '{"_step":0,"_time":1,"loss":1}\n{"_step":1,"_time":2,"loss":0.5}\n',
  '/s/new/eval.series.json': '{"model": "resnet50", "series": "not ours"}',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = new URL(String(url?.url ?? url), 'http://localhost').pathname;
    return path in files ? new Response(files[path]) : new Response('not found', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const output_new = { id: 1, output_dir_url: '/s/new' };
const output_ref = { id: 2, output_dir_url: '/s/ref' };
const traces = async title => (await screen.findAllByTestId('plot')).find(plot => plot.dataset.title === title)?.dataset.traces;


describe('SeriesViewer', () => {
  it('plots each series, the reference dashed on the same axes', async () => {
    renderWithProviders(<SeriesViewer path="series.json" output_new={output_new} output_ref={output_ref}/>);
    expect(await traces('train/loss')).toBe('reference #9752fe dash x=0 10 y=5 3,new #2d72d2 solid x=0 10 20 y=4 2 1');
    // the reference didn't log it: the new run's alone
    expect(await traces('lr')).toBe('new #2d72d2 solid x=0 y=0.001');
    expect(screen.getAllByTestId('plot').map(plot => plot.dataset.title)).toEqual(['lr', 'train/loss']);
    expect(screen.getByText(/2 series, logged over 2m 00s/)).toBeInTheDocument();
  });

  it("uses the names and colors of what the page compares", async () => {
    const labels = { new: 'lr 1e-3', reference: 'release 1.4', colors: { new: side_color(0), reference: side_color(2) } };
    renderWithProviders(<SeriesViewer path="series.json" output_new={output_new} output_ref={output_ref} labels={labels}/>);
    expect(await traces('train/loss')).toBe('release 1.4 #cf0494 dash x=0 10 y=5 3,lr 1e-3 #2d72d2 solid x=0 10 20 y=4 2 1');
  });

  it('shows the run alone without a reference, or when the reference has no series', async () => {
    renderWithProviders(<SeriesViewer path="series.json" output_new={output_new} output_ref={{ id: 3, output_dir_url: '/s/missing' }}/>);
    expect(await traces('train/loss')).toBe('new #2d72d2 solid x=0 10 20 y=4 2 1');
  });

  it('applies the options chosen for all the cards, and tells the page when they change', async () => {
    const onControlsChange = vi.fn();
    renderWithProviders(<SeriesViewer path="series.json" output_new={output_new} series={{ x: 'time', log: true }} onControlsChange={onControlsChange}/>);
    expect(await traces('train/loss')).toBe('new #2d72d2 solid x=0 60 120 y=4 2 1');
    expect(screen.getAllByTestId('plot')[0].dataset.yaxis).toBe('log');
    fireEvent.click(screen.getByLabelText('Log scale'));
    // the changes to the page's controls: the other options chosen stay
    expect(onControlsChange).toHaveBeenLastCalledWith({ series: { x: 'time', log: false } });
    fireEvent.change(screen.getByLabelText('Horizontal axis'), { target: { value: 'step' } });
    expect(onControlsChange).toHaveBeenLastCalledWith({ series: { x: 'step', log: true } });
  });

  it('reads the history when there is no summary', async () => {
    renderWithProviders(<SeriesViewer path="series.jsonl" output_new={output_new}/>);
    expect(await traces('loss')).toBe('new #2d72d2 solid x=0 1 y=1 0.5');
  });

  it('says that a running run follows', async () => {
    renderWithProviders(<SeriesViewer path="series.json" output_new={{ ...output_new, is_running: true }}/>);
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it("says when the file can't be loaded or read", async () => {
    renderWithProviders(<SeriesViewer path="missing.json" output_new={output_new}/>);
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
    renderWithProviders(<SeriesViewer path="eval.series.json" output_new={output_new}/>);
    expect(await screen.findByText(/as series: no line has a number/)).toBeInTheDocument();
  });
});

describe('series_traces', () => {
  const options = { smoothing: 0, log: false, x: 'step' };
  const names = { new: 'new', ref: 'reference' };
  const colors = { new: '#2d72d2', ref: '#9752fe' };
  const downsampled = { series: { loss: { points: 8, step: [3, 7], time: [3, 7], value: [2, 1], min: [1, 0.5], max: [9, 1.5] } } };

  it('shows the range of the values each point of a long series stands for', () => {
    const [low, high, line] = series_traces('loss', { model_new: downsampled, options, names, colors });
    expect([low.y, high.y, line.y]).toEqual([[1, 0.5], [9, 1.5], [2, 1]]);
    expect(high.fill).toBe('tonexty');
    expect(low.hoverinfo).toBe('skip');
  });

  it('with smoothing, keeps the values behind, faded, instead of the range', () => {
    const [raw, line] = series_traces('loss', { model_new: downsampled, options: { ...options, smoothing: 0.5 }, names, colors });
    expect(raw.y).toEqual([2, 1]);
    expect(raw.name).toBeUndefined();
    expect(line.y[0]).toBe(2);
    expect(line.y[1]).toBeCloseTo(4 / 3, 10);
  });

  it('draws nothing for a series nobody logged', () => {
    expect(series_traces('other', { model_new: downsampled, model_ref: null, options, names, colors })).toEqual([]);
  });
});

describe('OutputViewer', () => {
  it('opens series files with the series viewer, by their name or with type: series', async () => {
    renderWithProviders(<OutputViewer path="series.json" output_new={output_new}/>);
    expect(await screen.findByTestId('series-viewer')).toBeInTheDocument();
  });

  it("shows files named like series that aren't as text, like before the viewer", async () => {
    renderWithProviders(<OutputViewer path="eval.series.json" output_new={output_new}/>);
    expect(await screen.findByText(/Not a series file the viewer reads/, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
