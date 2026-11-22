/**
 * The "Logged media" section of run cards: one timeline for all the keys, each key next to the reference's same samples
 * at the same step. Run with: cd webapp && npm test -- loggedMedia
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import LoggedMedia, { defaultSeries } from '../media/LoggedMedia';
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
const Viewer = ({ path, path_ref, output_ref, boxes }) => <div data-testid="viewer">
  {path}{output_ref ? ` vs ${output_ref.output_dir_url}/${path_ref}` : ''}{boxes?.length ? ` boxes: ${boxes.map(box => box.label ?? '-').join(',')}` : ''}
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
