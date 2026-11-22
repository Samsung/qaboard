// The audio viewer, with WAVs it decodes itself: jsdom has no Web Audio (nor canvas).
// Run with: cd webapp && npm test -- --run src/viewers/audio
import { act, fireEvent, render, screen } from '@testing-library/react';

import { AudioViewer } from '../AudioViewer';
import { encodeWav } from '../wav';

const sine = (seconds, rate, amplitude) => Float32Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * i / rate));
const files = {
  '/new.wav': encodeWav([sine(2, 8000, 0.5), sine(2, 8000, 0.5)], 8000),
  '/ref.wav': encodeWav([sine(3, 8000, 1)], 16000),
  '/same.wav': encodeWav([sine(2, 8000, 0.5), sine(2, 8000, 0.5)], 8000),
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
  it('shows the file and its reference, with their metadata', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/ref.wav" labels={labels} caption="step 10"/>);
    expect(screen.getByLabelText('Loading the audio')).toBeInTheDocument();
    expect(await screen.findByText('my-branch')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('step 10')).toBeInTheDocument();
    // a sine at 0.5: peak -6 dBFS, RMS -9 dBFS
    expect(screen.getByText(/8 kHz · stereo · 0:02\.000 · peak -6\.0 dBFS · RMS -9\.0 dBFS/)).toBeInTheDocument();
    expect(screen.getByText(/16 kHz · mono · 0:01\.500 · peak 0\.0 dBFS/)).toBeInTheDocument();
    expect(screen.getByText(/clipped samples/)).toBeInTheDocument();
    // the shared axis is as long as the longest
    expect(screen.getByText('0:00.000 / 0:02.000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play my-branch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play main' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'B: main' })).toBeInTheDocument();
    // different rates: no sample-by-sample difference
    expect(screen.queryByLabelText('Difference')).not.toBeInTheDocument();
  });

  it('switches what is heard, and seeks, with the keyboard', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/ref.wav" labels={labels}/>);
    await screen.findByText('main');
    const player = screen.getByRole('slider', { name: 'Position' });
    expect(screen.getByRole('radio', { name: 'A: my-branch' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(player, { key: 'x' });
    expect(screen.getByRole('radio', { name: 'B: main' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(player, { key: 'ArrowRight' });
    expect(screen.getByText('0:01.000 / 0:02.000')).toBeInTheDocument();
    fireEvent.keyDown(player, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('0:02.000 / 0:02.000')).toBeInTheDocument();
    fireEvent.keyDown(player, { key: 'Home' });
    expect(screen.getByText('0:00.000 / 0:02.000')).toBeInTheDocument();
  });

  it('shows the difference of tracks at the same rate', async () => {
    render(<AudioViewer src="/new.wav" src_ref="/same.wav" labels={labels}/>);
    await screen.findByText('main');
    await act(async () => fireEvent.click(screen.getByLabelText('Difference')));
    expect(screen.getByText('identical samples')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Δ: Difference' })).toBeInTheDocument();
  });

  it('shows the file alone without a reference, or when it is missing', async () => {
    const { unmount } = render(<AudioViewer src="/new.wav" labels={labels}/>);
    expect(await screen.findByText('my-branch')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^A:/ })).not.toBeInTheDocument();
    unmount();
    render(<AudioViewer src="/new.wav" src_ref="/missing.wav" labels={labels}/>);
    expect(await screen.findByText(/Could not load the reference \(404 NOT FOUND\)/)).toBeInTheDocument();
    expect(screen.getByText('my-branch')).toBeInTheDocument();
  });

  it("falls back to the browser's player when it can't decode", async () => {
    const onError = vi.fn();
    const { container } = render(<AudioViewer src="/song.mp3" src_ref="/ref.wav" labels={labels} onError={onError}/>);
    expect(await screen.findByText(/Could not read the audio \(this browser can't decode audio\)/)).toBeInTheDocument();
    expect(container.querySelectorAll('audio[controls]')).toHaveLength(2);
    expect(screen.getByLabelText('Play my-branch')).toHaveAttribute('src', '/song.mp3');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
