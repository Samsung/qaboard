// Generated tuning experiments for the playground (/parallel-coordinates.html) and the tests: what an image-quality
// tuning looks like, with everything the plot has to cope with.
// - kind 'grid': a grid search, 3 parameters x 3 values and 2 metrics. Every value is shared by a third of the rows.
// - kind 'optuna': an optimization that converges, with log-scale, integer, categorical and boolean parameters.
// - kind 'mixed': the same, plus what real data has: long dotted names, nested values, numbers as strings, a column
//   that's mostly numbers with a few 'auto', missing values (NaN, null, undefined), and a constant column.
// `rows` and `columns` make it bigger (extra parameters of every type are added to get to `columns`).

// A small deterministic random generator (mulberry32)
const random = seed => () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const METRICS = [
  { key: 'psnr', label: 'PSNR', suffix: ' dB', better: 'higher', group: 'Metrics' },
  { key: 'noise', label: 'Noise', better: 'lower', group: 'Metrics' },
];

function grid(rows) {
  const per_axis = rows ? Math.max(2, Math.round(Math.cbrt(rows))) : 3;
  const levels = (lo, hi) => Array.from({ length: per_axis }, (_, k) => Number((lo + (hi - lo) * k / (per_axis - 1)).toPrecision(3)));
  const sharpening = levels(0.5, 1.5), denoise = levels(0.1, 0.9), kernels = Array.from({ length: per_axis }, (_, k) => 3 + 2 * k);
  const rand = random(7);
  const data = [];
  for (const s of sharpening) for (const d of denoise) for (const k of kernels) {
    const noise = 4.2 - 2.6 * d + 1.4 * (s - 0.5) - 0.08 * k + rand() * 0.25;
    const psnr = 38 - 6 * (s - 1.1) ** 2 - 5 * (d - 0.45) ** 2 - 0.25 * Math.abs(k - 5) + rand() * 0.4;
    data.push({ sharpening: s, 'denoise.strength': d, 'denoise.kernel': k, psnr, noise });
  }
  return {
    columns: [
      ...METRICS,
      { key: 'sharpening', label: 'sharpening', group: 'Parameters' },
      { key: 'denoise.strength', label: 'denoise.strength', group: 'Parameters' },
      { key: 'denoise.kernel', label: 'denoise.kernel', group: 'Parameters' },
    ],
    data,
    colorBy: 'psnr',
    objective: row => -row.psnr,
  };
}

