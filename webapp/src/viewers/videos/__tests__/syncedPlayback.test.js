import { SyncedPlayback, snapFps, frameAt, timeOfFrame } from '../syncedPlayback';
import { FakeVideo } from './fakeVideo';

const setup = (options = {}, followerOptions = options) => {
  const leader = new FakeVideo(options);
  const follower = new FakeVideo(followerOptions);
  const playback = new SyncedPlayback();
  playback.attach(leader, follower);
  return { leader, follower, playback };
};

// both play, in small steps
const playBoth = (leader, follower, seconds) => {
  for (let t = 0; t < seconds - 1e-9; t += 0.01) {
    follower.advance(0.01);
    leader.advance(0.01);
  }
};

describe('frame math', () => {
  test('rounds measured frame rates to common ones', () => {
    expect(snapFps(1 / 0.033)).toBe(30);       // webm timestamps are in ms
    expect(snapFps(1 / 0.0334)).toBe(30000 / 1001);
    expect(snapFps(25.2)).toBe(25);
    expect(snapFps(1 / 0.04)).toBe(25);
    expect(snapFps(37)).toBe(37);
  });

  test('frames and their times', () => {
    expect(frameAt(0, 0.04)).toBe(0);
    expect(frameAt(0.04, 0.04)).toBe(1);        // exact frame starts, despite floating point
    expect(frameAt(3 * 0.1, 0.1)).toBe(3);
    expect(frameAt(0.079, 0.04)).toBe(1);
    expect(timeOfFrame(2, 0.04)).toBeCloseTo(0.1);
    expect(frameAt(timeOfFrame(1234, 1 / 30), 1 / 30)).toBe(1234);
  });
});

