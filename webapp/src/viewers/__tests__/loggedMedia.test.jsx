/**
 * The "Logged media" section of run cards: one timeline for all the keys, each key next to the reference's same samples
 * at the same step. Run with: cd webapp && npm test -- loggedMedia
 */
import { createPortal } from 'react-dom';
import { fireEvent, render as renderPlain, screen, waitFor, within } from '@testing-library/react';

import LoggedMedia, { defaultSeries } from '../media/LoggedMedia';
import SeriesViewer from '../series';
import BoxControls from '../media/BoxControls';
import Timeline from '../media/Timeline';
import { MediaContext, run_file_url } from '../media/context';
import { OutputViewer } from '../OutputViewer';
import { usePrefsStore } from '../../stores/prefs';
import { renderWithProviders } from '../../test-utils';

// keys.jsx loads these views lazily: we load them once here, so that findBy* waits for them to render, not for a busy
// machine to transform their modules (it took over findBy's 1 s in CI)
beforeAll(() => Promise.all([import('../media/TableView'), import('../media/HistogramView'), import('../media/EvolutionStrip')]));

const line = item => JSON.stringify(item);
const index = items => items.map(line).join('\n') + '\n';
const image = (step, index, id, extra = {}) => ({ _step: step, key: 'val/samples', kind: 'image', index, id, caption: id, path: `media/val/samples/${step}_${index}.png`, width: 4, height: 4, ...extra });
const files = {
  '/s/new/media.jsonl': index([
    image(0, 0, 'cat', { boxes: [{ x: 1, y: 1, w: 2, h: 2, label: 'cat', score: 0.9, group: 'predictions' }, { x: 0, y: 0, w: 1, h: 1, label: 'cat', score: 0.2, group: 'predictions' }, { x: 0, y: 0, w: 4, h: 4, label: 'cat', group: 'ground_truth' }] }),
    image(0, 1, 'dog'),
    // the loader shuffled: samples match by id
    image(10, 0, 'dog'),
    image(10, 1, 'cat'),
    { _step: 10, key: 'answer', kind: 'text', path: 'media/answer/10_0.txt' },
    { _step: 20, key: 'answer', kind: 'text', path: 'media/answer/20_0.txt' },
    { _step: 20, key: 'predictions', kind: 'table', path: 'media/predictions/20_0.table.json', columns: ['label', 'score'], rows: 3 },
    { _step: 0, key: 'weights', kind: 'histogram', bins: [0, 1, 2], counts: [1, 3] },
    { _step: 20, key: 'weights', kind: 'histogram', bins: [0, 2, 4], counts: [2, 2] },
  ]),
  '/s/ref/media.jsonl': index([
    { _step: 10, key: 'answer', kind: 'text', path: 'media/answer/10_0.txt' },
    image(0, 0, 'dog'),
    image(0, 1, 'cat'),
    { _step: 20, key: 'predictions', kind: 'table', path: 'media/predictions/20_0.table.json', columns: ['label', 'score'], rows: 3 },
  ]),
  '/s/new/media/predictions/20_0.table.json': JSON.stringify({ columns: ['label', 'score'], data: [['cat', 0.5], ['dog', 0.9], ['bird', null]] }),
  '/s/ref/media/predictions/20_0.table.json': JSON.stringify({ columns: ['label', 'score'], data: [['cat', 0.5], ['dog', 0.7], ['fish', 1]] }),
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = new URL(String(url?.url ?? url), 'http://localhost').pathname;
    return path in files ? new Response(files[path]) : new Response('not found', { status: 404 });
  }));
  // jsdom has no layout: the table's virtualizer would render no row (like junitViewer.test.jsx)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(440);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const output_new = { id: 1, output_dir_url: '/s/new' };
