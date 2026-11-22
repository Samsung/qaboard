/**
 * The "Logged media" section of run cards: one timeline for all the keys, each key next to the reference's same samples
 * at the same step. Run with: cd webapp && npm test -- loggedMedia
 */
import { createPortal } from 'react-dom';
import { fireEvent, render as renderPlain, screen, waitFor, within } from '@testing-library/react';

import LoggedMedia, { defaultSeries } from '../media/LoggedMedia';
import BoxControls from '../media/BoxControls';
import Timeline from '../media/Timeline';
import { MediaContext, runFileUrl } from '../media/context';
import { OutputViewer } from '../OutputViewer';
import { usePrefsStore } from '../../stores/prefs';
import { renderWithProviders } from '../../test-utils';

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
const wrap = ui => <MediaContext.Provider value={{ fileUrl: runFileUrl, Viewer }}>{ui}</MediaContext.Provider>;
const render = props => renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} project="p" {...props}/>));
const images = element => [...element.querySelectorAll('img')].map(img => img.getAttribute('src'));
const key = name => screen.getAllByTestId('media-key').find(section => section.getAttribute('aria-label') === name);


describe('LoggedMedia', () => {
  it('says what the run logged, and shows each key at the last step next to the reference', async () => {
    render();
    expect(await screen.findByTestId('media-summary')).toHaveTextContent('4 keys · steps 0–20 · images, tables, histograms, texts');
    expect(screen.getByTestId('media-step')).toHaveTextContent('20');
    expect(screen.getByRole('slider', { name: 'Step' })).toHaveAttribute('aria-valuenow', '20');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs /s/ref/media/answer/10_0.txt');
    // never silently from another step
    expect(within(key('answer')).getByText('reference from step 10')).toBeInTheDocument();
    expect(within(key('val/samples')).getByText('from step 10')).toBeInTheDocument();
    // samples match by id: the reference shuffled them too
    expect(images(key('val/samples'))).toEqual(['/s/new/media/val/samples/10_0.png', '/s/ref/media/val/samples/0_0.png', '/s/new/media/val/samples/10_1.png', '/s/ref/media/val/samples/0_1.png']);
    expect(await within(key('weights')).findByTestId('histogram-view')).toBeInTheDocument();
    // the contents, grouped by prefix
    const contents = screen.getByTestId('media-contents');
    expect(within(contents).getByRole('button', { name: /^val/ })).toHaveAttribute('aria-expanded', 'true');
  });

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
    expect(changed).toHaveAttribute('title', '0.7 in the reference');
    fireEvent.change(within(section).getByLabelText('Filter rows'), { target: { value: 'fi' } });
    expect(await within(section).findByText(/1 of 4 rows/)).toBeInTheDocument();
  });

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
    expect(within(key('val/samples')).getByText('3 of 3 boxes')).toBeInTheDocument();
    fireEvent.click(within(key('val/samples')).getByLabelText('ground_truth'));
    expect(within(key('val/samples')).getByText('2 of 3 boxes')).toBeInTheDocument();
    expect(within(key('val/samples')).getByTestId('viewer')).toHaveTextContent('boxes: cat 0.90,cat 0.20');
  });

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

  it('has its own step without the page, and filters many keys', async () => {
    files['/s/many/media.jsonl'] = Array.from({ length: 10 }, (_, i) => line({ _step: i, key: `metrics/k${i}`, kind: 'text', path: `media/k${i}.txt` })).join('\n');
    renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={{ id: 3, output_dir_url: '/s/many' }}/>));
    await screen.findByTestId('logged-media');
    expect(screen.getByTestId('media-step')).toHaveTextContent('9');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByTestId('media-step')).toHaveTextContent('8');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: 'ArrowLeft' });
    expect(screen.getByTestId('media-step')).toHaveTextContent('7');
    fireEvent.change(screen.getAllByLabelText('Filter keys')[0], { target: { value: 'k3' } });
    expect(screen.getAllByTestId('media-key').map(k => k.getAttribute('aria-label'))).toEqual(['metrics/k3']);
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

  it('draws the loss behind the timeline by default', () => {
    expect(defaultSeries(['lr', 'train/loss', 'val/loss_ema'])).toBe('train/loss');
    expect(defaultSeries(['lr', 'val_loss_ema'])).toBe('val_loss_ema');
    expect(defaultSeries(['lr', 'acc'])).toBe('lr');
    expect(defaultSeries([])).toBe(null);
  });
});


