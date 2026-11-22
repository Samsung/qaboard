// The audio viewer, with WAVs it decodes itself: jsdom has no Web Audio (nor canvas).
// Run with: cd webapp && npm test -- --run src/viewers/audio
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { AudioViewer, CompactAudioViewer } from '../AudioViewer';
import { encodeWav } from '../wav';

const sine = (seconds, rate, amplitude) => Float32Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * i / rate));
const files = {
  '/new.wav': encodeWav([sine(2, 8000, 0.5), sine(2, 8000, 0.5)], 8000),
  '/ref.wav': encodeWav([sine(3, 8000, 1)], 16000),
  '/same.wav': encodeWav([sine(2, 8000, 0.5), sine(2, 8000, 0.5)], 8000),
  '/quiet.wav': encodeWav([sine(2, 8000, 0.25), sine(2, 8000, 0.25)], 8000),
  '/song.mp3': new TextEncoder().encode('ID3 not really an mp3').buffer,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => files[url]
    ? { ok: true, arrayBuffer: async () => files[url].slice(0) }
    : { ok: false, status: 404, statusText: 'NOT FOUND' }));
});
afterEach(() => vi.unstubAllGlobals());

const labels = { new: 'my-branch', reference: 'main' };

describe('the audio viewer', () => {
  it('shows the file and its reference, with their metadata, without moving while it decodes', async () => {
    const { container } = render(<AudioViewer src="/new.wav" src_ref="/ref.wav" labels={labels} caption="step 10"/>);
    // the tracks' places are kept while they decode
    expect(container.querySelectorAll('.qa-audio-lane')).toHaveLength(2);
    expect(screen.getAllByText('decoding…')).toHaveLength(2);
    expect(await screen.findByText(/8 kHz · stereo/)).toBeInTheDocument();
    expect(screen.getByText('my-branch')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('step 10')).toBeInTheDocument();
    // a sine at 0.5: peak -6 dBFS, RMS -9 dBFS
    expect(screen.getByText(/8 kHz · stereo · 0:02\.000 · peak -6\.0 dBFS · RMS -9\.0 dBFS · -\d+\.\d LUFS/)).toBeInTheDocument();
    expect(screen.getByText(/16 kHz · mono · 0:01\.500 · peak 0\.0 dBFS/)).toBeInTheDocument();
    expect(screen.getByText(/clipped/)).toBeInTheDocument();
    // the shared axis is as long as the longest
    expect(screen.getByRole('slider', { name: 'Position' })).toHaveAttribute('aria-valuetext', '0:00.000 of 0:02.000');
    expect(screen.getByRole('button', { name: 'Play my-branch' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'B · main' })).toBeInTheDocument();
    // different rates: no difference, and it says why
    expect(screen.getByLabelText('Difference')).toBeDisabled();
  });

  it('matches loudness by default, and says by how much', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/quiet.wav" labels={labels}/>);
    // 6 dB louder: played 6 dB quieter
    expect(await screen.findByText('−6.0 dB to match')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Match loudness'));
    expect(screen.queryByText('−6.0 dB to match')).not.toBeInTheDocument();
  });

  it('switches what is heard, and seeks, with the keyboard', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/ref.wav" labels={labels}/>);
    await screen.findByText(/16 kHz/);
    const position = screen.getByRole('slider', { name: 'Position' });
    expect(screen.getByRole('radio', { name: 'A · my-branch' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(position, { key: 'b' });
    expect(screen.getByRole('radio', { name: 'B · main' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(position, { key: 'ArrowRight' });
    expect(position).toHaveAttribute('aria-valuetext', '0:01.000 of 0:02.000');
    fireEvent.keyDown(position, { key: 'ArrowRight', shiftKey: true });
    expect(position).toHaveAttribute('aria-valuetext', '0:02.000 of 0:02.000');
    fireEvent.keyDown(position, { key: '0' });
    expect(position).toHaveAttribute('aria-valuetext', '0:00.000 of 0:02.000');
    fireEvent.keyDown(position, { key: '?' });
    expect(within(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).getByText('Match loudness')).toBeInTheDocument();
    fireEvent.keyDown(position, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('zooms in and out', async () => {
    render(<AudioViewer src="/new.wav" labels={labels}/>);
    await screen.findByText(/8 kHz/);
    // around the playhead
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('0:00.000–0:01.000')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Position' }), { key: '+' });
    expect(screen.getByText('0:00.000–0:00.500')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(screen.queryByText(/–0:00.500/)).not.toBeInTheDocument();
  });

  it('shows the difference of tracks at the same rate', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/same.wav" labels={labels}/>);
    await screen.findAllByText(/8 kHz/);
    await act(async () => fireEvent.click(screen.getByLabelText('Difference')));
    // computed off the render, and it says so meanwhile
    expect(screen.getByText('computing the difference…')).toBeInTheDocument();
    expect(await screen.findByText('identical samples')).toBeInTheDocument();
    expect(screen.queryByText('computing the difference…')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Δ · Difference' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Spectrogram' }));
    expect(screen.getByText(/louder in my-branch/)).toBeInTheDocument();
  });

  it('shows the file alone without a reference, or when it is missing', async () => {
    const { unmount } = render(<AudioViewer src="/new.wav" labels={labels}/>);
    expect(await screen.findByText(/8 kHz/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^A/ })).not.toBeInTheDocument();
    unmount();
    render(<AudioViewer src="/new.wav" src_ref="/missing.wav" labels={labels}/>);
    expect(await screen.findByText(/Could not load main: 404 NOT FOUND/)).toBeInTheDocument();
    expect(screen.getByText(/8 kHz/)).toBeInTheDocument();
  });

  it("falls back to the browser's player when it can't decode", async () => {
    const onError = vi.fn();
    const { container } = render(<AudioViewer src="/song.mp3" src_ref="/ref.wav" labels={labels} onError={onError}/>);
    expect(await screen.findByText(/This browser can't decode the file/)).toBeInTheDocument();
    expect(container.querySelectorAll('audio[controls]')).toHaveLength(2);
    expect(screen.getByLabelText('Play my-branch')).toHaveAttribute('src', '/song.mp3');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('the compact audio viewer', () => {
  it('is a row with play and A/B, that expands into the full viewer', async () => {
    render(<CompactAudioViewer src="/new.wav" src_ref="/quiet.wav" labels={labels} caption="sample 3" onExpand={() => {}}/>);
    expect(screen.getByText('sample 3')).toBeInTheDocument();
    expect(await screen.findByText('0:02.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hear my-branch' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hear main' }));
    expect(screen.getByRole('button', { name: 'Hear main' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('expands in place with AudioViewer compact', async () => {
    render(<AudioViewer compact src="/new.wav" labels={labels}/>);
    await screen.findByText('0:02.0');
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(await screen.findByText(/8 kHz · stereo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });
});