const output_ref = { id: 2, output_dir_url: '/s/ref' };
// the viewers of the items: what they'd show
const Viewer = ({ path, path_ref, output_ref, boxes, boxes_ref, compared_to }) => <div data-testid="viewer">
  {path}{output_ref ? ` vs ${output_ref.output_dir_url}/${path_ref}` : ''}{boxes?.length ? ` boxes: ${boxes.map(box => box.label ?? '-').join(',')}` : ''}
  {boxes_ref?.length ? ` reference boxes: ${boxes_ref.map(box => box.label ?? '-').join(',')}` : ''}{compared_to ? ` (compared to ${compared_to})` : ''}
</div>;
const wrap = ui => <MediaContext.Provider value={{ fileUrl: run_file_url, Viewer }}>{ui}</MediaContext.Provider>;
const render = props => renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} project="p" {...props}/>));
const images = element => [...element.querySelectorAll('img')].map(img => img.getAttribute('src'));
const key = name => screen.getAllByTestId('media-key').find(section => section.getAttribute('aria-label') === name);

const lines = (dir, items) => { files[`/s/${dir}/media.jsonl`] = index(items); };
const text = (step, key, extra = {}) => ({ _step: step, key, kind: 'text', path: `media/${key}/${step}_0.txt`, ...extra });
const renderDirs = (dir_new, dir_ref, props = {}) => renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={{ id: 11, output_dir_url: `/s/${dir_new}` }} output_ref={dir_ref ? { id: 12, output_dir_url: `/s/${dir_ref}` } : undefined} project="p" {...props}/>));
beforeEach(() => usePrefsStore.setState({ mediaPins: {}, mediaGroupsCollapsed: {} }));

vi.mock('../../components/Plot', () => ({
  default: ({ layout }) => <div data-testid="plot" data-cursor={layout.shapes?.[0]?.x0}/>,
}));