const TONE_CURVES = ['linear', 'reinhard', 'filmic', 'aces'];
function optuna(rows = 300, mixed = false) {
  const rand = random(11);
  const data = [];
  for (let i = 0; i < rows; i++) {
    // the search narrows around the optimum as iterations go
    const explore = Math.max(0.12, 1 - i / (rows * 0.7));
    const around = (best, lo, hi) => Math.min(hi, Math.max(lo, best + (rand() - 0.5) * (hi - lo) * explore));
    const log_lr = around(-2.6, -5, -1), log_reg = around(-1.2, -4, 1);
    const gamma = around(1.1, 0.2, 2.2);
    const iterations = Math.round(around(8, 1, 12));
    const tone = rand() < explore ? TONE_CURVES[Math.floor(rand() * 4)] : 'filmic';
    const use_lut = rand() < 0.3 + 0.5 * (1 - explore);
    const error = 0.02 + 0.6 * ((log_lr + 2.6) / 4) ** 2 + 0.25 * ((log_reg + 1.2) / 5) ** 2 + 0.3 * (gamma - 1.1) ** 2
      + (tone === 'filmic' ? 0 : tone === 'aces' ? 0.02 : 0.08) + (use_lut ? 0 : 0.03) + rand() * 0.02;
    const row = {
      iteration: i,
      objective: error,
      ssim: 1 - error * 0.9 - rand() * 0.01,
      runtime: 4 + iterations * 2.4 + (use_lut ? 0 : 6) + rand() * 3,
      learning_rate: 10 ** log_lr,
      regularization: 10 ** log_reg,
      gamma: Number(gamma.toFixed(3)),
      iterations,
      tone_curve: tone,
      use_lut,
    };
    if (mixed) {
      Object.assign(row, {
        // a metric that some runs don't produce
        lens_shading_error: rand() < 0.08 ? NaN : 0.5 + error * 3 + rand() * 0.3,
        'pipeline.blocks.demosaic.interpolation_mode': ['bilinear', 'malvar-he-cutler', 'adaptive-homogeneity-directed'][Math.floor(rand() * 3)],
        'pipeline.blocks.awb.gain': rand() < 0.05 ? 'auto' : Number((1 + rand()).toFixed(2)),
        'pipeline.blocks.awb.roi': rand() < 0.5 ? { x: 0, y: 0, w: 64 } : { x: 16, y: 16, w: 32 },
        'pipeline.blocks.ccm.saturation': String((0.8 + 0.1 * Math.floor(rand() * 4)).toFixed(1)),   // numbers as strings
        'pipeline.blocks.hdr.exposures': [undefined, null, 2, 3, 3, 4][Math.floor(rand() * 6)],
        'sensor.bit_depth': 10,
        'sensor.name': 'S5K-HM3',
      });
    }
    data.push(row);
  }
  const columns = [
    { key: 'objective', label: 'Objective', better: 'lower', group: 'Metrics' },
    { key: 'ssim', label: 'SSIM', better: 'higher', group: 'Metrics' },
    { key: 'runtime', label: 'Runtime', suffix: ' s', better: 'lower', group: 'Metrics' },
    ...(mixed ? [{ key: 'lens_shading_error', label: 'Lens shading error', better: 'lower', group: 'Metrics' }] : []),
    { key: 'learning_rate', label: 'learning_rate', log: true, group: 'Parameters' },
    { key: 'regularization', label: 'regularization', log: true, group: 'Parameters' },
    { key: 'gamma', label: 'gamma', group: 'Parameters' },
    { key: 'iterations', label: 'iterations', group: 'Parameters' },
    { key: 'tone_curve', label: 'tone_curve', choices: TONE_CURVES, group: 'Parameters' },
    { key: 'use_lut', label: 'use_lut', group: 'Parameters' },
    ...(mixed ? ['pipeline.blocks.demosaic.interpolation_mode', 'pipeline.blocks.awb.gain', 'pipeline.blocks.awb.roi',
      'pipeline.blocks.ccm.saturation', 'pipeline.blocks.hdr.exposures', 'sensor.bit_depth', 'sensor.name'].map(key => ({ key, label: key, group: 'Parameters' })) : []),
  ];
  return { columns, data, colorBy: 'objective', objective: row => row.objective };
}

const BLOCKS = ['blc', 'lsc', 'dpc', 'bnr', 'ynr', 'cnr', 'ee', 'gamma', 'ltm', 'ccm', 'csc', 'scaler'];
// More parameters, of every kind, correlated with what's there so that the lines aren't noise
function pad({ columns, data }, count) {
  const rand = random(23);
  for (let k = 0; columns.length < count; k++) {
    const block = BLOCKS[k % BLOCKS.length];
    const kind = k % 5;
    const key = `isp.${block}.${['strength', 'threshold', 'mode', 'radius', 'gain_log'][kind]}_${Math.floor(k / BLOCKS.length)}`;
    const weight = rand();
    data.forEach((row, i) => {
      const base = weight * (1 - Math.min(1, (row.objective ?? (row.noise ?? 2.5) / 5) * 2)) + (1 - weight) * rand();
      row[key] = kind === 0 ? Number(base.toFixed(3))
        : kind === 1 ? Math.round(base * 255)
        : kind === 2 ? ['off', 'low', 'medium', 'high'][Math.min(3, Math.floor(base * 4))]
        : kind === 3 ? [1, 2, 4][Math.floor(rand() * 3)]
        : (i % 61 === 60 ? undefined : 10 ** (base * 4 - 4));
    });
    columns.push({ key, label: key, group: 'Parameters', ...(kind === 2 ? { choices: ['off', 'low', 'medium', 'high'] } : {}), ...(kind === 4 ? { log: true } : {}) });
  }
}

/**
 * { columns, rows, colorBy, marks } for <ParallelCoordinates/>.
 */
export function generate({ kind = 'optuna', rows, columns } = {}) {
  const generated = kind === 'grid' ? grid(rows) : optuna(rows || 300, kind === 'mixed');
  if (columns) pad(generated, columns);
  const { data, objective } = generated;
  let best = 0;
  data.forEach((row, i) => { if (objective(row) < objective(data[best])) best = i; });
  const label = kind === 'grid' ? 'Experiment' : 'Iteration';
  return {
    columns: generated.columns,
    rows: data.map((values, i) => ({ id: `run-${i}`, label: `${label} ${i + 1}`, values })),
    colorBy: generated.colorBy,
    marks: { [`run-${best}`]: { label: 'Best' }, 'run-0': { label: 'Baseline', color: '#c87619' } },
  };
}
