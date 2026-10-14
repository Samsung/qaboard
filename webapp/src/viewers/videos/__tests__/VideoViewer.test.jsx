/**
 * The video viewer, with jsdom's <video> elements made to look loaded. Real playback is tested in e2e/videos.spec.js.
 * Run with: cd webapp && npm test -- VideoViewer
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { setupIntersectionMocking, resetIntersectionMocking } from 'react-intersection-observer/test-utils';

import VideoViewer from '../VideoViewer';

const output = id => ({ id, output_dir_url: `/s/outputs/${id}` });
const manifest = md5 => ({ 'video.mp4': { md5 } });

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

const viewer = props => render(<VideoViewer
  output_new={output('new')}
  path="video.mp4"
  manifests={{ new: manifest('a'), reference: manifest('b') }}
  {...props}
/>);

beforeEach(() => {
  localStorage.clear();
  setupIntersectionMocking(vi.fn);
});
afterEach(() => resetIntersectionMocking());

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
    viewer({ output_ref: output('ref') });
    const video_new = screen.getByLabelText('New video');
    const video_ref = screen.getByLabelText('Reference video');
    expect(video_ref).toHaveAttribute('src', '/s/outputs/ref/video.mp4');
    load(video_new);
    load(video_ref);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(video_new.play).toHaveBeenCalled();
    expect(video_ref.play).toHaveBeenCalled();
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('reference')).toBeInTheDocument();
  });

  it('shows one video when the reference is the same file', () => {
    viewer({ output_ref: output('ref'), manifests: { new: manifest('a'), reference: manifest('a') } });
    expect(screen.queryByLabelText('Reference video')).toBeNull();
    expect(screen.getByText('same video as the reference')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('switches comparison modes, and remembers the choice', () => {
    const { container, unmount } = viewer({ output_ref: output('ref') });
    expect(container.querySelector('.video-wipe')).toBeNull();
    fireEvent.click(screen.getByText('Wipe'));
    expect(container.querySelector('.video-wipe')).not.toBeNull();
    unmount();
    const again = viewer({ output_ref: output('ref') });
    expect(again.container.querySelector('.video-wipe')).not.toBeNull();
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
    fireEvent.keyDown(window, { key: '2' });
    expect(container.querySelector('.video-wipe')).toBeNull();
    fireEvent.pointerEnter(container.querySelector('.video-viewer'));
    fireEvent.keyDown(window, { key: '2' });
    expect(container.querySelector('.video-wipe')).not.toBeNull();
    // t swaps the sides
    const labels = () => [...container.querySelectorAll('.video-label')].map(label => `${label.textContent}@${label.classList.contains('left') ? 'left' : 'right'}`);
    expect(labels()).toEqual(['new640×360@left', 'reference640×360@right']);
    fireEvent.keyDown(window, { key: 't' });
    expect(labels()).toEqual(['reference640×360@left', 'new640×360@right']);
    fireEvent.keyDown(window, { key: ' ' });
    expect(video_new.play).toHaveBeenCalled();
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
    expect(screen.queryByText('Difference')).toBeNull();
  });

  it('encodes file names', () => {
    viewer({ path: 'dir/clip #1.mp4' });
    expect(screen.getByLabelText('New video')).toHaveAttribute('src', '/s/outputs/new/dir/clip%20%231.mp4');
  });
});
