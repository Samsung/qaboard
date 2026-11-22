// Plays tracks together, in sync, hearing one: A/B comparisons switch what's heard without restarting.
// All tracks play from the same position through their own gain, only the heard one is up. The AudioContext is created
// on the first play: browsers only allow sound after a user gesture, and tests have no Web Audio.
export function createPlayer(tracks) {
  const sides = Object.keys(tracks).filter(side => tracks[side]);
  const duration = Math.max(0, ...sides.map(side => tracks[side].duration));
  let context = null, master = null, gains = {}, buffers = {}, sources = [];
  let playing = false, offset = 0, started_at = 0;
  let heard = sides[0], volume = 1, loop = null;

  const toBuffer = track => {
    if (track.buffer) return track.buffer;
    const buffer = context.createBuffer(track.channels.length, track.length, track.sample_rate);
    track.channels.forEach((samples, c) => buffer.copyToChannel(samples, c));
    return buffer;
  };
  const setup = () => {
    if (context) return;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    context = new Context();
    master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);
    for (const side of sides) {
      gains[side] = context.createGain();
      gains[side].gain.value = side === heard ? 1 : 0;
      gains[side].connect(master);
      buffers[side] = toBuffer(tracks[side]);
    }
  };
  const stopSources = () => {
    for (const source of sources) {
      source.onended = null;
      try { source.stop(); } catch { /* not started */ }
      source.disconnect();
    }
    sources = [];
  };
  const start = () => {
    // the same start time for all: they stay sample-aligned
    const when = context.currentTime + 0.02;
    for (const side of sides) {
      const buffer = buffers[side];
      const source = context.createBufferSource();
      source.buffer = buffer;
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start;
        source.loopEnd = Math.min(loop.end, buffer.duration);
      }
      source.connect(gains[side]);
      if (loop || offset < buffer.duration) source.start(when, Math.min(offset, buffer.duration));
      sources.push(source);
    }
    started_at = when;
  };
  const position = () => {
    if (!playing) return offset;
    const t = offset + Math.max(0, context.currentTime - started_at);
    if (loop && t >= loop.end) return loop.start + (t - loop.start) % (loop.end - loop.start);
    return t;
  };

  return {
    duration,
    get playing() { return playing; },
    get heard() { return heard; },
    // the position, in seconds. Stops at the end.
    time() {
      const t = position();
      if (playing && !loop && t >= duration) {
        stopSources();
        playing = false;
        offset = 0;
        return duration;
      }
      return t;
    },
    async play() {
      if (playing) return;
      setup();
      if (context.state === 'suspended') await context.resume();
      if (loop && (offset < loop.start || offset >= loop.end)) offset = loop.start;
      if (!loop && offset >= duration) offset = 0;
      playing = true;
      start();
    },
    pause() {
      if (!playing) return;
      offset = position();
      stopSources();
      playing = false;
    },
    seek(t) {
      const was_playing = playing;
      if (playing) this.pause();
      offset = Math.max(0, Math.min(duration, t));
      if (was_playing) this.play();
    },
    hear(side) {
      if (!tracks[side]) return;
      heard = side;
      // a short crossfade, without clicks
      if (context) for (const s of sides) gains[s].gain.setTargetAtTime(s === side ? 1 : 0, context.currentTime, 0.004);
    },
    setVolume(value) {
      volume = value;
      if (master) master.gain.setTargetAtTime(value, context.currentTime, 0.01);
    },
    // { start, end } in seconds, or null
    setLoop(region) {
      const t = position();
      const was_playing = playing;
      if (playing) this.pause();
      loop = region && region.end > region.start ? region : null;
      offset = t;
      if (was_playing) this.play();
    },
    dispose() {
      stopSources();
      playing = false;
      context?.close?.();
      context = null;
    },
  };
}
