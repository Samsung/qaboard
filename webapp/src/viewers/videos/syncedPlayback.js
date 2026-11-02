// Plays two <video> elements as one, to compare them.
// The leader (the new run's video) drives the clock, the follower (the reference's) shows the same frame:
// - play, pause, seek and frame steps act on both. While a video seeks, only the latest target is kept,
//   so scrubbing stays responsive.
// - While playing, the follower's playbackRate is nudged to absorb drift. It jumps when it's far off.
// - When a video stalls (buffering), the other one waits for it.
// - Paused, both show the same frame: we seek them to the middle of the leader's frame.
// - Frames: from the timestamps of every frame when the server read them from the file (exact, also with variable
//   frame rates), else qaboard.yaml's `fps`, else measured on the frames the browser presents:
//   requestVideoFrameCallback gives their exact timestamps.
// - Which frame each video presents, from requestVideoFrameCallback: users see whether they compare the same frames.
// Media events are never trusted to come from us: the browser's context menu, media keys or picture-in-picture
// can play or pause one video, the other follows.

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
// stay that far from the end, else the video is "ended"
const EPSILON = 1e-3;
const DEFAULT_FRAME_DURATION = 1 / 30;

// 23.976, 29.97, 59.94... are 24000/1001, 30000/1001, 60000/1001
export const COMMON_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 90, 100, 120000 / 1001, 120, 144, 240];

// Timestamps are rounded (to the ms in webm), we round measured frame rates to the closest common one
export const snapFps = fps => {
  let best = fps;
  let error = 0.02;
  for (const common of COMMON_FPS) {
    const e = Math.abs(common - fps) / common;
    if (e < error) {
      best = common;
      error = e;
    }
  }
  return best;
};

export const frameAt = (time, frameDuration) => Math.max(0, Math.floor(time / frameDuration + 1e-3));
// the middle of the frame is the safest place to seek to: timestamps are rounded, and videos encoded
// differently may not start their frames at exactly the same time
export const timeOfFrame = (frame, frameDuration) => (Math.max(0, frame) + 0.5) * frameDuration;

// With the timestamps of the frames (sorted, in seconds): the frame shown at `time`
export const frameAtTimes = (time, times) => {
  let low = 0;
  let high = times.length - 1;
  if (high < 0 || time < times[0] - 1e-4) return 0;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle] <= time + 1e-4) low = middle;
    else high = middle - 1;
  }
  return low;
};
// the middle of the frame, the last lasts as long as the one before
export const timeOfFrameTimes = (frame, times) => {
  const i = Math.max(0, Math.min(frame, times.length - 1));
  const next = times[i + 1] ?? times[i] + (times.length > 1 ? times[i] - times[i - 1] : DEFAULT_FRAME_DURATION);
  return (times[i] + next) / 2;
};
// The frame whose timestamp is `mediaTime` (what requestVideoFrameCallback says is presented), or null if none is
// within a quarter of a frame: then we don't know which frame it is
export const frameOfTimestamp = (mediaTime, times) => {
  const i = frameAtTimes(mediaTime, times);
  const candidates = [i, i + 1].filter(j => j < times.length);
  const best = candidates.sort((a, b) => Math.abs(times[a] - mediaTime) - Math.abs(times[b] - mediaTime))[0];
  if (best === undefined) return null;
  const duration = (times[Math.min(best + 1, times.length - 1)] - times[Math.max(best - 1, 0)]) / 2 || DEFAULT_FRAME_DURATION;
  return Math.abs(times[best] - mediaTime) <= duration / 4 ? best : null;
};

const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

const rangesOf = buffered => {
  const ranges = [];
  for (let i = 0; i < (buffered?.length ?? 0); i++) ranges.push([buffered.start(i), buffered.end(i)]);
  return ranges;
};

const sameFrame = (a, b) => a === b || (!!a && !!b && a.index === b.index && a.exact === b.exact && a.mediaTime === b.mediaTime);
const sameSnapshot = (a, b) => Object.keys(a).every(key =>
  key === 'buffered' ? a.buffered.join() === b.buffered.join()
  : key === 'presented' || key === 'presentedReference' ? sameFrame(a[key], b[key])
  : Object.is(a[key], b[key])
);