describe('LoggedMedia, after review', () => {
  const lines = (dir, items) => { files[`/s/${dir}/media.jsonl`] = index(items); };
  const text = (step, key, extra = {}) => ({ _step: step, key, kind: 'text', path: `media/${key}/${step}_0.txt`, ...extra });
  const renderDirs = (dir_new, dir_ref, props = {}) => renderWithProviders(wrap(<LoggedMedia path="media.jsonl" output_new={{ id: 11, output_dir_url: `/s/${dir_new}` }} output_ref={dir_ref ? { id: 12, output_dir_url: `/s/${dir_ref}` } : undefined} project="p" {...props}/>));
  beforeEach(() => usePrefsStore.setState({ mediaPins: {}, mediaGroupsCollapsed: {} }));

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

  it('has a download link', async () => {
    render();
    await screen.findByTestId('logged-media');
    // a link (Blueprint's AnchorButton), not a button that ignores its href
    const download = within(key('answer')).getByRole('button', { name: 'Download answer' });
    expect(download.tagName).toBe('A');
    expect(download).toHaveAttribute('href', '/s/new/media/answer/20_0.txt');
    expect(download).toHaveAttribute('download');
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

  it("leaves the keys of popovers, inputs and buttons alone", async () => {
    const onControlsChange = vi.fn();
    // a viewer with a menu in a portal, like Blueprint's popovers
    const PortalViewer = ({ path }) => <div data-testid="viewer">{path}{createPortal(<button type="button">menu item</button>, document.body)}</div>;
    renderWithProviders(<MediaContext.Provider value={{ fileUrl: runFileUrl, Viewer: PortalViewer }}>
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
    expect(order[0]).toBe('/s/new/media/val/samples/10_0.png');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: ' ' });
    expect(images(key('val/samples'))).toEqual(order);
    // a native button: the contents' links to the keys
    fireEvent.keyDown(within(screen.getByTestId('media-contents')).getByRole('button', { name: 'answer' }), { key: ' ' });
    expect(images(key('val/samples'))).toEqual(order);
    fireEvent.keyDown(within(key('val/samples')).getAllByRole('button', { name: /Open dog/ })[0], { key: ' ' });
    expect(images(key('val/samples'))[0]).toBe('/s/ref/media/val/samples/0_0.png');
  });

  it('says what texts are compared with', async () => {
    render();
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('(compared to reference at step 10)');
    fireEvent.click(within(key('answer')).getByRole('button', { name: 'vs step 10' }));
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs /s/new/media/answer/10_0.txt (compared to step 10)');
  });

  it("gives the image viewer the reference's own boxes", async () => {
    const box = label => [{ x: 0, y: 0, w: 1, h: 1, label }];
    lines('boxes-new', [{ ...image(0, 0, 'cat'), boxes: box('new-box') }]);
    lines('boxes-ref', [{ ...image(0, 0, 'cat'), boxes: box('ref-box') }]);
    renderDirs('boxes-new', 'boxes-ref', { media_focus: { run: 11, key: 'val/samples', sample: 'id:cat', open: true }, onControlsChange: () => {} });
    expect(await screen.findByText(/boxes: new-box reference boxes: ref-box/)).toBeInTheDocument();
  });

  it("isn't broken by a focus from the address that isn't one", async () => {
    render({ onControlsChange: () => {}, media_step: 0, media_focus: { run: 1, key: 'val/samples', sample: { id: 'cat' }, evolution: true, open: 'yes' } });
    expect(await screen.findByTestId('logged-media')).toBeInTheDocument();
    expect(screen.queryByTestId('evolution-strip')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('media-key').length).toBeGreaterThan(0);
  });

  it('keeps the label 0 in the legend', () => {
    renderPlain(<BoxControls items={[{ boxes: [{ x: 0, y: 0, w: 1, h: 1, label: 0 }, { x: 0, y: 0, w: 1, h: 1, label: 1 }] }]} filters={{ hidden: new Set(), min_score: 0 }} onChange={() => {}}/>);
    expect(within(screen.getByLabelText('Labels')).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Labels')).getByText('1')).toBeInTheDocument();
  });

  it('draws a timeline of many steps', () => {
    const steps = Array.from({ length: 200000 }, (_, i) => i);
    renderPlain(<Timeline rows={[]} steps={steps} ref_steps={[]} step={10} onStep={() => {}} names={{ new: 'new', ref: 'reference' }} colors={{ new: 'blue', ref: 'gray' }}/>);
    expect(screen.getByRole('slider', { name: 'Step' })).toHaveAttribute('aria-valuemax', '199999');
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
