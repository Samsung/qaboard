/**
 * Tests for the list of output cards: incremental rendering and shared manifests.
 * Run with: cd webapp && npm test -- OutputCardsList
 */
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { setupIntersectionMocking, resetIntersectionMocking, mockAllIsIntersecting } from 'react-intersection-observer/test-utils';
import { MemoryRouter } from 'react-router';
import { renderWithProviders } from '../../test-utils';

import { OutputCardsList } from '../OutputCardsList';


const make_output = (id, extra) => ({
  id,
  output_type: 'slam',
  platform: 'linux',
  configurations: [],
  extra_parameters: {},
  is_failed: false,
  is_pending: false,
  is_running: false,
  data: {},
  metrics: {},
  output_dir_url: `/s/out/${id}`,
  test_input_database: '/db',
  test_input_path: `input_${id}`,
  test_input_metadata: {},
  created_date: '2026-09-01T10:00:00Z',
  ...extra,
});

const render_list = props => renderWithProviders(<MemoryRouter><OutputCardsList {...props} /></MemoryRouter>);
const cards = container => container.querySelectorAll('div.output-card:not(.bp6-card)');

const batches = nb_outputs => {
  const outputs = Object.fromEntries([...Array(nb_outputs).keys()].map(i => [i, make_output(i, { reference_id: 1000 })]));
  return {
    new_batch: { outputs, filtered: { outputs: Object.keys(outputs).map(Number) } },
    ref_batch: { outputs: { 1000: make_output(1000) } },
  };
};

const props = {
  project: 'proj',
  config: { outputs: { visualizations: [] } },
  metrics: { main_metrics: [], available_metrics: {} },
  new_commit: { id: 'abc', branch: 'main' },
  controls: { show: {}, dynamic_options: {}, dynamic_options_sync: {} },
};

beforeEach(() => {
  setupIntersectionMocking(vi.fn);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ 'log.txt': { st_size: 10, md5: 'x' } }), { status: 200 })));
});

afterEach(() => {
  resetIntersectionMocking();
  vi.unstubAllGlobals();
});


