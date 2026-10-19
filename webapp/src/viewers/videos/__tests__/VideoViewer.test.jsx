/**
 * The video viewer, with jsdom's <video> elements made to look loaded. Real playback is tested in e2e/videos.spec.js.
 * Run with: cd webapp && npm test -- VideoViewer
 */
import { act, fireEvent, screen, within } from '@testing-library/react';

import { renderWithProviders } from '../../../test-utils';
import { http } from '../../../api/http';
import VideoViewer from '../VideoViewer';
import { differencePeaks } from '../VideoCompare';
import { frameStatus } from '../panels';

vi.mock('../../../api/http', async importOriginal => ({ ...await importOriginal(), http: { get: vi.fn(), post: vi.fn() } }));

const output = id => ({ id, output_dir_url: `/s/outputs/${id}` });
const manifest = md5 => ({ 'video.mp4': { md5, st_size: 2_000_000 } });

// What the server reads from the files (backend/videos.py)
const info = (overrides = {}) => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'h264', profile: 'High', pix_fmt: 'yuv420p', bit_depth: 8,
  chroma_subsampling: '4:2:0', channels: ['Y', 'Cb', 'Cr'], color_range: 'limited', color_matrix: 'BT.709',
  width: 640, height: 360, fps: 25, frame_count: 250, duration: 10, bit_rate: 1.6e6, keyframes: [0, 125],
  lossless: null, audio: [], times: Array.from({ length: 250 }, (_, i) => i / 25),
  ...overrides,
});

// jsdom doesn't implement media playback
const load = (video, { duration = 10, width = 640, height = 360 } = {}) => {
  let paused = true;
  let time = 0;
  Object.defineProperties(video, {
    readyState: { value: 4, configurable: true },
    duration: { value: duration, configurable: true },
    videoWidth: { value: width, configurable: true },
    videoHeight: { value: height, configurable: true },
    seeking: { value: false, configurable: true },
    paused: { get: () => paused, configurable: true },
    currentTime: { get: () => time, set: t => { time = t; }, configurable: true },
    play: { value: vi.fn(() => { paused = false; return Promise.resolve(); }), configurable: true },
    pause: { value: vi.fn(() => { paused = true; }), configurable: true },
  });
  act(() => {
    video.dispatchEvent(new Event('loadedmetadata'));
  });
};

const signed_in = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: null };
const viewer = (props, { user = signed_in } = {}) => renderWithProviders(<VideoViewer
  output_new={output('new')}
  path="video.mp4"
  manifests={{ new: manifest('a'), reference: manifest('b') }}
  {...props}
/>, { user });

const labels = container => [...container.querySelectorAll('.qiv-label')].map(label => `${label.textContent}@${label.classList.contains('qiv-label-left') ? 'left' : 'right'}`);

beforeEach(() => {
  localStorage.clear();
  http.get.mockReset();
  http.post.mockReset();
  // by default the server can't read the videos, e.g. without PyAV
  http.get.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 501, data: { error: "The server can't read videos" } } }));
});