export class SyncedPlayback {
  constructor({ fps } = {}) {
    this.leader = null;
    this.follower = null;
    this.configuredFrameDuration = fps > 0 ? 1 / fps : null;
    this.measuredFrameDuration = null;
    // element => the timestamps of its frames, from the file
    this.frameTimes = new Map();
    this.frameDeltas = [];
    // what the user asked for: the videos may be waiting for data
    this.playing = false;
    this.played = false;
    this.buffering = false;
    this.rate = 1;
    this.loop = true;
    this.muted = true;
    this.error = null;
    // the time we are seeking to, while the leader seeks
    this.target = null;
    // element => the time to seek to once its current seek is done
    this.pending = new Map();
    // element => the last frame it presented {mediaTime, presentedFrames, seeks}
    this.presented = new Map();
    this.seeks = 0;
    this.resumeAt = 0;
    this.learning = null;
    this.frameWaiters = [];
    this.cleanups = [];
    this.listeners = new Set();
    this.frameListeners = new Set();
    this.snapshot = this.makeSnapshot();
  }

  // useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  // called when either video shows a new frame, or finished seeking: to draw them (e.g. their difference)
  onFrames(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  get elements() {
    return [this.leader, this.follower].filter(Boolean);
  }

  get frameDuration() {
    return this.configuredFrameDuration ?? this.fileFrameDuration ?? this.measuredFrameDuration;
  }

  // the leader's frames, as the file has them
  get times() {
    return this.leader ? this.frameTimes.get(this.leader) ?? null : null;
  }

  get fileFrameDuration() {
    const times = this.times;
    if (!times || times.length < 2) return null;
    return (times[times.length - 1] - times[0]) / (times.length - 1);
  }

  frameAt(time) {
    const times = this.times;
    if (times?.length) return frameAtTimes(time, times);
    return this.frameDuration ? frameAt(time, this.frameDuration) : null;
  }

  timeOfFrame(frame) {
    const times = this.times;
    if (times?.length) return timeOfFrameTimes(frame, times);
    return timeOfFrame(frame, this.frameDuration ?? DEFAULT_FRAME_DURATION);
  }

  // The frame the element presents: { index, exact }, exact when we know it from the file's timestamps
  presentedFrame(element) {
    const presented = element && this.presented.get(element);
    if (!presented) return null;
    const times = this.frameTimes.get(element);
    if (times?.length) {
      const index = frameOfTimestamp(presented.mediaTime, times);
      if (index !== null) return { index, exact: true, mediaTime: presented.mediaTime };
    }
    const duration = this.configuredFrameDuration ?? this.measuredFrameDuration;
    if (!duration) return null;
    return { index: frameAt(presented.mediaTime, duration), exact: false, mediaTime: presented.mediaTime };
  }

  // The timestamps of the frames of a video (the file's, in seconds), or null when we don't know them
  setFrameTimes(element, times) {
    if (!element) return;
    if (times?.length) this.frameTimes.set(element, times);
    else this.frameTimes.delete(element);
    this.emit();
  }

  get time() {
    if (this.target !== null) return this.target;
    return this.usable(this.leader) ? this.leader.currentTime : this.resumeAt;
  }

  setFps(fps) {
    this.configuredFrameDuration = fps > 0 ? 1 / fps : null;
    this.emit();
  }

  attach(leader, follower = null) {
    if (leader === this.leader && follower === this.follower) return;
    const sameLeader = leader === this.leader;
    this.detach();
    if (!sameLeader) {
      this.measuredFrameDuration = null;
      this.frameDeltas = [];
    }
    this.leader = leader ?? null;
    this.follower = leader ? follower ?? null : null;
    this.error = null;
    for (const element of this.elements) this.listen(element);
    if (this.leader) {
      // keep the position and the playback when the videos change, e.g. when the reference loads
      this.whenLoaded(this.leader, () => {
        if (Math.abs(this.leader.currentTime - this.resumeAt) > EPSILON) this.seek(this.resumeAt);
        else this.alignFollower();
        if (this.playing) this.play();
      });
    }
    if (this.follower) this.whenLoaded(this.follower, () => this.alignFollower());
    this.emit();
  }

  detach() {
    if (this.leader) this.resumeAt = this.time;
    this.cleanups.forEach(cleanup => cleanup());
    this.cleanups = [];
    this.pending.clear();
    this.presented.clear();
    this.target = null;
    this.buffering = false;
    this.frameWaiters.forEach(waiter => waiter.resolve(null));
    this.frameWaiters = [];
    this.leader = null;
    this.follower = null;
  }

  destroy() {
    this.detach();
    this.listeners.clear();
    this.frameListeners.clear();
  }

  whenLoaded(element, callback) {
    if (element.readyState >= HAVE_METADATA) {
      callback();
      return;
    }
    const onLoaded = () => callback();
    element.addEventListener('loadedmetadata', onLoaded, { once: true });
    this.cleanups.push(() => element.removeEventListener('loadedmetadata', onLoaded));
  }

  listen(element) {
    const on = (type, handler) => {
      element.addEventListener(type, handler);
      this.cleanups.push(() => element.removeEventListener(type, handler));
    };
    element.loop = false;
    element.muted = element === this.follower || this.muted;
    element.playbackRate = this.rate;
    on('seeked', () => this.onSeeked(element));
    on('waiting', () => this.onWaiting(element));
    for (const type of ['canplay', 'canplaythrough', 'playing']) on(type, () => this.onCanPlay());
    on('play', () => this.onPlayEvent());
    on('pause', () => this.onPauseEvent(element));
    on('ended', () => this.onEnded(element));
    on('error', () => this.onError(element));
    for (const type of ['loadedmetadata', 'loadeddata', 'durationchange', 'progress', 'timeupdate']) on(type, () => this.emit());
    // the first frame to draw
    on('loadeddata', () => this.frameListeners.forEach(listener => listener(element)));
    this.watchFrames(element);
  }

  watchFrames(element) {
    if (typeof element.requestVideoFrameCallback === 'function') {
      let handle;
      const onFrame = (now, metadata) => {
        handle = element.requestVideoFrameCallback(onFrame);
        this.onFrame(element, metadata);
      };
      handle = element.requestVideoFrameCallback(onFrame);
      this.cleanups.push(() => element.cancelVideoFrameCallback?.(handle));
    } else if (element === this.leader && typeof requestAnimationFrame === 'function') {
      // Firefox < 132: we poll while playing
      let handle;
      const tick = () => {
        handle = requestAnimationFrame(tick);
        if (this.playing) this.onFrame(element, null);
      };
      handle = requestAnimationFrame(tick);
      this.cleanups.push(() => cancelAnimationFrame(handle));
    }
  }

  onFrame(element, metadata) {
    const previous = this.presented.get(element);
    const frame = {
      mediaTime: metadata?.mediaTime ?? element.currentTime,
      presentedFrames: metadata?.presentedFrames,
      seeks: this.seeks,
    };
    this.presented.set(element, frame);
    if (element === this.leader) {
      // while playing, consecutive frames are one frame apart (or more, when frames are dropped)
      const consecutive = metadata && previous && previous.seeks === frame.seeks && frame.presentedFrames - previous.presentedFrames === 1;
      if (consecutive && this.playing && !this.buffering) this.measure(frame.mediaTime - previous.mediaTime);
      if (this.playing && !this.buffering) this.correctDrift();
      const waiters = this.frameWaiters;
      this.frameWaiters = [];
      waiters.forEach(waiter => waiter.resolve(frame.mediaTime));
    }
    // which frames show changed
    this.emit();
    this.frameListeners.forEach(listener => listener(element));
  }

  // Frame durations are multiples of the actual one: we average those close to the shortest
  measure(delta) {
    if (!(delta > 1e-4 && delta < 1)) return;
    this.frameDeltas.push(delta);
    if (this.frameDeltas.length > 120) this.frameDeltas.shift();
    const shortest = Math.min(...this.frameDeltas);
    const adjacent = this.frameDeltas.filter(d => d < 1.5 * shortest);
    const mean = adjacent.reduce((sum, d) => sum + d, 0) / adjacent.length;
    this.measuredFrameDuration = 1 / snapFps(1 / mean);
  }

  usable(element) {
    return !!element && !element.error && element.readyState >= HAVE_METADATA;
  }

  // the reference may be shorter
  followerCovers(time) {
    return !!this.follower && time < this.follower.duration - EPSILON;
  }

  correctDrift() {
    const { leader, follower } = this;
    if (!this.usable(follower) || follower.seeking || follower.ended || this.pending.has(follower)) return;
    const time = leader.currentTime;
    if (!this.followerCovers(time)) return;
    if (follower.paused) {
      this.safePlay(follower);
      return;
    }
    const frame = this.frameDuration ?? DEFAULT_FRAME_DURATION;
    const drift = follower.currentTime - time;
    let rate = this.rate;
    if (Math.abs(drift) > Math.max(0.5, 10 * frame) * this.rate) {
      this.seekElement(follower, time);
    } else if (Math.abs(drift) > frame / 4) {
      // ahead: slow down, behind: speed up
      rate = this.rate * clamp(1 - 2 * drift, 0.5, 1.5);
    }
    if (Math.abs(follower.playbackRate - rate) > 1e-3) follower.playbackRate = rate;
  }

  safePlay(element) {
    let promise;
    try {
      promise = element.play();
    } catch (error) {
      this.onPlayError(element, error);
      return;
    }
    promise?.catch?.(error => this.onPlayError(element, error));
  }

  onPlayError(element, error) {
    // pause() while play() is pending rejects it: we did it on purpose
    if (error?.name === 'AbortError') return;
    if (element !== this.leader) return;
    this.error = error?.message ?? String(error);
    this.playing = false;
    this.follower?.pause();
    this.emit();
  }

  play() {
    const { leader } = this;
    this.playing = true;
    this.played = true;
    this.buffering = false;
    if (!this.usable(leader)) {
      // we'll start once it's loaded
      this.emit();
      return;
    }
    if (leader.ended || leader.currentTime >= leader.duration - EPSILON) this.seek(0);
    this.alignFollower();
    this.resume();
    this.emit();
  }

  resume() {
    for (const element of this.elements) {
      if (element.error) continue;
      if (element === this.follower && !this.followerCovers(this.time)) continue;
      element.playbackRate = this.rate;
      if (element.paused) this.safePlay(element);
    }
  }

  pause() {
    this.playing = false;
    this.buffering = false;
    for (const element of this.elements) {
      if (!element.paused) element.pause();
    }
    // both show the same frame
    if (this.usable(this.leader)) this.seek(this.time);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(time) {
    const { leader, follower } = this;
    if (!this.usable(leader)) {
      this.resumeAt = time;
      return;
    }
    const end = Number.isFinite(leader.duration) ? Math.max(0, leader.duration - EPSILON) : Infinity;
    let t = clamp(time, 0, end);
    if (this.times?.length || this.frameDuration) t = Math.min(this.timeOfFrame(this.frameAt(t)), end);
    this.seeks += 1;
    this.target = t;
    this.seekElement(leader, t);
    if (!leader.seeking && !this.pending.has(leader)) this.target = null;
    if (this.usable(follower)) this.seekElement(follower, Math.min(t, Math.max(0, follower.duration - EPSILON)));
    this.emit();
  }

  seekElement(element, time) {
    if (element.seeking) {
      this.pending.set(element, time);
      return;
    }
    // A seek can be done while its "seeked" event is still on its way: what was pending for it is outdated, else
    // that event would seek back to it
    this.pending.delete(element);
    if (Math.abs(element.currentTime - time) < 1e-6) return;
    element.currentTime = time;
  }

  onSeeked(element) {
    if (this.pending.has(element)) {
      const time = this.pending.get(element);
      this.pending.delete(element);
      if (Math.abs(element.currentTime - time) > 1e-6) {
        element.currentTime = time;
        return;
      }
    }
    if (element === this.leader) this.target = null;
    this.frameListeners.forEach(listener => listener(element));
    this.emit();
  }

  // Step through frames, paused
  async stepFrames(count) {
    if (!this.usable(this.leader)) return;
    if (this.playing) this.pause();
    const from = this.time;
    if (this.times?.length) {
      this.seekFrame(this.frameAt(from) + count);
      return;
    }
    const frame = this.frameDuration ?? await this.learnFrameDuration() ?? DEFAULT_FRAME_DURATION;
    if (!this.usable(this.leader)) return;
    this.seek(timeOfFrame(frameAt(from, frame) + count, frame));
  }

  // Show a frame, paused
  seekFrame(index) {
    if (this.playing) this.pause();
    const times = this.times;
    const last = times?.length ? times.length - 1 : Infinity;
    this.seek(this.timeOfFrame(clamp(index, 0, last)));
  }

  // Without qaboard.yaml's `fps` or playback, we don't know the frame rate. We show the previous frame:
  // the browser tells us its timestamp. It takes 1 to 3 seeks, once.
  learnFrameDuration() {
    if (!this.learning) {
      this.learning = this.learn().finally(() => { this.learning = null; });
    }
    return this.learning;
  }

  async learn() {
    const { leader } = this;
    if (typeof leader?.requestVideoFrameCallback !== 'function') return null;
    const showing = async time => {
      const frame = this.nextFrame();
      leader.currentTime = time;
      return await frame;
    };
    let shown = this.presented.get(leader)?.mediaTime ?? await showing(leader.currentTime);
    if (shown === null || this.leader !== leader) return null;
    if (shown < EPSILON) {
      // the first frame: we look further
      shown = await showing(Math.min(0.5, leader.duration / 2));
      if (!(shown > EPSILON) || this.leader !== leader) return null;
    }
    const previous = await showing(shown - EPSILON);
    if (previous === null || !(previous < shown) || this.leader !== leader) return null;
    this.measure(shown - previous);
    return this.frameDuration;
  }

  // the timestamp of the next frame the leader presents, null after a while
  nextFrame(timeout = 500) {
    return new Promise(resolve => {
      const waiter = { resolve };
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter(w => w !== waiter);
        resolve(null);
      }, timeout);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
      this.frameWaiters.push(waiter);
    });
  }