describe('LoggedMedia: what runs logged', () => {
  it('says what the run logged, and shows each key at the last step next to the reference', async () => {
    render();
    expect(await screen.findByTestId('media-summary')).toHaveTextContent('4 keys · steps 0–20 · images, tables, histograms, texts');
    expect(screen.getByTestId('media-step')).toHaveTextContent('20');
    expect(screen.getByRole('slider', { name: 'Step' })).toHaveAttribute('aria-valuenow', '20');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs /s/ref/media/answer/10_0.txt');
    // never silently from another step
    expect(within(key('answer')).getByText('reference from step 10')).toBeInTheDocument();
    expect(within(key('val/samples')).getByText('from step 10')).toBeInTheDocument();
    // samples match by id: the reference shuffled them too. They stay where they were first seen: cat, then dog
    expect(images(key('val/samples'))).toEqual(['/s/new/media/val/samples/10_1.png', '/s/ref/media/val/samples/0_1.png', '/s/new/media/val/samples/10_0.png', '/s/ref/media/val/samples/0_0.png']);
    expect(await within(key('weights')).findByTestId('histogram-view')).toBeInTheDocument();
    // the contents, grouped by prefix
    const contents = screen.getByTestId('media-contents');
    expect(within(contents).getByRole('button', { name: /^val/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('teaches how to log media when there are none yet', async () => {
    files['/s/empty/media.jsonl'] = '';
    renderWithProviders(<OutputViewer type="media" path="media.jsonl" output_new={{ id: 4, output_dir_url: '/s/empty', is_running: true }}/>);
    expect(await screen.findByText("The run hasn't logged media yet")).toBeInTheDocument();
    expect(screen.getByText(/qaboard.Image\(img/)).toBeInTheDocument();
  });

  it('shows the new run alone when the reference has no media', async () => {
    render({ output_ref: { id: 5, output_dir_url: '/s/nothing' } });
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent(/^media\/answer\/20_0.txt$/);
  });

  it("says when the reference never logged a key, and when it hasn't yet", async () => {
    lines('since-new', [text(0, 'answer'), text(10, 'answer'), text(0, 'new_key')]);
    lines('since-ref', [text(5, 'answer')]);
    renderDirs('since-new', 'since-ref', { onControlsChange: () => {}, media_step: 0 });
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByText('not in reference yet')).toBeInTheDocument();
    expect(within(key('new_key')).getByText('not in reference')).toBeInTheDocument();
  });

  it('shows the new run alone when the reference has no files to ask for', async () => {
    // e.g. no output_dir_url: its query never runs, and stays pending
    render({ output_ref: { id: 6 } });
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent(/^media\/answer\/20_0.txt$/);
  });

  it("shows the keys only the reference logged, and the reference's steps", async () => {
    lines('union-new', [text(0, 'answer'), text(10, 'answer')]);
    lines('union-ref', [text(0, 'answer'), text(0, 'gone'), text(30, 'gone')]);
    renderDirs('union-new', 'union-ref');
    await screen.findByTestId('logged-media');
    // a regression: said, not hidden
    expect(screen.getByText('1 key not logged by new')).toBeInTheDocument();
    expect(within(key('gone')).getByText('Not logged by new')).toBeInTheDocument();
    expect(within(key('gone')).getByTestId('viewer')).toHaveTextContent(/^media\/gone\/0_0.txt$/);
    expect(within(screen.getByTestId('media-contents')).getByText('only reference')).toBeInTheDocument();
    expect(within(screen.getByTestId('media-timeline')).getByTitle('gone')).toBeInTheDocument();
    // the new run's last step by default, then the reference's steps can be picked: each side shows its nearest earlier one
    expect(screen.getByTestId('media-step')).toHaveTextContent('10');
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByTestId('media-step')).toHaveTextContent('30');
    expect(within(key('answer')).getByText('from step 10')).toBeInTheDocument();
    expect(within(key('gone')).getByTestId('viewer')).toHaveTextContent(/^media\/gone\/30_0.txt$/);
  });

  it('has a download link', async () => {
    render();
    await screen.findByTestId('logged-media');
    // a link (Blueprint's AnchorButton), not a button that ignores its href
    const download = within(key('answer')).getByRole('button', { name: 'Download answer' });
    expect(download.tagName).toBe('A');
    expect(download).toHaveAttribute('href', '/s/new/media/answer/20_0.txt');
    expect(download).toHaveAttribute('download');
  });

  it('draws the loss behind the timeline by default', () => {
    expect(defaultSeries(['lr', 'train/loss', 'val/loss_ema'])).toBe('train/loss');
    expect(defaultSeries(['lr', 'val_loss_ema'])).toBe('val_loss_ema');
    expect(defaultSeries(['lr', 'acc'])).toBe('lr');
    expect(defaultSeries([])).toBe(null);
  });

  it('draws a timeline of many steps', () => {
    const steps = Array.from({ length: 200000 }, (_, i) => i);
    renderPlain(<Timeline rows={[]} steps={steps} ref_steps={[]} step={10} onStep={() => {}} names={{ new: 'new', reference: 'reference' }} colors={{ new: 'blue', reference: 'purple' }}/>);
    expect(screen.getByRole('slider', { name: 'Step' })).toHaveAttribute('aria-valuemax', '199999');
  });

});

describe('LoggedMedia: steps and samples', () => {
  it('moves all the keys to a step, and keeps the sample users are on in the address', async () => {
    const onControlsChange = vi.fn();
    const { rerender } = render({ onControlsChange });
    await screen.findByTestId('logged-media');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_step: 10 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Step' }), { key: 'ArrowLeft' });
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_step: 10 });
    const props = { path: 'media.jsonl', output_new, output_ref, project: 'p', onControlsChange };
    rerender(wrap(<LoggedMedia {...props} media_step={5}/>));
    // a step chosen on another card snaps to this run's
    expect(screen.getByTestId('media-step')).toHaveTextContent('0');
    expect(screen.getByText('(chosen: 5)')).toBeInTheDocument();
    expect(within(key('answer')).getByText(/Not logged yet at step 0: from step 10/)).toBeInTheDocument();
    fireEvent.click(within(key('val/samples')).getAllByRole('button', { name: /Open cat/ })[0]);
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_focus: { key: 'val/samples', sample: 'id:cat', open: true, run: 1 } });
    // another card's focus isn't this one's
    rerender(wrap(<LoggedMedia {...props} media_step={0} media_focus={{ run: 99, key: 'val/samples', sample: 'id:cat', open: true }}/>));
    expect(within(key('val/samples')).queryByTestId('viewer')).not.toBeInTheDocument();
    rerender(wrap(<LoggedMedia {...props} media_step={0} media_focus={{ run: 1, key: 'val/samples', sample: 'id:cat', open: true }}/>));
    // the matched reference sample, and the boxes users see: the ground truth can be hidden
    expect(within(key('val/samples')).getByTestId('viewer')).toHaveTextContent('media/val/samples/0_0.png vs /s/ref/media/val/samples/0_1.png boxes: cat 0.90,cat 0.20,cat');
    // one image with boxes: said once, in the controls
    expect(within(key('val/samples')).getByTestId('box-count')).toHaveTextContent(/^3 boxes$/);
    expect(within(key('val/samples')).queryByTestId('box-badge')).not.toBeInTheDocument();
    fireEvent.click(within(key('val/samples')).getByLabelText('ground_truth'));
    expect(within(key('val/samples')).getByTestId('box-count')).toHaveTextContent('2 boxes (of 3)');
    expect(within(key('val/samples')).getByTestId('viewer')).toHaveTextContent('boxes: cat 0.90,cat 0.20');
  });

  it('has its own step without the page, and filters many keys', async () => {
    files['/s/many/media.jsonl'] = Array.from({ length: 10 }, (_, i) => line({ _step: i, key: `metrics/k${i}`, kind: 'text', path: `media/k${i}.txt` })).join('\n');
    usePrefsStore.setState({ mediaPins: { '': { 'metrics/k5': true } } });
    renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={{ id: 3, output_dir_url: '/s/many' }}/>));
    await screen.findByTestId('logged-media');
    expect(screen.getByTestId('media-step')).toHaveTextContent('9');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByTestId('media-step')).toHaveTextContent('8');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: 'ArrowLeft' });
    expect(screen.getByTestId('media-step')).toHaveTextContent('7');
    expect(within(screen.getByTestId('media-contents')).getByRole('button', { name: 'Unpin metrics/k5' })).toBeInTheDocument();
    fireEvent.change(screen.getAllByLabelText('Filter keys')[0], { target: { value: 'k3' } });
    expect(screen.getAllByTestId('media-key').map(k => k.getAttribute('aria-label'))).toEqual(['metrics/k3']);
    // pinned keys too
    expect(within(screen.getByTestId('media-contents')).queryByRole('button', { name: 'Unpin metrics/k5' })).not.toBeInTheDocument();
  });

  it('matches samples logged with the same caption in order, with keys of their own', async () => {
    const error = vi.spyOn(console, 'error');
    const cat = (dir, index) => ({ _step: 0, key: 'val/samples', kind: 'image', index, caption: 'cat', path: `media/${dir}_${index}.png`, width: 4, height: 4 });
    lines('dup-new', [cat('n', 0), cat('n', 1)]);
    lines('dup-ref', [cat('r', 0), cat('r', 1)]);
    renderDirs('dup-new', 'dup-ref');
    await screen.findByTestId('logged-media');
    expect(images(key('val/samples'))).toEqual(['/s/dup-new/media/n_0.png', '/s/dup-ref/media/r_0.png', '/s/dup-new/media/n_1.png', '/s/dup-ref/media/r_1.png']);
    expect([...key('val/samples').querySelectorAll('[data-sample]')].map(e => e.dataset.sample)).toEqual(['caption:cat', 'caption:cat#1']);
    expect(error.mock.calls.some(args => String(args[0]).includes('same key'))).toBe(false);
  });

  it("isn't broken by a focus from the address that isn't one", async () => {
    render({ onControlsChange: () => {}, media_step: 0, media_focus: { run: 1, key: 'val/samples', sample: { id: 'cat' }, evolution: true, open: 'yes' } });
    expect(await screen.findByTestId('logged-media')).toBeInTheDocument();
    expect(screen.queryByTestId('evolution-strip')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('media-key').length).toBeGreaterThan(0);
  });

  it('keeps each sample where it was first seen while the loader shuffles, new samples at the end', async () => {
    const at = (step, index, id) => ({ _step: step, key: 'val/samples', kind: 'image', index, id, path: `media/${step}_${index}.png`, width: 4, height: 4 });
    lines('shuffled', [at(0, 0, 'a'), at(0, 1, 'b'), at(10, 0, 'b'), at(10, 1, 'c'), at(10, 2, 'a')]);
    renderDirs('shuffled');
    await screen.findByTestId('logged-media');
    const samples = () => [...key('val/samples').querySelectorAll('[data-sample]')].map(e => e.dataset.sample);
    expect(samples()).toEqual(['id:a', 'id:b', 'id:c']);
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(samples()).toEqual(['id:a', 'id:b']);
    // the keyboard follows the same order
    fireEvent.keyDown(screen.getByTestId('logged-media'), { key: 'ArrowDown' });
    expect(key('val/samples').querySelector('[data-sample="id:b"] button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('puts the series cursor at the step the section shows, the reference\'s steps included', async () => {
    lines('parity-new', [text(0, 'answer'), text(10, 'answer')]);
    lines('parity-ref', [text(0, 'answer'), text(15, 'answer')]);
    files['/s/parity-new/series.json'] = JSON.stringify({ format: 'qaboard-series', version: 1, started_at: 0, series: { loss: { points: 2, step: [0, 20], time: [0, 1], value: [1, 0.5] } } });
    const outputs = { output_new: { id: 11, output_dir_url: '/s/parity-new' }, output_ref: { id: 12, output_dir_url: '/s/parity-ref' } };
    const manifests = { new: { 'media.jsonl': {}, 'series.json': {} }, reference: { 'media.jsonl': {} } };
    const page = media_step => wrap(<>
      <LoggedMedia path="media.jsonl" {...outputs} manifests={manifests} project="p" media_step={media_step} onControlsChange={() => {}}/>
      <SeriesViewer path="series.json" {...outputs} manifests={manifests} media_step={media_step} onControlsChange={() => {}}/>
    </>);
    const { rerender } = renderWithProviders(page(undefined));
    const cursor = async () => (await screen.findByTestId('plot')).dataset.cursor;
    await waitFor(async () => expect(await cursor()).toBe('10'));
    expect(screen.getByTestId('media-step')).toHaveTextContent('10');
    // a step only the reference logged: both go there
    rerender(page(17));
    await waitFor(async () => expect(await cursor()).toBe('15'));
    expect(screen.getByTestId('media-step')).toHaveTextContent('15');
  });
});

describe('LoggedMedia: images and boxes', () => {
  it("gives the image viewer the reference's own boxes", async () => {
    const box = label => [{ x: 0, y: 0, w: 1, h: 1, label }];
    lines('boxes-new', [{ ...image(0, 0, 'cat'), boxes: box('new-box') }]);
    lines('boxes-ref', [{ ...image(0, 0, 'cat'), boxes: box('ref-box') }]);
    renderDirs('boxes-new', 'boxes-ref', { media_focus: { run: 11, key: 'val/samples', sample: 'id:cat', open: true }, onControlsChange: () => {} });
    expect(await screen.findByText(/boxes: new-box reference boxes: ref-box/)).toBeInTheDocument();
  });

  it('keeps the label 0 in the legend', () => {
    renderPlain(<BoxControls items={[{ boxes: [{ x: 0, y: 0, w: 1, h: 1, label: 0 }, { x: 0, y: 0, w: 1, h: 1, label: 1 }] }]} filters={{ hidden: new Set(), min_score: 0 }} onChange={() => {}}/>);
    expect(within(screen.getByLabelText('Labels')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Labels')).getByText('1')).toBeInTheDocument();
  });

  it('hides the boxes of a label from the legend, and says counts once', async () => {
    const box = (label, x) => ({ x, y: 0, w: 1, h: 1, label });
    lines('labels', [{ ...image(0, 0, 'a'), boxes: [box('cat', 0), box('dog', 2)] }, { ...image(0, 1, 'b'), boxes: [box('cat', 1), box('cat', 2)] }]);
    renderDirs('labels');
    await screen.findByTestId('logged-media');
    const section = key('val/samples');
    // the same number on every image: once, in the controls
    expect(within(section).getByTestId('box-count')).toHaveTextContent('2 boxes each');
    expect(within(section).queryAllByTestId('box-badge')).toHaveLength(0);
    fireEvent.click(within(within(section).getByRole('group', { name: 'Labels' })).getByRole('button', { name: 'dog' }));
    expect(within(within(section).getByRole('group', { name: 'Labels' })).getByRole('button', { name: 'dog' })).toHaveAttribute('aria-pressed', 'false');
    // now they differ: on each image
    expect(within(section).queryByTestId('box-count')).not.toBeInTheDocument();
    expect(within(section).getAllByTestId('box-badge').map(badge => badge.textContent.trim())).toEqual(['1/2 ▢', '2 ▢']);
  });

  it('opens an image under the row of its sample, and brings it into view', async () => {
    const scrolled = [];
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    try {
      const many = Array.from({ length: 8 }, (_, i) => image(0, i, `s${i}`));
      lines('rows', many);
      renderDirs('rows');
      await screen.findByTestId('logged-media');
      fireEvent.click(within(key('val/samples')).getByRole('button', { name: 'Open s1' }));
      const grid = within(key('val/samples')).getByTestId('image-grid');
      const expanded = within(grid).getByTestId('image-grid-expanded');
      // after the first row's samples (4 columns of 150px in the 664px next to the contents), before the next row's
      const children = [...grid.children];
      expect(children.indexOf(expanded)).toBe(4);
      expect(within(expanded).getByTestId('viewer')).toHaveTextContent('media/val/samples/0_1.png');
      expect(scrolled.length).toBeGreaterThan(0);
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });
});

describe('LoggedMedia: tables and texts', () => {
  it('diffs tables against the reference, rows joined by a column', async () => {
    render();
    const section = await waitFor(() => key('predictions'));
    await within(section).findByRole('table');
    const rows = () => within(section).getByRole('table').querySelectorAll('[role=row][data-index]');
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(section).getByRole('columnheader', { name: /score/ }));
    expect([...rows()].map(row => row.textContent)).toEqual(['dog0.9', 'cat0.5', 'bird—']);
    fireEvent.click(within(section).getByRole('button', { name: 'Diff' }));
    expect(await within(section).findByText(/1 changed, 1 added, 1 removed/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Rows joined by')).toHaveValue('0');
    const changed = within(section).getByRole('table').querySelector('[data-changed]');
    expect(changed).toHaveTextContent('0.9');
    expect(changed).toHaveAttribute('title', '0.7 in reference');
    fireEvent.change(within(section).getByLabelText('Filter rows'), { target: { value: 'fi' } });
    expect(await within(section).findByText(/1 of 4 rows/)).toBeInTheDocument();
  });

  it('says what texts are compared with', async () => {
    render();
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('(compared to reference at step 10)');
    fireEvent.click(within(key('answer')).getByRole('button', { name: 'vs step 10' }));
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs /s/new/media/answer/10_0.txt (compared to step 10)');
  });

  it("shows the reference's values in changed cells: numbers with how much they changed, texts struck", async () => {
    files['/s/tdiff-new/media/t/0_0.table.json'] = JSON.stringify({ columns: ['id', 'score', 'label'], data: [['a', 0.9, 'cat'], ['b', 0.5, 'dog']] });
    files['/s/tdiff-ref/media/t/0_0.table.json'] = JSON.stringify({ columns: ['id', 'score', 'label'], data: [['a', 0.7, 'cat'], ['b', 0.5, 'bird']] });
    const table = { _step: 0, key: 't', kind: 'table', path: 'media/t/0_0.table.json' };
    lines('tdiff-new', [table]);
    lines('tdiff-ref', [table]);
    renderDirs('tdiff-new', 'tdiff-ref');
    const section = await waitFor(() => key('t'));
    fireEvent.click(await within(section).findByRole('button', { name: 'Diff' }));
    await within(section).findByText(/2 changed/);
    const changed = [...within(section).getByRole('table').querySelectorAll('[data-changed]')];
    expect(changed.map(cell => cell.textContent)).toEqual(['0.90.7 reference · +0.2', 'dogbird']);
    expect(changed[1].querySelector('del')).toHaveTextContent('bird');
  });

  it("doesn't tell whether images in cells changed without their hashes", async () => {
    const cell = { kind: 'image', path: 'media/t/0_0/0.png', width: 4, height: 4 };
    files['/s/timg-new/media/t/0_0.table.json'] = JSON.stringify({ columns: ['id', 'image'], data: [['a', cell]] });
    files['/s/timg-ref/media/t/0_0.table.json'] = JSON.stringify({ columns: ['id', 'image'], data: [['a', cell]] });
    const table = { _step: 0, key: 't', kind: 'table', path: 'media/t/0_0.table.json' };
    lines('timg-new', [table]);
    lines('timg-ref', [table]);
    renderDirs('timg-new', 'timg-ref');
    const section = await waitFor(() => key('t'));
    fireEvent.click(await within(section).findByRole('button', { name: 'Diff' }));
    expect(await within(section).findByText(/1 with images that can't be compared/)).toBeInTheDocument();
    expect(within(section).getByRole('table').querySelector('[data-changed]')).toBeNull();
    expect(within(section).getByRole('table').querySelector('[data-unknown]')).toBeInTheDocument();
  });
});

describe('LoggedMedia: keyboard', () => {
  it('shows a sample across the steps, with the keyboard too', async () => {
    renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} project="p"/>));
    await screen.findByTestId('logged-media');
    const button = within(key('val/samples')).getAllByRole('button', { name: /Open dog/ })[0];
    fireEvent.keyDown(button, { key: 'e' });
    const strip = await screen.findByTestId('evolution-strip');
    // the first image at the step: dog, at every step it was logged, wherever the loader put it
    expect(strip).toHaveTextContent('across 2 steps');
    await waitFor(() => expect(images(strip)).toEqual(['/s/new/media/val/samples/0_1.png', '/s/ref/media/val/samples/0_0.png', '/s/new/media/val/samples/10_0.png', '/s/ref/media/val/samples/0_0.png']));
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByTestId('evolution-strip')).not.toBeInTheDocument();
    fireEvent.keyDown(button, { key: '?' });
    expect(await screen.findByText('Logged media: keyboard')).toBeInTheDocument();
  });

  it("leaves the keys of popovers, inputs and buttons alone", async () => {
    const onControlsChange = vi.fn();
    // a viewer with a menu in a portal, like Blueprint's popovers
    const PortalViewer = ({ path }) => <div data-testid="viewer">{path}{createPortal(<button type="button">menu item</button>, document.body)}</div>;
    renderWithProviders(<MediaContext.Provider value={{ fileUrl: run_file_url, Viewer: PortalViewer }}>
      <LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} project="p" media_step={20} onControlsChange={onControlsChange}/>
    </MediaContext.Provider>);
    await screen.findByTestId('logged-media');
    fireEvent.keyDown(screen.getAllByRole('button', { name: 'menu item' })[0], { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getAllByRole('button', { name: 'menu item' })[0], { key: 'e' });
    expect(onControlsChange).not.toHaveBeenCalled();
    // in the section: it moves
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: 'ArrowLeft' });
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_step: 10 });
  });

  it('lets space activate buttons, and switch new and reference on thumbnails', async () => {
    renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} project="p"/>));
    await screen.findByTestId('logged-media');
    const thumbnail = within(key('val/samples')).getAllByRole('button', { name: /Open dog/ })[0];
    fireEvent.click(thumbnail);
    const order = images(key('val/samples'));
    expect(order[0]).toBe('/s/new/media/val/samples/10_1.png');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: ' ' });
    expect(images(key('val/samples'))).toEqual(order);
    // a native button: the contents' links to the keys
    fireEvent.keyDown(within(screen.getByTestId('media-contents')).getByRole('button', { name: 'answer' }), { key: ' ' });
    expect(images(key('val/samples'))).toEqual(order);
    fireEvent.keyDown(within(key('val/samples')).getAllByRole('button', { name: /Open dog/ })[0], { key: ' ' });
    expect(images(key('val/samples'))[0]).toBe('/s/ref/media/val/samples/0_1.png');
  });

  it('takes the focus on a click, and opens its own help with ?, not the app\'s', async () => {
    const onControlsChange = vi.fn();
    render({ onControlsChange, media_step: 20 });
    const region = await screen.findByTestId('logged-media');
    fireEvent.mouseDown(screen.getByTestId('media-summary'));
    expect(region).toHaveFocus();
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_step: 10 });
    // a click on a control keeps its focus
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Previous step' }));
    expect(region).toHaveFocus();
    const global = vi.fn();
    window.addEventListener('keydown', global);
    try {
      fireEvent.keyDown(region, { key: '?' });
      expect(await screen.findByText('Logged media: keyboard')).toBeInTheDocument();
      expect(global).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', global);
    }
    // while a dialog is open, the keys are the dialog's
    onControlsChange.mockClear();
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(onControlsChange).not.toHaveBeenCalled();
  });
});

