// A <video> for the tests: seeks complete when we say so (or right away with `autoSeek`),
// and it presents frames of a video at `fps` when asked.
export class FakeVideo extends EventTarget {
  constructor({ duration = 10, fps = 25, readyState = 4, autoSeek = false, rvfc = true } = {}) {
    super();
    this.duration = duration;
    this.fps = fps;
    this.readyState = readyState;
    this.autoSeek = autoSeek;
    this._time = 0;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.error = null;
    this.playbackRate = 1;
    this.muted = false;
    this.loop = false;
    this.buffered = { length: 0 };
    this.presentedFrames = 0;
    this.callbacks = new Map();
    this.lastHandle = 0;
    this.played = 0;
    if (!rvfc) {
      this.requestVideoFrameCallback = undefined;
      this.cancelVideoFrameCallback = undefined;
    }
  }

  get currentTime() { return this._time; }

  set currentTime(time) {
    this._time = time;
    this.seeking = true;
    this.ended = false;
    this.emit('seeking');
    if (this.autoSeek) setTimeout(() => this.finishSeek(), 0);
  }

  // the timestamp of the frame shown at `time`
  frameTime(time = this._time) {
    return Math.floor(time * this.fps + 1e-9) / this.fps;
  }

  finishSeek() {
    if (!this.seeking) return;
    this.seeking = false;
    this.emit('seeked');
    this.present();
  }

  play() {
    this.played += 1;
    if (this.paused) {
      this.paused = false;
      this.emit('play');
    }
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this.paused = true;
      this.emit('pause');
    }
  }

  // plays for `seconds`, presenting frames
  advance(seconds) {
    if (this.paused || this.seeking) return;
    const end = this._time + seconds * this.playbackRate;
    while (this.frameTime(this._time) + 1 / this.fps <= Math.min(end, this.duration) + 1e-9) {
      this._time = this.frameTime(this._time) + 1 / this.fps;
      this.present();
    }
    this._time = Math.min(end, this.duration);
    if (this._time >= this.duration) {
      this.paused = true;
      this.ended = true;
      this.emit('pause');
      this.emit('ended');
    }
  }

  present() {
    this.presentedFrames += 1;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach(callback => callback(0, { mediaTime: this.frameTime(), presentedFrames: this.presentedFrames }));
  }

  requestVideoFrameCallback(callback) {
    this.lastHandle += 1;
    this.callbacks.set(this.lastHandle, callback);
    return this.lastHandle;
  }

  cancelVideoFrameCallback(handle) {
    this.callbacks.delete(handle);
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }
}