  alignFollower() {
    const { follower } = this;
    if (!this.usable(follower) || !this.usable(this.leader)) return;
    const time = Math.min(this.time, Math.max(0, follower.duration - EPSILON));
    const frame = this.frameDuration ?? DEFAULT_FRAME_DURATION;
    if (Math.abs(follower.currentTime - time) > frame / 4 || this.pending.has(follower)) this.seekElement(follower, time);
  }

  onWaiting(element) {
    if (!this.playing) return;
    // the other video waits for this one
    this.buffering = true;
    for (const other of this.elements) {
      if (other !== element && !other.paused) other.pause();
    }
    this.emit();
  }

  onCanPlay() {
    if (!this.playing || !this.buffering) {
      this.emit();
      return;
    }
    const ready = this.elements.every(element =>
      element.error ||
      element.readyState >= HAVE_FUTURE_DATA ||
      (element === this.follower && !this.followerCovers(this.time))
    );
    if (!ready) return;
    this.buffering = false;
    this.alignFollower();
    this.resume();
    this.emit();
  }

  // played by something else than us: the browser's menu, media keys, picture-in-picture...
  onPlayEvent() {
    if (!this.playing && !this.learning) this.play();
  }

  onPauseEvent(element) {
    // we pause videos that wait for the other, or that ended before the other
    if (!this.playing || this.buffering || element.ended) return;
    if (element === this.follower && !this.followerCovers(this.time)) return;
    this.pause();
  }

