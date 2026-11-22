// How the audio viewer writes times, levels and rates

// 75.5 => 1:15.500
export const formatTime = (seconds, digits = 3) => {
  if (!Number.isFinite(seconds)) return '-:--';
  const scale = 10 ** digits;
  const units = Math.round(Math.max(0, seconds) * scale);
  const total = Math.floor(units / scale);
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const fraction = digits > 0 ? `.${String(units % scale).padStart(digits, '0')}` : '';
  const rest = `${String(s).padStart(2, '0')}${fraction}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

export const formatDb = db => db === -Infinity ? '-∞ dBFS' : `${db.toFixed(1)} dBFS`;
export const formatLufs = lufs => Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : 'silent';
// a gain: "−2.4 dB", "+1.0 dB"
export const formatGain = db => `${db < 0 ? '−' : '+'}${Math.abs(db).toFixed(1)} dB`;

// 48000 => 48 kHz, 44100 => 44.1 kHz
export const formatRate = rate => rate >= 1000 ? `${+(rate / 1000).toFixed(3)} kHz` : `${rate} Hz`;

export const formatFrequency = hz => hz >= 1000 ? `${+(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;

// Ticks of the time axis over [start, end]: about one every `spacing` pixels, at round times
const STEPS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
export function timeTicks(start, end, width, spacing = 90) {
  if (!(end > start) || !(width > 0)) return [];
  const wanted = (end - start) * spacing / width;
  const step = STEPS.find(s => s >= wanted) ?? Math.ceil(wanted / 3600) * 3600;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  const ticks = [];
  for (let i = Math.max(0, Math.ceil(start / step - 1e-9)); i * step <= end + 1e-9; i++)
    ticks.push({ time: i * step, label: formatTime(i * step, digits) });
  return ticks;
}
