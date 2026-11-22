/**
 * The "Logged media" section of run cards: one step slider for all the keys, each key next to the reference's at the
 * same step. Run with: cd webapp && npm test -- loggedMedia
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import LoggedMedia from '../media/LoggedMedia';
import { MediaContext, runFileUrl } from '../media/context';
import { OutputViewer } from '../OutputViewer';
import { renderWithProviders } from '../../test-utils';

const line = item => JSON.stringify(item);
const index = items => items.map(line).join('\n') + '\n';
const files = {
  '/s/new/media.jsonl': index([
    { _step: 0, key: 'val/samples', kind: 'image', index: 0, path: 'media/val/samples/0_0.png', width: 4, height: 4, caption: 'cat', boxes: [{ x: 1, y: 1, w: 2, h: 2, label: 'cat', score: 0.9 }] },
    { _step: 0, key: 'val/samples', kind: 'image', index: 1, path: 'media/val/samples/0_1.png', caption: 'dog' },
    { _step: 10, key: 'val/samples', kind: 'image', index: 0, path: 'media/val/samples/10_0.png', caption: 'cat' },
    { _step: 10, key: 'val/samples', kind: 'image', index: 1, path: 'media/val/samples/10_1.png', caption: 'dog' },
    { _step: 10, key: 'answer', kind: 'text', path: 'media/answer/10_0.txt' },
    { _step: 20, key: 'answer', kind: 'text', path: 'media/answer/20_0.txt' },
    { _step: 20, key: 'predictions', kind: 'table', path: 'media/predictions/20_0.table.json', columns: ['label', 'score'], rows: 3 },
    { _step: 0, key: 'weights', kind: 'histogram', bins: [0, 1, 2], counts: [1, 3] },
    { _step: 20, key: 'weights', kind: 'histogram', bins: [0, 2, 4], counts: [2, 2] },
  ]),
  '/s/ref/media.jsonl': index([
    { _step: 10, key: 'answer', kind: 'text', path: 'media/answer/10_0.txt' },
    { _step: 0, key: 'val/samples', kind: 'image', index: 0, path: 'media/val/samples/0_0.png' },
  ]),
  '/s/new/media/predictions/20_0.table.json': JSON.stringify({ columns: ['label', 'score'], data: [['cat', 0.5], ['dog', 0.9], ['bird', null]] }),
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const path = new URL(String(url?.url ?? url), 'http://localhost').pathname;
    return path in files ? new Response(files[path]) : new Response('not found', { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
// jsdom has no layout: the table's virtualizer would render no row (like junitViewer.test.jsx)
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(440);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
});

const output_new = { id: 1, output_dir_url: '/s/new' };
const output_ref = { id: 2, output_dir_url: '/s/ref' };
// the viewers of the items: what they'd show
const Viewer = ({ path, path_ref, output_ref, boxes }) => <div data-testid="viewer">
  {path}{output_ref ? ` vs ${path_ref}` : ''}{boxes?.length ? ` boxes: ${boxes.map(box => box.label).join(',')}` : ''}
</div>;
const render = props => renderWithProviders(<MediaContext.Provider value={{ fileUrl: runFileUrl, Viewer }}>
  <LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} {...props}/>
</MediaContext.Provider>);
const images = element => [...element.querySelectorAll('img')].map(img => img.getAttribute('src'));
const key = name => screen.getAllByTestId('media-key').find(section => section.getAttribute('aria-label') === name);


describe('LoggedMedia', () => {
  it('shows each key at the last step, next to the reference at the same step', async () => {
    render();
    expect(await screen.findByTestId('logged-media')).toBeInTheDocument();
    expect(screen.getByTestId('media-step')).toHaveTextContent('20');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent('media/answer/20_0.txt vs media/answer/10_0.txt');
    expect(within(key('answer')).getByText('reference: step 10')).toBeInTheDocument();
    // the images keep their last step
    expect(within(key('val/samples')).getByText('logged at step 10')).toBeInTheDocument();
    // the reference's at its own last step before
    expect(images(key('val/samples'))).toEqual(['/s/new/media/val/samples/10_0.png', '/s/ref/media/val/samples/0_0.png', '/s/new/media/val/samples/10_1.png']);
    expect(within(key('val/samples')).getByText('reference: step 0')).toBeInTheDocument();
    // the table, sortable
    const table = await within(key('predictions')).findByRole('table');
    const rows = () => within(table).getAllByRole('row').slice(1).map(row => row.textContent);
    await waitFor(() => expect(rows()).toEqual(['cat0.5', 'dog0.9', 'bird—']));
    fireEvent.click(within(table).getByRole('columnheader', { name: /score/ }));
    expect(rows()).toEqual(['dog0.9', 'cat0.5', 'bird—']);
    fireEvent.change(within(key('predictions')).getByLabelText('Filter rows'), { target: { value: 'bi' } });
    expect(await within(key('predictions')).findByText('1 of 3 rows')).toBeInTheDocument();
    expect(await within(key('weights')).findByTestId('histogram-view')).toBeInTheDocument();
    // keys are grouped by their prefix
    expect(screen.getByRole('button', { name: /val \(1\)/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves all the keys to a step, and opens images in the viewer with their boxes', async () => {
    const onControlsChange = vi.fn();
    const { rerender } = render({ onControlsChange });
    await screen.findByTestId('logged-media');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(onControlsChange).toHaveBeenLastCalledWith({ media_step: 10 });
    rerender(<MediaContext.Provider value={{ fileUrl: runFileUrl, Viewer }}>
      <LoggedMedia path="media.jsonl" output_new={output_new} output_ref={output_ref} onControlsChange={onControlsChange} media_step={5}/>
    </MediaContext.Provider>);
    // a step chosen on another card snaps to this run's
    expect(screen.getByTestId('media-step')).toHaveTextContent('0');
    expect(screen.getByText('(chosen: 5)')).toBeInTheDocument();
    expect(within(key('answer')).getByText('Not logged yet at step 0.')).toBeInTheDocument();
    // the reference's image of the same index under the new one
    expect(images(key('val/samples'))).toEqual(['/s/new/media/val/samples/0_0.png', '/s/ref/media/val/samples/0_0.png', '/s/new/media/val/samples/0_1.png']);
    fireEvent.click(within(key('val/samples')).getAllByRole('button', { name: /Open cat/ })[0]);
    expect(within(key('val/samples')).getByTestId('viewer')).toHaveTextContent('media/val/samples/0_0.png vs media/val/samples/0_0.png boxes: cat 0.90');
  });

  it('has its own step without the page, and filters many keys', async () => {
    const many = Array.from({ length: 10 }, (_, i) => line({ _step: i, key: `metrics/k${i}`, kind: 'text', path: `media/k${i}.txt` })).join('\n');
    files['/s/many/media.jsonl'] = many;
    renderWithProviders(<MediaContext.Provider value={{ fileUrl: runFileUrl, Viewer }}>
      <LoggedMedia path="media.jsonl" output_new={{ id: 3, output_dir_url: '/s/many' }}/>
    </MediaContext.Provider>);
    await screen.findByTestId('logged-media');
    expect(screen.getByTestId('media-step')).toHaveTextContent('9');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByTestId('media-step')).toHaveTextContent('8');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous step' }), { key: 'ArrowLeft' });
    expect(screen.getByTestId('media-step')).toHaveTextContent('7');
    expect(screen.getAllByTestId('media-key')).toHaveLength(10);
    fireEvent.change(screen.getByLabelText('Filter keys'), { target: { value: 'k3' } });
    expect(screen.getAllByTestId('media-key').map(k => k.getAttribute('aria-label'))).toEqual(['metrics/k3']);
  });

  it('says when the run logged nothing yet', async () => {
    files['/s/empty/media.jsonl'] = '';
    renderWithProviders(<OutputViewer type="media" path="media.jsonl" output_new={{ id: 4, output_dir_url: '/s/empty', is_running: true }}/>);
    expect(await screen.findByText("The run hasn't logged media yet.")).toBeInTheDocument();
  });

  it('shows the new run alone when the reference has no media', async () => {
    render({ output_ref: { id: 5, output_dir_url: '/s/nothing' } });
    await screen.findByTestId('logged-media');
    expect(within(key('answer')).getByTestId('viewer')).toHaveTextContent(/^media\/answer\/20_0.txt$/);
  });
});