describe('SyncedPlayback', () => {
  test('plays and pauses both videos', async () => {
    const { leader, follower, playback } = setup();
    playback.play();
    expect(leader.paused).toBe(false);
    expect(follower.paused).toBe(false);
    expect(playback.getSnapshot().playing).toBe(true);
    playback.pause();
    expect(leader.paused).toBe(true);
    expect(follower.paused).toBe(true);
    expect(playback.getSnapshot().playing).toBe(false);
  });

  test('works without a reference video', () => {
    const leader = new FakeVideo();
    const playback = new SyncedPlayback();
    playback.attach(leader, null);
    playback.play();
    expect(leader.paused).toBe(false);
    playback.pause();
    playback.toggle();
    expect(leader.paused).toBe(false);
  });

  test('when paused, both show the same frame', () => {
    const { leader, follower, playback } = setup();
    playback.play();
    playBoth(leader, follower, 1.01);
    playback.pause();
    leader.finishSeek();
    follower.finishSeek();
    expect(follower.currentTime).toBe(leader.currentTime);
    // 25 fps measured while playing: we're in the middle of the frame
    expect(leader.currentTime).toBeCloseTo(timeOfFrame(25, 0.04));
    expect(playback.getSnapshot().frame).toBe(25);
    expect(playback.getSnapshot().drift).toBe(0);
  });

  test('measures the frame rate while playing', () => {
    const { leader, playback } = setup({ fps: 30 });
    expect(playback.getSnapshot().frameDuration).toBe(null);
    playback.play();
    leader.advance(0.2);
    expect(playback.getSnapshot().frameDuration).toBeCloseTo(1 / 30);
    expect(playback.getSnapshot().fpsSource).toBe('measured');
  });

  test('the configured frame rate wins', () => {
    const { leader, playback } = setup({ fps: 30 });
    playback.setFps(25);
    playback.play();
    leader.advance(0.2);
    expect(playback.getSnapshot().frameDuration).toBe(1 / 25);
    expect(playback.getSnapshot().fpsSource).toBe('config');
  });

  test('coalesces seeks: only the latest target is kept while seeking', () => {
    const { leader, follower, playback } = setup();
    playback.setFps(25);
    playback.seek(1);
    playback.seek(2);
    playback.seek(3);
    expect(leader.currentTime).toBeCloseTo(1.02);
    expect(playback.getSnapshot().time).toBeCloseTo(3.02);
    leader.finishSeek();
    follower.finishSeek();
    expect(leader.currentTime).toBeCloseTo(3.02);
    expect(follower.currentTime).toBeCloseTo(3.02);
    leader.finishSeek();
    follower.finishSeek();
    expect(playback.getSnapshot().time).toBeCloseTo(3.02);
  });

  test('steps frames, also faster than seeks complete', async () => {
    const { leader, follower, playback } = setup();
    playback.setFps(25);
    await playback.stepFrames(1);
    await playback.stepFrames(1);
    await playback.stepFrames(1);
    leader.finishSeek();
    follower.finishSeek();
    leader.finishSeek();
    expect(playback.getSnapshot().frame).toBe(3);
    await playback.stepFrames(-1);
    leader.finishSeek();
    expect(playback.getSnapshot().frame).toBe(2);
    expect(leader.currentTime).toBeCloseTo(timeOfFrame(2, 0.04));
  });

  test('learns the frame duration to step frames when it is unknown', async () => {
    const { leader, playback } = setup({ fps: 24, autoSeek: true });
    leader.present();  // the first frame shows when the video loads
    await playback.stepFrames(1);
    expect(playback.getSnapshot().frameDuration).toBeCloseTo(1 / 24);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(playback.getSnapshot().frame).toBe(1);
    expect(leader.frameTime()).toBeCloseTo(1 / 24);
  });

  test('without requestVideoFrameCallback, assumes 30 fps', async () => {
    const { leader, playback } = setup({ rvfc: false, autoSeek: true });
    await playback.stepFrames(2);
    expect(leader.currentTime).toBeCloseTo(timeOfFrame(2, 1 / 30));
  });

  test('nudges the reference when it drifts, and jumps when far off', () => {
    const { leader, follower, playback } = setup();
    playback.play();
    leader.advance(0.2);
    follower._time = leader.currentTime + 0.1;  // ahead
    leader.advance(0.04);
    expect(follower.playbackRate).toBeLessThan(1);
    follower._time = leader.currentTime - 0.1;  // behind
    leader.advance(0.04);
    expect(follower.playbackRate).toBeGreaterThan(1);
    follower._time = leader.currentTime + 0.04;
    leader.advance(0.04);
    expect(follower.playbackRate).toBe(1);
    follower._time = leader.currentTime + 3;
    leader.advance(0.04);
    expect(follower.seeking).toBe(true);
    expect(follower.currentTime).toBeCloseTo(leader.currentTime);
  });

  test('applies the speed to both videos', () => {
    const { leader, follower, playback } = setup();
    playback.setRate(0.25);
    playback.play();
    expect(leader.playbackRate).toBe(0.25);
    expect(follower.playbackRate).toBe(0.25);
  });

  test('when a video buffers, the other one waits', () => {
    const { leader, follower, playback } = setup();
    playback.play();
    follower.readyState = 2;
    follower.emit('waiting');
    expect(leader.paused).toBe(true);
    expect(playback.getSnapshot().buffering).toBe(true);
    expect(playback.getSnapshot().playing).toBe(true);
    follower.readyState = 4;
    follower.emit('canplay');
    expect(leader.paused).toBe(false);
    expect(playback.getSnapshot().buffering).toBe(false);
  });

  test('follows pauses and plays from elsewhere (context menu, media keys)', () => {
    const { leader, follower, playback } = setup();
    playback.play();
    follower.pause();
    expect(leader.paused).toBe(true);
    expect(playback.getSnapshot().playing).toBe(false);
    leader.play();
    expect(follower.paused).toBe(false);
    expect(playback.getSnapshot().playing).toBe(true);
  });

  test('loops both videos', () => {
    const { leader, follower, playback } = setup({ duration: 1 });
    playback.play();
    playBoth(leader, follower, 1.1);
    leader.finishSeek();
    follower.finishSeek();
    expect(playback.getSnapshot().frame).toBe(0);
    expect(follower.currentTime).toBe(leader.currentTime);
    expect(leader.paused).toBe(false);
    expect(follower.paused).toBe(false);
  });

  test('stops at the end without loop', () => {
    const { leader, follower, playback } = setup({ duration: 1 });
    playback.setLoop(false);
    playback.play();
    follower.advance(0.5);
    leader.advance(1.1);
    expect(playback.getSnapshot().playing).toBe(false);
    expect(follower.paused).toBe(true);
    // play again from the start
    playback.play();
    expect(playback.getSnapshot().frame).toBe(0);
    expect(leader.paused).toBe(false);
  });

  test('a shorter reference stays on its last frame', () => {
    const { leader, follower, playback } = setup({ duration: 2 }, { duration: 1 });
    playback.play();
    follower.advance(1.1);
    expect(follower.ended).toBe(true);
    expect(playback.getSnapshot().playing).toBe(true);
    leader.advance(1.5);
    expect(leader.paused).toBe(false);
    expect(follower.paused).toBe(true);
    playback.seek(1.5);
    expect(follower.currentTime).toBeLessThan(1);
  });

  test('the reference plays alone when the new video fails', () => {
    const { leader, follower, playback } = setup();
    leader.error = { code: 4 };
    leader.emit('error');
    playback.play();
    expect(follower.paused).toBe(false);
    expect(playback.getSnapshot().ready).toBe(true);
  });

  test('keeps the position when the videos change', () => {
    const { leader, follower, playback } = setup();
    playback.seek(3);
    leader.finishSeek();
    follower.finishSeek();
    const leader2 = new FakeVideo({ readyState: 0 });
    playback.attach(leader2, follower);
    expect(playback.getSnapshot().time).toBe(3);
    leader2.readyState = 4;
    leader2.emit('loadedmetadata');
    expect(leader2.currentTime).toBe(3);
  });

  test('a reference that loads later joins at the current time', () => {
    const leader = new FakeVideo();
    const playback = new SyncedPlayback();
    playback.attach(leader, null);
    playback.seek(2);
    leader.finishSeek();
    const follower = new FakeVideo({ readyState: 0 });
    playback.attach(leader, follower);
    follower.readyState = 4;
    follower.emit('loadedmetadata');
    expect(follower.currentTime).toBe(2);
  });

  test('play() rejections are handled', async () => {
    const { leader, playback } = setup();
    leader.play = () => Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    playback.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.getSnapshot().playing).toBe(false);
    expect(playback.getSnapshot().error).toBe('not allowed');
    leader.play = () => Promise.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }));
    playback.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(playback.getSnapshot().playing).toBe(true);
  });

  test('detaching removes all listeners', () => {
    const { leader, follower, playback } = setup();
    playback.detach();
    leader.play();
    expect(follower.paused).toBe(true);
    expect(leader.callbacks.size).toBe(0);
  });
});