describe('OutputCardsList', () => {
  it('renders all the cards of usual batches, so that Ctrl+F finds them', () => {
    const { container } = render_list({ ...props, ...batches(300) });
    expect(cards(container)).toHaveLength(300);
    expect(screen.queryByText(/show all/)).toBeNull();
  }, 30_000);

  it('keeps cards light until they come into view', () => {
    const { container } = render_list({ ...props, ...batches(2) });
    expect(screen.getByText('input_1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Full screen')).toBeNull();
    act(() => mockAllIsIntersecting(true));
    expect(screen.getAllByLabelText('Full screen')).toHaveLength(2);
    expect(cards(container)).toHaveLength(2);
  });

  it('renders the cards of big batches incrementally, as users scroll', async () => {
    const { container } = render_list({ ...props, ...batches(450) });
    expect(cards(container)).toHaveLength(300);
    act(() => mockAllIsIntersecting(true));
    await waitFor(() => expect(cards(container)).toHaveLength(450));
    expect(screen.queryByText(/show all/)).toBeNull();
  }, 30_000);

  it('can show all the cards of big batches at once', () => {
    const { container } = render_list({ ...props, ...batches(450) });
    fireEvent.click(screen.getByText('show all 450 runs'));
    expect(cards(container)).toHaveLength(450);
    expect(screen.getByText('input_449')).toBeInTheDocument();
  }, 30_000);

  it('fetches each manifest once, even when cards share a reference', async () => {
    render_list({ ...props, ...batches(3) });
    act(() => mockAllIsIntersecting(true));
    const urls = () => fetch.mock.calls.map(([url]) => url);
    await waitFor(() => expect(urls()).toContain('/s/out/2/manifest.outputs.json'));
    expect(urls().filter(url => url === '/s/out/1000/manifest.outputs.json')).toHaveLength(1);
    expect(urls().filter(url => url === '/s/out/0/manifest.outputs.json')).toHaveLength(1);
  });

  it('says when the batch has no runs, or when none matches the filter', () => {
    const empty = { new_batch: { outputs: {}, filtered: { outputs: [] } }, ref_batch: { outputs: {} } };
    const { unmount } = render_list({ ...props, ...empty });
    expect(screen.getByText('No runs in this batch yet')).toBeInTheDocument();
    unmount();

    const { new_batch, ref_batch } = batches(2);
    renderWithProviders(<MemoryRouter initialEntries={['/p/commit/abc?filter=nothing']}>
      <OutputCardsList {...props} ref_batch={ref_batch} new_batch={{ ...new_batch, filtered: { outputs: [] } }}/>
    </MemoryRouter>);
    expect(screen.getByText('No run matches “nothing”')).toBeInTheDocument();
    expect(screen.getByText('Clear the filter')).toBeInTheDocument();
  });

  it("doesn't mutate the batches", () => {
    const { new_batch, ref_batch } = batches(5);
    Object.freeze(new_batch.filtered.outputs);
    Object.values(new_batch.outputs).forEach(Object.freeze);
    render_list({ ...props, new_batch, ref_batch });
    act(() => mockAllIsIntersecting(true));
    expect(screen.getByText('input_4')).toBeInTheDocument();
  });

  const two_scenes = () => fetch.mockImplementation(async () => new Response(JSON.stringify({ 'a/out.bin': { md5: '1' }, 'b/out.bin': { md5: '2' } }), { status: 200 }));
  const scene_config = { outputs: { visualizations: [{ name: 'Out', path: ':scene/out.bin', type: 'unknown/type' }] } };

  it('registers the options of the visualizations, linked by default: values come from the controls panel', async () => {
    two_scenes();
    const onRegisterOutputOptions = vi.fn();
    renderWithProviders(<MemoryRouter><OutputCardsList {...props} {...batches(1)} config={scene_config} onRegisterOutputOptions={onRegisterOutputOptions} /></MemoryRouter>);
    act(() => mockAllIsIntersecting(true));
    await waitFor(() => expect(onRegisterOutputOptions).toHaveBeenCalled());
    const [output_id, options] = onRegisterOutputOptions.mock.calls.at(-1);
    expect(output_id).toBe(0);
    expect(options.scene.values).toEqual(['a', 'b']);
    expect(await screen.findByText(/No viewer for the type/)).toHaveTextContent('unknown/type');
    // linked: no control in the card
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('a/out.bin')).toBeInTheDocument();
  });

  it("links to the input's History from the run's menu, from 3 days before the commit", async () => {
    const history_link = async () => {
      fireEvent.click(screen.getAllByLabelText('Run actions')[0]);
      return new URL((await screen.findByTitle("See this input's results over time")).closest('a').href, 'http://localhost');
    };
    // History shows the last 3 days by default: an older commit wouldn't be in it
    const { unmount } = render_list({ ...props, ...batches(1), new_commit: { id: 'abc', branch: 'main', authored_datetime: '2020-01-10T10:00:00Z' } });
    act(() => mockAllIsIntersecting(true));
    // the input's path is not a link anymore
    expect(screen.getByText('input_0').closest('a')).toBeNull();
    const link = await history_link();
    expect(link.pathname).toBe('/proj/history/main');
    expect(link.searchParams.get('from')).toBe('2020-01-07');
    expect(link.searchParams.get('filter')).toBe('input_0');
    unmount();
    // recent commits are in the default dates
    render_list({ ...props, ...batches(1), new_commit: { id: 'abc', branch: 'main', authored_datetime: new Date().toISOString() } });
    act(() => mockAllIsIntersecting(true));
    expect((await history_link()).searchParams.get('from')).toBeNull();
  });

  it('draws the visualizations of projects that use their old name, detailed_views', async () => {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ 'out.bin': { md5: '1' } }), { status: 200 }));
    const config = { outputs: { detailed_views: [{ name: 'Out', path: 'out.bin', type: 'unknown/type' }] } };
    renderWithProviders(<MemoryRouter><OutputCardsList {...props} {...batches(1)} config={config} onRegisterOutputOptions={vi.fn()} /></MemoryRouter>);
    act(() => mockAllIsIntersecting(true));
    expect(await screen.findByText(/No viewer for the type/)).toHaveTextContent('unknown/type');
  });

  it("says when the run doesn't have the value selected for all outputs, and shows the closest", async () => {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ '1/out.bin': {}, '2/out.bin': {}, '10/out.bin': {} }), { status: 200 }));
    const config = { outputs: { visualizations: [{ name: 'Out', path: ':frame/out.bin', type: 'unknown/type' }] } };
    const controls = { ...props.controls, dynamic_options: { frame: ['8'] } };
    renderWithProviders(<MemoryRouter><OutputCardsList {...props} {...batches(1)} config={config} controls={controls} onRegisterOutputOptions={vi.fn()} /></MemoryRouter>);
    act(() => mockAllIsIntersecting(true));
    expect(await screen.findByText(/isn't in this run, showing/)).toHaveTextContent("Frame 8 isn't in this run, showing 10");
    expect(screen.getByText('10/out.bin')).toBeInTheDocument();
  });

  it('unlinked options have a control in each card, starting from the linked value', async () => {
    two_scenes();
    const controls = { ...props.controls, dynamic_options: { scene: ['b'] }, dynamic_options_sync: { scene: false } };
    const onToggleDynamicOptionSync = vi.fn();
    renderWithProviders(<MemoryRouter><OutputCardsList {...props} {...batches(1)} config={scene_config} controls={controls} onRegisterOutputOptions={vi.fn()} onToggleDynamicOptionSync={onToggleDynamicOptionSync} /></MemoryRouter>);
    act(() => mockAllIsIntersecting(true));
    const select = await screen.findByRole('combobox');
    expect(select).toHaveValue('b');
    fireEvent.change(select, { target: { value: 'a' } });
    expect(select).toHaveValue('a');
    fireEvent.click(screen.getByText('Same for all runs'));
    expect(onToggleDynamicOptionSync).toHaveBeenCalledWith('scene');
  });
});