describe('VideoViewer', () => {
  it('plays and pauses a video without reference', () => {
    // it used to crash: "TypeError: viewer_reference_ref.current.pause is not a function"
    viewer();
    const video = screen.getByLabelText('New video');
    expect(video).toHaveAttribute('src', '/s/outputs/new/video.mp4');
    expect(screen.queryByLabelText('Reference video')).toBeNull();
    load(video);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(video.play).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(video.pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('plays both videos', () => {
    const { container } = viewer({ output_ref: output('ref') });
    const video_new = screen.getByLabelText('New video');
    const video_ref = screen.getByLabelText('Reference video');
    expect(video_ref).toHaveAttribute('src', '/s/outputs/ref/video.mp4');
    load(video_new);
    load(video_ref);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(video_new.play).toHaveBeenCalled();
    expect(video_ref.play).toHaveBeenCalled();
    expect(labels(container)).toEqual(['new640×360@left', 'reference640×360@left']);
  });

  it('highlights a range of values picked on the histogram', () => {
    // it used to crash: "TypeError: Cannot read properties of undefined (reading 'join')"
    const { container } = viewer({ output_ref: output('ref') });
    load(screen.getByLabelText('New video'));
    load(screen.getByLabelText('Reference video'));
    fireEvent.click(screen.getByRole('button', { name: 'Histogram of the frames' }));
    const histogram = within(container.querySelector('.qiv-histogram'));
    const red = histogram.getByRole('button', { name: 'R' });
    fireEvent.click(red);
    expect(red).toHaveAttribute('aria-pressed', 'true');
    expect(histogram.getByRole('button', { name: 'G' })).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelectorAll('.video-highlight')).toHaveLength(0);

    // drag from 64 to 128 on a 256px wide histogram
    const plot = histogram.getByRole('slider');
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 256, height: 120, right: 256, bottom: 120 });
    fireEvent.pointerDown(plot, { button: 0, clientX: 64 });
    fireEvent.pointerMove(plot, { clientX: 128 });
    fireEvent.pointerUp(plot, { clientX: 128 });
    expect(plot).toHaveAttribute('aria-valuetext', '64 to 128');
    // over both videos, side by side
    expect(container.querySelectorAll('.video-highlight')).toHaveLength(2);

    fireEvent.click(histogram.getByRole('button', { name: /Stop highlighting/ }));
    expect(container.querySelectorAll('.video-highlight')).toHaveLength(0);
  });

  it('shows one video when the reference is the same file', () => {
    viewer({ output_ref: output('ref'), manifests: { new: manifest('a'), reference: manifest('a') } });
    expect(screen.queryByLabelText('Reference video')).toBeNull();
    expect(screen.getByText('same video as the reference')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Comparison' })).toBeNull();
  });

  it('switches comparison modes, and remembers the choice', () => {
    const { container, unmount } = viewer({ output_ref: output('ref') });
    expect(container.querySelector('.video-wipe')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Wipe' }));
    expect(container.querySelector('.video-wipe')).not.toBeNull();
    unmount();
    const again = viewer({ output_ref: output('ref') });
    expect(again.container.querySelector('.video-wipe')).not.toBeNull();
  });

  it('toggles like the image viewer: the other video, their difference, and again', () => {
    const { container } = viewer({ output_ref: output('ref') });
    load(screen.getByLabelText('New video'));
    load(screen.getByLabelText('Reference video'));
    const shown = () => container.querySelector('.qiv-label')?.textContent ?? null;
    fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
    expect(shown()).toMatch(/^new/);
    fireEvent.keyDown(document.activeElement, { key: 't' });
    expect(shown()).toMatch(/^reference/);
    fireEvent.keyDown(document.activeElement, { key: 't' });
    expect(screen.getByRole('radio', { name: 'Difference' })).toHaveAttribute('aria-checked', 'true');
    expect(container.querySelector('canvas[aria-label="Difference"]')).not.toBeNull();
    fireEvent.keyDown(document.activeElement, { key: 't' });
    expect(shown()).toMatch(/^new/);
    // clicking Single again flips the videos
    fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
    expect(shown()).toMatch(/^reference/);
  });

  it('shows the difference between the videos, or alone', () => {
    const { container } = viewer({ output_ref: output('ref') });
    load(screen.getByLabelText('New video'));
    load(screen.getByLabelText('Reference video'));
    fireEvent.click(screen.getByRole('radio', { name: 'Difference' }));
    // between them, with the image viewer's methods
    expect(screen.getByText('difference')).toBeInTheDocument();
    expect(screen.getByLabelText('How to compute the difference')).toHaveValue('perceptual');
    expect(labels(container)).toEqual(['new640×360@left', 'reference640×360@left', 'difference@left']);
    fireEvent.click(screen.getByRole('radio', { name: 'Difference' }));
    expect(screen.queryByText('difference')).toBeNull();
    fireEvent.change(screen.getByLabelText('How to compute the difference'), { target: { value: 'absolute' } });
    expect(screen.getByLabelText('Amplification')).toBeInTheDocument();
  });

  it('gives the keyboard back to the videos after picking a mode', () => {
    viewer({ output_ref: output('ref') });
    fireEvent.click(screen.getByRole('radio', { name: 'Wipe' }));
    // else the arrow keys would change the mode instead of stepping frames
    expect(document.activeElement).toHaveAttribute('role', 'application');
  });

  it('has keyboard shortcuts for the viewer under the mouse', () => {
    const { container } = viewer({ output_ref: output('ref') });
    const video_new = screen.getByLabelText('New video');
    load(video_new);
    load(screen.getByLabelText('Reference video'));
    // not hovered: nothing happens
    fireEvent.keyDown(document, { key: '2' });
    expect(container.querySelector('.video-wipe')).toBeNull();
    fireEvent.pointerEnter(container.querySelector('.video-viewer'));
    fireEvent.keyDown(document, { key: '2' });
    expect(container.querySelector('.video-wipe')).not.toBeNull();
    // t swaps the sides
    expect(labels(container)).toEqual(['new640×360@left', 'reference640×360@right']);
    fireEvent.keyDown(document, { key: 't' });
    expect(labels(container)).toEqual(['reference640×360@left', 'new640×360@right']);
    fireEvent.keyDown(document, { key: ' ' });
    expect(video_new.play).toHaveBeenCalled();
    // < and > change the speed
    fireEvent.keyDown(document, { key: '>' });
    expect(screen.getByLabelText('Speed')).toHaveValue('1.5');
    fireEvent.keyDown(document, { key: '<' });
    fireEvent.keyDown(document, { key: '<' });
    expect(screen.getByLabelText('Speed')).toHaveValue('0.5');
  });

  it('runs a blind test', () => {
    const { container } = viewer({ output_ref: output('ref') });
    load(screen.getByLabelText('New video'));
    load(screen.getByLabelText('Reference video'));
    fireEvent.click(screen.getByRole('radio', { name: 'Wipe' }));
    fireEvent.click(screen.getByRole('button', { name: /Blind test/ }));
    // what shows first, on the left, is A
    expect(labels(container)).toEqual(['A640×360@left', 'B640×360@right']);
    expect(screen.queryByRole('menuitem', { name: /Open the/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(labels(container).join()).toMatch(/new · [AB]/);
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(labels(container)).toEqual(['new640×360@left', 'reference640×360@right']);
  });

  it('explains why a video can\'t play', () => {
    viewer();
    const video = screen.getByLabelText('New video');
    Object.defineProperty(video, 'error', { value: { code: 4, message: 'DEMUXER_ERROR_NO_SUPPORTED_STREAMS' } });
    act(() => {
      video.dispatchEvent(new Event('error'));
    });
    expect(screen.getByText('Can\'t play this video')).toBeInTheDocument();
    expect(screen.getByText(/ffmpeg -i input -c:v libx264/)).toBeInTheDocument();
  });

  it('shows animated images', () => {
    viewer({ path: 'anim.webp', output_ref: output('ref'), manifests: { new: {}, reference: {} } });
    expect(screen.getByAltText('New')).toHaveAttribute('src', '/s/outputs/new/anim.webp');
    expect(screen.getByAltText('Reference')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Difference' })).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('encodes file names', () => {
    viewer({ path: 'dir/clip #1.mp4' });
    expect(screen.getByLabelText('New video')).toHaveAttribute('src', '/s/outputs/new/dir/clip%20%231.mp4');
  });

  it('says what\'s in the files, and what differs', async () => {
    http.get.mockImplementation(async (url, { params }) => {
      expect(url).toBe('/api/v1/output/video/info');
      return { data: params.video_url.includes('/ref/') ? info({ codec: 'hevc', profile: 'Main', fps: 30 }) : info() };
    });
    viewer({ output_ref: output('ref') });
    fireEvent.click(screen.getByRole('button', { name: "What's in the files" }));
    const panel = await screen.findByText('Pixel format');
    const table = panel.closest('table');
    expect(within(table).getByText('h264 (High)')).toBeInTheDocument();
    expect(within(table).getByText('hevc (Main)')).toBeInTheDocument();
    expect(within(table).getByText('h264 (High)').closest('tr')).toHaveClass('video-info-differs');
    expect(within(table).getAllByText('yuv420p')[0].closest('tr')).not.toHaveClass('video-info-differs');
    expect(within(table).getAllByText('2.0 MB')).toHaveLength(2);
    expect(screen.getByText(/converts the decoded Y′CbCr with the BT.709 matrix, limited range/)).toBeInTheDocument();
    expect(screen.getByText(/Chroma 4:2:0/)).toBeInTheDocument();
    expect(screen.getByText(/^reference: hevc is lossy unless encoded losslessly/)).toBeInTheDocument();
  });

  it('numbers frames from the file\'s timestamps', async () => {
    http.get.mockResolvedValue({ data: info() });
    viewer();
    const video = screen.getByLabelText('New video');
    load(video);
    expect(await screen.findByText('/ 250')).toBeInTheDocument();
    act(() => { video.currentTime = 2.02; });
    screen.getByRole('application').focus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    // the middle of frame 51
    expect(video.currentTime).toBeCloseTo(2.06);
  });

  it('finds where the videos differ, frame by frame', async () => {
    http.get.mockResolvedValue({ data: info() });
    const frames = Array.from({ length: 250 }, (_, i) => ({
      time: i / 25, ref: i, type: i % 125 ? 'P' : 'I', ref_type: 'P', psnr: null, mad: 0, max: 0, changed: 0, value: 0, regions: [],
    }));
    frames[40] = { ...frames[40], psnr: 31.5, max: 60, changed: 0.02, value: 60 / 255, regions: [{ x: 100, y: 50, w: 64, h: 64, value: 60 / 255, diff: 1 }] };
    http.post.mockResolvedValue({ data: {
      frames, compared: 250, complete: true, reason: null, width: 640, height: 360, max_value: 255,
      regions: [{ x: 100, y: 50, w: 64, h: 64, value: 60 / 255, diff: 1, frame: 40, start: 38, end: 42 }],
    } });
    const { container } = viewer({ output_ref: output('ref') });
    const video = screen.getByLabelText('New video');
    load(video);
    load(screen.getByLabelText('Reference video'));
    fireEvent.click(screen.getByRole('button', { name: 'Differences' }));
    expect(await screen.findByText(/Differ in 1 of 250 frames · most at frame 40 \(Δ 60, PSNR 31.5 dB\)/)).toBeInTheDocument();
    expect(http.post).toHaveBeenCalledWith('/api/v1/output/video/diff', expect.objectContaining({ path: 'video.mp4', output_dir_url_ref: '/s/outputs/ref' }), expect.anything());
    expect(container.querySelector('.video-difference-strip')).not.toBeNull();
    // the regions, over the whole video: picking one shows its frame
    fireEvent.click(screen.getByRole('button', { name: 'Regions of interest' }));
    fireEvent.click(screen.getByText('Differences, whole video'));
    expect((await screen.findAllByText('#1 · Δ 24% · frames 38–42'))[0]).toBeInTheDocument();
    expect(video.currentTime).toBeCloseTo(40.5 / 25);
    expect(container.querySelector('.video-region-outline')).not.toBeNull();
    // n goes to the next frame where they differ most
    act(() => { video.currentTime = 0; });
    screen.getByRole('application').focus();
    fireEvent.keyDown(document.activeElement, { key: 'n' });
    expect(video.currentTime).toBeCloseTo(40.5 / 25);
  });

  it('says to sign in to read and compare the decoded frames', async () => {
    viewer({ output_ref: output('ref') }, { user: { is_logged: false, user_id: null, user_name: null, full_name: null, email: null } });
    // the server only reads the videos for signed-in users: we don't ask
    expect(http.get).not.toHaveBeenCalled();
    expect(screen.getByText(/Sign in \(in the sidebar\) to read the decoded values/)).toBeInTheDocument();
    const differences = screen.getByRole('button', { name: 'Differences' });
    expect(differences).toBeDisabled();
    expect(differences).toHaveAttribute('title', expect.stringMatching(/^Sign in/));
    fireEvent.click(screen.getByRole('button', { name: 'Pixel values' }));
    expect(screen.getByRole('radio', { name: /Decoded values/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: "What's in the files" }));
    expect(screen.getByText(/Sign in \(in the sidebar\) to see what's in the files/)).toBeInTheDocument();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('says when the server can\'t compare the videos', async () => {
    http.post.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: 'The videos have different sizes: 640x360 and 320x180' } } }));
    viewer({ output_ref: output('ref') });
    fireEvent.click(screen.getByRole('button', { name: 'Differences' }));
    expect(await screen.findByTitle('The videos have different sizes: 640x360 and 320x180')).toBeInTheDocument();
  });
});

describe('differencePeaks', () => {
  it('finds the first frame of each run above half of the largest difference', () => {
    const frames = [0, 0.1, 0.6, 0.8, 0.2, 0, 1, 0.9, 0].map(value => ({ value }));
    expect(differencePeaks(frames)).toEqual([2, 6]);
    expect(differencePeaks(frames.map(() => ({ value: 0 })))).toEqual([]);
    expect(differencePeaks(undefined)).toEqual([]);
  });
});

describe('frameStatus', () => {
  const names = { new: 'new', reference: 'reference' };
  const paused = { ready: true, playing: false, settled: true, frame: 12 };
  it('says whether the frames shown are exact', () => {
    expect(frameStatus({ ...paused, playing: true }, true, names).kind).toBe('playing');
    expect(frameStatus({ ...paused, presented: { index: 12, exact: true, mediaTime: 0.48 }, presentedReference: { index: 12, exact: true, mediaTime: 0.48 } }, true, names))
      .toMatchObject({ kind: 'exact', text: 'Frame 12 · both' });
    expect(frameStatus({ ...paused, presented: { index: 12, exact: false, mediaTime: 0.48 }, presentedReference: { index: 12, exact: false, mediaTime: 0.48 } }, true, names))
      .toMatchObject({ kind: 'estimated', text: 'Frame 12?' });
    expect(frameStatus({ ...paused, presented: { index: 12, exact: true, mediaTime: 0.48 }, presentedReference: { index: 6, exact: true, mediaTime: 0.48 } }, true, names))
      .toMatchObject({ kind: 'mismatch', text: 'new 12 · reference 6' });
    expect(frameStatus({ ...paused, presented: null }, false, names).kind).toBe('unknown');
  });
});