  onEnded(element) {
    if (element === this.leader) {
      if (this.loop && this.playing) {
        this.seek(0);
        this.resume();
      } else {
        this.playing = false;
        this.follower?.pause();
      }
    }
    this.emit();
  }

  onError(element) {
    if (element === this.leader && this.usable(this.follower)) {
      // the new video can't play: the reference plays alone
      const { follower, playing } = this;
      this.attach(follower, null);
      if (playing) this.play();
    }
    this.emit();
  }

  setRate(rate) {
    this.rate = rate;
    for (const element of this.elements) element.playbackRate = rate;
    this.emit();
  }

  setLoop(loop) {
    this.loop = loop;
    this.emit();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.leader) this.leader.muted = muted;
    this.emit();
  }

  makeSnapshot() {
    const { leader, follower } = this;
    const frameDuration = this.frameDuration;
    const time = this.time;
    const duration = Number.isFinite(leader?.duration) ? leader.duration : 0;
    const syncing = !this.usable(follower) || follower.seeking || this.pending.has(follower) || !this.followerCovers(time);
    const times = this.times;
    const settled = !this.playing && this.target === null && !leader?.seeking && !this.pending.has(leader);
    return {
      ready: this.usable(leader),
      time,
      duration,
      playing: this.playing,
      played: this.played,
      buffering: this.buffering,
      rate: this.rate,
      loop: this.loop,
      muted: this.muted,
      error: this.error,
      frameDuration,
      fpsSource: this.configuredFrameDuration ? 'config' : times?.length ? 'file' : this.measuredFrameDuration ? 'measured' : null,
      frame: times?.length || frameDuration ? this.frameAt(time) : null,
      frames: times?.length ? times.length : frameDuration && duration ? Math.round(duration / frameDuration) : null,
      // the frames the videos present, once they settled: { index, exact } or null
      presented: settled ? this.presentedFrame(leader) : null,
      presentedReference: settled && follower && !syncing ? this.presentedFrame(follower) : null,
      settled,
      // how far the reference is from the new video, in seconds
      drift: syncing || !leader ? null : follower.currentTime - leader.currentTime,
      buffered: rangesOf(leader?.buffered),
    };
  }

  emit() {
    const snapshot = this.makeSnapshot();
    if (sameSnapshot(snapshot, this.snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
}