describe('LoggedMedia: contents', () => {
  it('diffs texts against the previous step, and pins keys for the project', async () => {
    usePrefsStore.setState({ mediaPins: {}, mediaGroupsCollapsed: {} });
    render();
    await screen.findByTestId('logged-media');
    fireEvent.click(within(key('answer')).getByRole('button', { name: 'vs step 10' }));
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs /s/new/media/answer/10_0.txt');
    fireEvent.click(within(key('weights')).getByRole('button', { name: 'Pin weights' }));
    expect(usePrefsStore.getState().mediaPins).toEqual({ p: { weights: true } });
    expect(screen.getAllByTestId('media-key')[0]).toHaveAttribute('aria-label', 'weights');
    fireEvent.click(within(screen.getByTestId('media-contents')).getByRole('button', { name: /^val/ }));
    expect(usePrefsStore.getState().mediaGroupsCollapsed).toEqual({ p: { val: true } });
    expect(screen.queryAllByTestId('media-key').map(k => k.getAttribute('aria-label'))).not.toContain('val/samples');
  });

  // last: react-intersection-observer keeps its observers
  it('jumps to keys far below, not drawn yet', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const scrolled = [];
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    render();
    await screen.findByTestId('logged-media');
    // nothing is in view: placeholders
    expect(screen.queryAllByTestId('media-key')).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('media-contents')).getByRole('button', { name: 'answer' }));
    expect(scrolled.map(element => element.dataset.key)).toEqual(['answer']);
    delete Element.prototype.scrollIntoView;
  });
});
