// The analysis panel on the image's own values: what the sensor is (its CFA, bit depth, black level, and where we
// know them from), and the statistics, profiles and histograms of its channels: R, Gr, Gb, B, or their sub-pixels.
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { BLOCKS, CFA_PATTERNS, CHANNEL_COLORS as CFA_COLORS, GROUPINGS, blockName, cellAt, cellNames, channelRatios, describeCfa, normalizeCfa } from './cfa';
import { analyzeImage, forgetGuess } from './imageAnalysis';
import { niceTicks } from './analysis';
import { isLight } from './panels';
import { MARGIN, ProfilePlot } from './profilePlot';
import { imageKey } from './sources';
import { Button, Popover, Segmented, Select, Spinner } from './ui';

// --- Reading and analyzing the view ---

const roundRegion = region => region && {
  x: Math.max(0, Math.floor(region.x)),
  y: Math.max(0, Math.floor(region.y)),
  w: Math.max(1, Math.round(region.w)),
  h: Math.max(1, Math.round(region.h)),
};
const sameRegion = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// The region in view, once it stopped moving for `still` ms. The viewers can draw on every frame without moving, e.g.
// while tiles load or fail: waiting for the draws to stop could wait forever.
export const watchStillRegion = (controller, onRegion, { still = 400, every = 100 } = {}) => {
  let seen;
  let check = null;
  let timer = null;
  const update = () => {
    if (check !== null) return;
    check = setTimeout(() => {
      check = null;
      const next = roundRegion(controller.visibleRegion());
      if (seen !== undefined && (seen === next || sameRegion(seen, next))) return;
      seen = next;
      clearTimeout(timer);
      timer = setTimeout(() => onRegion(next), still);
    }, every);
  };
  update();
  const stop = controller.onDraw(update);
  return () => {
    stop();
    clearTimeout(check);
    clearTimeout(timer);
  };
};

// The analysis of the images' values over the view, once it stops moving: { status, progress, results: { a, b }, error }
export const useImageAnalysis = ({ controller, images, comparing, sizes, getPixels, setting, active }) => {
  const [region, setRegion] = useState(null);
  useEffect(() => {
    if (!active) return;
    return watchStillRegion(controller, next => setRegion(previous => sameRegion(previous, next) ? previous : next));
  }, [controller, active]);

  const [state, setState] = useState({ status: 'idle' });
  const [version, setVersion] = useState(0);
  const key_a = images.a ? imageKey(images.a) : '';
  const key_b = comparing && images.b ? imageKey(images.b) : '';
  const key = JSON.stringify([region, setting, key_a, key_b, version]);
  const run = useEffectEvent(signal => {
    const names = comparing && images.b ? ['a', 'b'] : ['a'];
    const progress = Object.fromEntries(names.map(name => [name, [0, 1]]));
    setState(previous => ({ ...previous, status: 'loading', progress: 0 }));
    // the other image's region: the same place, in its own pixels
    const regionOf = name => {
      if (name === 'a' || !sizes.a?.width || !sizes[name]?.width) return region;
      const sx = sizes[name].width / sizes.a.width;
      const sy = sizes[name].height / sizes.a.height;
      return roundRegion({ x: region.x * sx, y: region.y * sy, w: region.w * sx, h: region.h * sy });
    };
    Promise.all(names.map(name => analyzeImage(getPixels, images[name], regionOf(name), sizes[name], setting, {
      signal,
      onProgress: (done, total) => {
        progress[name] = [done, total];
        const [d, t] = Object.values(progress).reduce(([d, t], [a, b]) => [d + a, t + b], [0, 0]);
        setState(previous => ({ ...previous, progress: d / t }));
      },
    }))).then(results => {
      if (signal.aborted) return;
      setState({ status: 'ready', results: { a: results[0], b: results[1] ?? null } });
    }, error => {
      if (signal.aborted || error?.name === 'AbortError') return;
      setState({ status: 'error', error: error?.message ?? String(error) });
    });
  });
  // `key` says what to analyze
  const ready = active && !!region && !!getPixels && !!images.a;
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- it starts the analysis, which says how it goes
    run(abort.signal);
    return () => abort.abort();
  }, [ready, key]);
  const guessAgain = () => {
    forgetGuess(images.a);
    if (images.b) forgetGuess(images.b);
    setVersion(v => v + 1);
  };
  return { ...state, guessAgain, region };
};


// --- Where we know things from ---

const SOURCES = {
  user: { label: 'yours', title: 'You set it' },
  metadata: { label: 'metadata', title: "From the image's metadata" },
  pixels: { label: 'guessed', title: 'Guessed from the pixels' },
  mode: { label: 'type', title: "From the type of the image's values" },
  values: { label: 'values', title: 'From the values' },
  default: { label: 'default', title: "Unknown: a default, set it if it's wrong" },
};
const SourceTag = ({ source, detail }) => source ? <span className={`qiv-source qiv-source-${source}`} title={`${SOURCES[source]?.title ?? source}${detail ? `: ${detail}` : ''}`}>{SOURCES[source]?.label ?? source}</span> : null;

const formatInteger = n => Math.round(n).toLocaleString('en-US');


// --- The CFA, drawn ---

const FILLS = { R: '#ef6b6f', Gr: '#46b97f', Gb: '#2fb7a5', B: '#5b7ff0' };

// The CFA's period from the file's first pixel: cells in their colors, labelled, sub-pixels numbered. With `levels`,
// the brighter sub-pixels (e.g. long exposures) are marked.
export const CfaDiagram = ({ cfa, grouping = 'cfa', levels = null, size = 96, labels = true }) => {
  const { block } = cfa;
  const period = 2 * block;
  const s = Math.max(4, Math.min(24, Math.floor(size / period)));
  const names = cellNames(cfa.pattern);
  const bright = new Set(levels?.bright ?? []);
  const pixels = [];
  for (let py = 0; py < period; py++)
    for (let px = 0; px < period; px++) {
      const name = names[cellAt(cfa, px, py)];
      const sub = ((py + cfa.offset.y) % block) * block + ((px + cfa.offset.x) % block);
      pixels.push({ px, py, name, sub, dim: bright.size > 0 && !bright.has(sub) });
    }
  const width = period * s;
  // the cells' edges
  const edges = [];
  for (let k = 0; k <= period; k++) {
    if ((k + cfa.offset.x) % block === 0) edges.push(`M${k * s} 0V${width}`);
    if ((k + cfa.offset.y) % block === 0) edges.push(`M0 ${k * s}H${width}`);
  }
  // a label per cell, at its center (cells cut by the period's edge are labelled where they're largest)
  const cell_labels = [];
  if (labels) {
    for (let cy = 0; cy < 2; cy++)
      for (let cx = 0; cx < 2; cx++) {
        const x0 = cx * block - cfa.offset.x;
        const y0 = cy * block - cfa.offset.y;
        const visible = ([start]) => [Math.max(0, start), Math.min(period, start + block)];
        const [vx0, vx1] = visible([x0 < 0 ? x0 + period : x0]);
        const [vy0, vy1] = visible([y0 < 0 ? y0 + period : y0]);
        const name = names[cellAt(cfa, Math.max(0, x0 < 0 ? x0 + period : x0), Math.max(0, y0 < 0 ? y0 + period : y0))];
        cell_labels.push({ key: `${cx}${cy}`, name, x: (vx0 + vx1) / 2 * s, y: (vy0 + vy1) / 2 * s, room: Math.min(vx1 - vx0, vy1 - vy0) * s });
      }
  }
  const numbered = grouping === 'sub' && block > 1 && s >= 13;
  return <svg className="qiv-cfa" width={width + 2} height={width + 2} viewBox={`-1 -1 ${width + 2} ${width + 2}`} role="img" aria-label={`${describeCfa(cfa)}, from the file's first pixel`}>
    {pixels.map(({ px, py, name, dim }) => <rect key={`${px},${py}`} x={px * s} y={py * s} width={s} height={s} fill={FILLS[name]} opacity={dim ? 0.55 : 1} />)}
    {s >= 6 && <path d={Array.from({ length: period + 1 }, (_, k) => `M${k * s} 0V${width}M0 ${k * s}H${width}`).join('')} className="qiv-cfa-grid" />}
    <path d={edges.join('')} className="qiv-cfa-edges" />
    {numbered && pixels.map(({ px, py, sub, dim }) => <text key={`n${px},${py}`} x={px * s + s / 2} y={py * s + s / 2} className="qiv-cfa-sub" opacity={dim ? 0.7 : 1}>{sub + 1}</text>)}
    {!numbered && cell_labels.filter(l => l.room >= 11).map(l => <text key={l.key} x={l.x} y={l.y} className="qiv-cfa-label" style={{ fontSize: Math.min(15, Math.max(8, l.room * 0.42)) }}>{l.name}</text>)}
    {bright.size > 0 && pixels.filter(p => !p.dim).map(({ px, py }) => <circle key={`b${px},${py}`} cx={px * s + s - 3.5} cy={py * s + 3.5} r={1.8} className="qiv-cfa-bright" />)}
    {/* the file's first pixel */}
    <path d={`M0 0h${Math.min(7, s)}L0 ${Math.min(7, s)}z`} className="qiv-cfa-origin" />
  </svg>;
};

// A pattern, as a 2x2 square, for its button
const PatternIcon = ({ pattern }) => {
  const names = cellNames(pattern);
  return <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    {names.map((name, cell) => <rect key={cell} x={(cell % 2) * 11} y={Math.floor(cell / 2) * 11} width="11" height="11" fill={FILLS[name]} />)}
    <path d="M11 0V22M0 11H22" className="qiv-cfa-edges" />
  </svg>;
};

const swapRedBlue = pattern => [...pattern].map(c => c === 'R' ? 'B' : c === 'B' ? 'R' : c).join('');


// --- Setting the sensor ---

const KINDS = [
  { value: 'auto', label: 'Automatic', title: 'From the metadata, else the pixels' },
  { value: 'mosaic', label: 'Mosaic', title: 'One channel per pixel, through a color filter array (raw)' },
  { value: 'mono', label: 'One channel', title: 'No color filter array: monochrome, or a single channel' },
];

const NumberField = ({ label, value, placeholder, onChange, min = 0, max, step = 1, title, width = 64, name }) => {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value ?? '');
  const commit = text => {
    setDraft(null);
    if (text === '' || text === null) return onChange(null);
    const number = Number(text);
    if (Number.isFinite(number)) onChange(Math.max(min, max !== undefined ? Math.min(max, number) : number));
  };
  return <label className="qiv-number" title={title}>
    <span>{label}</span>
    <input
      type="number"
      aria-label={name ?? label}
      value={shown}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      onChange={event => setDraft(event.target.value)}
      onBlur={event => commit(event.target.value)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') commit(event.currentTarget.value);
        if (event.key === 'Escape') setDraft(null);
      }}
    />
  </label>;
};

const SensorEditor = ({ analysis, setting, onChange, onGuessAgain }) => {
  const { sensor } = analysis;
  const change = patch => onChange({ ...setting, ...patch });
  const cfa = sensor.cfa ?? normalizeCfa({ pattern: 'GRBG', block: 1 });
  const rgb = sensor.kind === 'rgb';
  const metadata_black = sensor.meta?.blackLevel;
  return <div className="qiv-sensor-editor">
    <div className="qiv-panel-title">The sensor</div>
    {rgb ? <div className="qiv-hint">The image has color values (RGB): no color filter array to set.</div> : <>
      <div className="qiv-field">
        <span className="qiv-field-label">Values</span>
        <Segmented label="What the values are" options={KINDS} value={setting.kind} onChange={kind => change({ kind })} />
      </div>
      {sensor.kind === 'mosaic' && <>
        <div className="qiv-field">
          <span className="qiv-field-label">Pattern</span>
          <span className="qiv-patterns" role="radiogroup" aria-label="Pattern">
            {CFA_PATTERNS.map(pattern => <button
              key={pattern}
              type="button"
              role="radio"
              aria-checked={cfa.pattern === pattern}
              className={`qiv-pattern ${cfa.pattern === pattern ? 'qiv-active' : ''}`}
              title={`${pattern}: ${cellNames(pattern).join(' ')} from the top left cell`}
              onClick={() => change({ pattern, block: cfa.block, offset: cfa.offset })}
            >
              <PatternIcon pattern={pattern} />
              <span>{pattern}</span>
            </button>)}
          </span>
          <Button icon="exchange" text="Swap R and B" className="qiv-small" title="Red and blue can't be told apart from a single channel: swap them" onClick={() => change({ pattern: swapRedBlue(cfa.pattern), block: cfa.block, offset: cfa.offset })} />
        </div>
        <div className="qiv-field">
          <span className="qiv-field-label">Cells</span>
          <Segmented
            label="Cell size"
            options={BLOCKS.slice(0, 4).map(block => ({ value: String(block), label: `${block}×${block}`, title: blockName(block) }))}
            value={cfa.block <= 4 ? String(cfa.block) : ''}
            onChange={value => change({ block: Number(value), pattern: cfa.pattern, offset: { x: 0, y: 0 } })}
          />
          <Select
            label="Larger cells"
            value={cfa.block > 4 ? String(cfa.block) : ''}
            options={[{ value: '', label: 'Larger…' }, ...BLOCKS.slice(4).map(block => ({ value: String(block), label: `${block}×${block}` }))]}
            onChange={value => value && change({ block: Number(value), pattern: cfa.pattern, offset: { x: 0, y: 0 } })}
          />
          <span className="qiv-muted">{blockName(cfa.block)}</span>
        </div>
        {cfa.block > 1 && <div className="qiv-field">
          <span className="qiv-field-label">Offset</span>
          <NumberField label="x" value={cfa.offset.x} min={0} max={cfa.block - 1} width={48} title="Where the cells start: the column of the file's first pixel in its cell" onChange={x => change({ offset: { x: x ?? 0, y: cfa.offset.y }, pattern: cfa.pattern, block: cfa.block })} />
          <NumberField label="y" value={cfa.offset.y} min={0} max={cfa.block - 1} width={48} title="Where the cells start: the row of the file's first pixel in its cell" onChange={y => change({ offset: { x: cfa.offset.x, y: y ?? 0 }, pattern: cfa.pattern, block: cfa.block })} />
          <span className="qiv-muted">of the file's first pixel in its cell</span>
        </div>}
      </>}
    </>}
    <div className="qiv-field">
      <span className="qiv-field-label">Black level</span>
      <NumberField
        label=""
        name="Black level"
        value={setting.blackLevel}
        placeholder={metadata_black ? String(metadata_black) : 'none'}
        width={88}
        step="any"
        title="The value of black: the statistics subtract it (signal, SNR, ratios) and count the values at or under it"
        onChange={blackLevel => change({ blackLevel })}
      />
      <span className="qiv-muted">{setting.blackLevel !== null ? 'yours' : metadata_black ? 'from the metadata' : 'unknown: the statistics use 0'}</span>
    </div>
    <div className="qiv-sensor-editor-actions">
      <Button icon="refresh" text="Guess again from the view" className="qiv-small" title="Guess the CFA again, from the center of the view: zoom on a detailed, not saturated area" onClick={onGuessAgain} />
      <Button icon="reset" text="Back to automatic" className="qiv-small" title="Forget what you set: the metadata, else the pixels" onClick={() => onChange({ grouping: setting.grouping })} />
    </div>
    <div className="qiv-hint">It applies to both images{analysis.remembered ? `, and is remembered ${analysis.remembered}` : ''}.</div>
  </div>;
};


// --- The sensor's card ---

const confidenceText = { high: 'confident', medium: 'fairly confident', low: 'not sure' };

const GuessScores = ({ guess }) => {
  if (!guess?.scores?.length) return null;
  const max = Math.max(...guess.scores.map(s => s.score), 1e-9);
  const chosen = guess.mosaic ? guess.cfa.block : null;
  return <div className="qiv-guess-scores" aria-label="How much each cell size explains the pattern of the pixels">
    {guess.scores.map(({ block, score }) => <span key={block} className={`qiv-guess-score ${block === chosen ? 'qiv-active' : ''}`} title={`Cells of ${block}×${block} (${blockName(block)}): explain ${(100 * score).toFixed(1)}% of the variations`}>
      <i style={{ height: `${Math.max(2, 100 * score / max)}%` }} />
      <span>{block}</span>
    </span>)}
  </div>;
};

const MetadataFields = ({ meta }) => {
  const fields = Object.entries(meta?.fields ?? {});
  if (!fields.length) return null;
  return <table className="qiv-meta-fields">
    <tbody>{fields.map(([name, value]) => <tr key={name}><td className="qiv-mono">{name}</td><td className="qiv-mono">{JSON.stringify(value)}</td></tr>)}</tbody>
  </table>;
};

export const SensorCard = ({ state, setting, onSettingChange, names, comparing, remembered = null }) => {
  const analysis = state.results?.a;
  if (!analysis) return <div className="qiv-sensor qiv-sensor-empty">
    {state.status === 'error' ? <span className="qiv-danger-text">{state.error}</span> : <><Spinner size={12} label="Reading the image's values" /> <span className="qiv-muted">Reading the image's values…</span></>}
  </div>;
  const { sensor } = analysis;
  const { guess, meta, check, levels, cfa, kind, sources } = sensor;
  const other = comparing ? state.results?.b?.sensor : null;
  const differs = other && (other.kind !== kind || describeCfa(other.cfa ?? { pattern: '', block: 0 }) !== describeCfa(cfa ?? { pattern: '', block: 0 }));
  const meta_source = meta?.source;
  // what the other image's metadata knows, and we only guessed: the same sensor, likely
  const adopt_cfa = other?.sources.cfa === 'metadata' && kind === 'mosaic' && sources.cfa === 'pixels' && other.kind === 'mosaic' && describeCfa(other.cfa) !== describeCfa(cfa);
  const adopt_black = other?.sources.black === 'metadata' && sensor.black === null;
  const adopt = adopt_cfa || adopt_black ? () => onSettingChange({
    ...setting,
    ...(adopt_cfa ? { pattern: other.cfa.pattern, block: other.cfa.block, offset: other.cfa.offset } : {}),
    ...(adopt_black ? { blackLevel: other.black } : {}),
  }) : null;
  const title = kind === 'mosaic' ? describeCfa(cfa) : kind === 'rgb' ? 'Color values (RGB)' : 'One channel';
  return <div className="qiv-sensor-wrap">
    <div className="qiv-sensor">
      {kind === 'mosaic' ? <CfaDiagram cfa={cfa} grouping={setting.grouping} levels={levels} size={84} />
        : <span className={`qiv-sensor-swatch qiv-sensor-swatch-${kind}`} aria-hidden="true" />}
      <div className="qiv-sensor-main">
        <div className="qiv-sensor-title">
          <strong>{title}</strong>
          <SourceTag source={kind === 'mosaic' ? sources.cfa : sources.kind} detail={(kind === 'mosaic' ? sources.cfa : sources.kind) === 'metadata' ? meta_source : undefined} />
          {check && <span className={`qiv-check ${check.agree === true ? 'qiv-check-ok' : check.agree === false ? 'qiv-check-warn' : ''}`}>{check.agree === true ? '✓ ' : check.agree === false ? '⚠ ' : ''}{check.text}</span>}
        </div>
        <div className="qiv-sensor-facts">
          <span>{sensor.bits ? `${sensor.bits}-bit` : 'Bit depth unknown'}{sensor.mode ? <span className="qiv-muted"> ({sensor.mode})</span> : null} <SourceTag source={sources.bits} detail={sources.bits === 'metadata' ? meta_source : sources.bits === 'pixels' ? `the largest value near the center of the view, ${sensor.max}, fits in ${sensor.bits} bits` : undefined} /></span>
          {sensor.white !== null && <span>white <span className="qiv-mono">{sensor.white}</span></span>}
          <span>black <span className="qiv-mono">{sensor.black ?? '–'}</span> {sensor.black !== null ? <SourceTag source={sources.black} detail={sources.black === 'metadata' ? meta_source : undefined} /> : <span className="qiv-muted">(unknown: set it)</span>}</span>
          {meta?.crop && <span className="qiv-muted" title={`The file was cut from a ${meta.crop.fullWidth}×${meta.crop.fullHeight} image, at (${meta.crop.x}, ${meta.crop.y}). The pattern is the file's.`}>crop of {meta.crop.fullWidth}×{meta.crop.fullHeight} at ({meta.crop.x}, {meta.crop.y})</span>}
        </div>
        <div className="qiv-sensor-notes">
          {kind === 'mosaic' && sources.cfa === 'pixels' && guess && (guess.exact
            ? <span>Read from the colors of the pixels: each has one channel.</span>
            : <span>Guessed from {formatInteger(sensor.patch.w * sensor.patch.h)} pixels at the center of the view ({confidenceText[guess.confidence]}). Red and blue can't be told apart from one channel: <button type="button" className="qiv-link" onClick={() => onSettingChange({ ...setting, pattern: swapRedBlue(cfa.pattern), block: cfa.block, offset: cfa.offset })}>swap them</button> if they're the other way.</span>)}
          {kind === 'mosaic' && sources.cfa === 'default' && <span>No mosaic found in the pixels here, and no metadata: set the pattern.</span>}
          {kind === 'mono' && sources.kind === 'pixels' && <span>{guess?.repeating ? `A pattern repeats every ${2 * guess.repeating} pixels, but not like a color filter array.` : 'No color filter array found in the pixels'}: set one if it's a raw image.</span>}
          {levels?.bright?.length > 0 && <span className="qiv-levels-note">Sub-pixels {levels.bright.map(s => s + 1).join(', ')} are ×{levels.ratio.toFixed(1)} brighter than the others: other exposures (long, short)? Group by sub-pixels to compare them.</span>}
          {other && <span className="qiv-sensor-other">
            <span className={differs ? 'qiv-warning-text' : ''}>{names.b}: {other.kind === 'mosaic' ? describeCfa(other.cfa) : other.kind === 'rgb' ? 'color values' : 'one channel'}</span>
            <SourceTag source={other.kind === 'mosaic' ? other.sources.cfa : other.sources.kind} detail={other.meta?.source} />
            {other.bits && <span>· {other.bits}-bit <SourceTag source={other.sources.bits} detail={other.meta?.source} /></span>}
            <span>· black {other.black ?? '–'} {other.black !== null && <SourceTag source={other.sources.black} detail={other.meta?.source} />}</span>
            {other.check?.agree === false && <span className="qiv-check qiv-check-warn">⚠ {other.check.text}</span>}
            {differs && !adopt && <span className="qiv-muted">: analyzed as such</span>}
            {adopt && <button type="button" className="qiv-link" onClick={adopt}>use its {[adopt_cfa && other.cfa.pattern, adopt_black && `black level ${other.black}`].filter(Boolean).join(' and ')}</button>}
          </span>}
        </div>
      </div>
      <Popover align="end" button={props => <Button {...props} icon="properties" text="Sensor" title="Set the CFA, cell size, offset and black level" />}>
        {() => <SensorEditor analysis={{ ...analysis, remembered }} setting={setting} onChange={onSettingChange} onGuessAgain={state.guessAgain} />}
      </Popover>
    </div>
    {(guess?.scores?.length > 0 || meta?.fields) && <details className="qiv-sensor-details">
      <summary>How we know</summary>
      <div className="qiv-sensor-details-body">
        {guess?.scores?.length > 0 && <div>
          <div className="qiv-detail-title">The pixels</div>
          <GuessScores guess={guess} />
          <div className="qiv-hint">How much of the pattern of the pixels each cell size explains, once the scene is removed (the mean over a period has all colors). Multiples of the right size explain it too: we take the smallest. The greens are the diagonal whose cells are most alike, period by period: both see the green of the scene.</div>
        </div>}
        {meta?.fields && <div>
          <div className="qiv-detail-title">The metadata{meta_source ? <span className="qiv-muted"> ({meta_source})</span> : null}</div>
          <MetadataFields meta={meta} />
        </div>}
      </div>
    </details>}
  </div>;
};


// --- Values ---

// Values as the image has them: integers as integers, floats with a few digits
const formatValue = (value, integers, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (value === Infinity) return '∞';
  if (integers && Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (!integers && abs !== 0 && (abs < 0.01 || abs >= 1e6)) return value.toExponential(2);
  return value.toFixed(integers ? digits : abs < 10 ? 4 : 2);
};
const formatShare = share => {
  if (share === null || share === undefined) return '–';
  if (share === 0) return '0%';
  const percent = 100 * share;
  if (percent < 0.01) return '<0.01%';
  return `${percent < 10 ? percent.toFixed(2) : percent.toFixed(1)}%`;
};

const IMAGE_STATS = [
  { key: 'mean', label: 'Mean', title: 'Average value', digits: 2 },
  { key: 'signal', label: '− black', title: 'The mean without the black level: the signal', digits: 2, needs: 'black' },
  { key: 'std', label: 'Std dev', title: 'Standard deviation: noise, on a flat area', digits: 2 },
  { key: 'snr', label: 'SNR', title: 'Signal to noise ratio: 20·log10((mean − black) / std dev), in dB. Meaningful on flat areas', snr: true },
  { key: 'min', label: 'Min', digits: 0 },
  { key: 'p1', label: 'P1', title: '1st percentile', digits: 0 },
  { key: 'median', label: 'Median', digits: 0 },
  { key: 'p99', label: 'P99', title: '99th percentile', digits: 0 },
  { key: 'max', label: 'Max', digits: 0 },
  { key: 'low', label: '≤ black', title: 'The share of values at or under the black level', share: true, needs: 'black' },
  { key: 'high', label: '≥ white', title: 'Saturated: the share of values at or over the white level', share: true, needs: 'white' },
];

const statCell = (stat, value, integers) => {
  if (stat.share) return formatShare(value);
  if (stat.snr) return value === null || value === undefined ? '–' : value === Infinity ? '∞' : `${value.toFixed(1)} dB`;
  return formatValue(value, integers, stat.digits);
};
const deltaCell = (stat, a, b, integers) => {
  if (a === null || b === null || a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return '–';
  const delta = stat.share ? 100 * (a - b) : a - b;
  if (delta === 0) return '0';
  const text = stat.share ? `${Math.abs(delta).toFixed(2)} pt` : stat.snr ? `${Math.abs(delta).toFixed(1)} dB` : formatValue(Math.abs(delta), integers, stat.digits);
  return `${delta > 0 ? '+' : '−'}${text}`;
};

const tsv = rows => [
  ['Channel', 'Image', ...IMAGE_STATS.map(s => s.label)].join('\t'),
  ...rows.map(({ channel, image, stats }) => [channel, image, ...IMAGE_STATS.map(s => {
    const v = stats?.[s.key];
    if (v === null || v === undefined) return '';
    if (v === Infinity) return 'inf';
    return s.share ? `${(100 * v).toFixed(4)}%` : Number(v.toFixed(4));
  })].join('\t')),
].join('\n');

// The sub-pixels of each color, as their cells: the mean of each, relative to the cell's
const SubPixelMaps = ({ analysis }) => {
  const { channels, stats, sensor } = analysis;
  const block = sensor.cfa?.block ?? 1;
  if (block < 2) return null;
  return <div className="qiv-subpixel-maps">
    {['R', 'Gr', 'Gb', 'B'].map(cell => {
      const subs = channels.map((channel, i) => ({ channel, stats: stats[i] })).filter(({ channel }) => channel.cell === cell);
      const signals = subs.map(({ stats }) => stats?.signal ?? NaN);
      const mean = signals.reduce((a, b) => a + b, 0) / signals.length;
      const s = Math.max(16, Math.min(44, Math.floor(176 / block)));
      return <figure key={cell} className="qiv-subpixel-map">
        <svg width={block * s} height={block * s} role="img" aria-label={`The ${cell} sub-pixels: their means`}>
          {subs.map(({ channel, stats }, i) => {
            const level = mean > 0 ? signals[i] / mean : 1;
            return <g key={channel.key}>
              <rect x={channel.sub.x * s} y={channel.sub.y * s} width={s} height={s} fill={FILLS[cell]} opacity={Math.max(0.2, Math.min(1, 0.6 * level))} />
              <title>{`${channel.name}: mean ${formatValue(stats?.mean, analysis.integers)}, ×${level.toFixed(2)} the ${cell} cell's`}</title>
              {s >= 30 && <text x={channel.sub.x * s + s / 2} y={channel.sub.y * s + s / 2} className="qiv-cfa-sub qiv-subpixel-level">{level.toFixed(2)}</text>}
            </g>;
          })}
          <rect x="0.5" y="0.5" width={block * s - 1} height={block * s - 1} className="qiv-subpixel-frame" />
        </svg>
        <figcaption>{cell}</figcaption>
      </figure>;
    })}
    <span className="qiv-hint">Each sub-pixel's mean over its cell's (without the black level): 1 when they're alike.</span>
  </div>;
};

const Ratios = ({ analysis, name }) => {
  const ratios = channelRatios(analysis.channels, analysis.stats);
  if (!ratios.length) return null;
  return <span className="qiv-ratios">
    {name && <span className="qiv-muted">{name}</span>}
    {ratios.map(r => <span key={r.key} className="qiv-ratio" title={r.title}><span className="qiv-muted">{r.key}</span> <span className="qiv-mono">{r.value.toFixed(3)}</span></span>)}
  </span>;
};

const ImageStats = ({ state, names, comparing, shown }) => {
  const { a, b } = state.results;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const integers = a.integers && (!b || b.integers);
  const has = { black: a.sensor.black !== null || b?.sensor.black != null, white: a.sensor.white !== null || b?.sensor.white != null };
  const columns = IMAGE_STATS.filter(stat => !stat.needs || has[stat.needs]);
  const both = comparing && b && b.channels.map(c => c.key).join() === a.channels.map(c => c.key).join();
  const rows = [];
  a.channels.forEach((channel, i) => {
    if (!shown(channel)) return;
    rows.push({ channel, image: names.a, stats: a.stats[i], first: true });
    if (both) {
      rows.push({ channel, image: names.b, stats: b.stats[i] });
      rows.push({ channel, image: 'Δ', delta: [a.stats[i], b.stats[i]] });
    }
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tsv(rows.filter(r => !r.delta).map(r => ({ channel: r.channel.name, image: r.image, stats: r.stats }))));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <div className="qiv-stats">
    <div className="qiv-image-stats-top">
      <Ratios analysis={a} name={both ? names.a : null} />
      {both && <Ratios analysis={b} name={names.b} />}
    </div>
    {a.grouping === 'sub' && <SubPixelMaps analysis={a} />}
    <div className="qiv-stats-scroll">
      <table className="qiv-stats-table">
        <thead>
          <tr>
            <th className="qiv-stats-channel" scope="col">Channel</th>
            {both && <th scope="col" className="qiv-stats-image">Image</th>}
            {columns.map(stat => <th key={stat.key} scope="col" title={stat.title}>{stat.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => <tr key={i} className={`${row.first ? 'qiv-stats-group' : ''} ${row.delta ? 'qiv-stats-delta' : ''}`}>
            {row.first && <th scope="row" rowSpan={both ? 3 : 1} className="qiv-stats-channel">
              <span className="qiv-histogram-channel-name" style={{ color: row.channel.color ?? undefined }}>{row.channel.name}</span>
              {row.first && row.stats && <span className="qiv-muted qiv-stats-count" title="Pixels counted">{formatInteger(row.stats.count)}</span>}
            </th>}
            {both && <td className="qiv-stats-image" title={row.delta ? `${names.a} − ${names.b}` : undefined}>{row.image}</td>}
            {columns.map(stat => <td key={stat.key} className="qiv-mono">
              {row.delta ? deltaCell(stat, row.delta[0]?.[stat.key], row.delta[1]?.[stat.key], integers) : statCell(stat, row.stats?.[stat.key], integers)}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="qiv-histogram-footer">
      <PlanNote analysis={a} />
      <span className="qiv-stats-actions">
        <Button icon={copied ? 'tick' : 'clipboard'} text={copied ? 'Copied' : 'Copy'} className="qiv-small" title="Copy the table, to paste in a spreadsheet (tab-separated values)" onClick={copy} />
      </span>
    </div>
  </div>;
};

// What was read: all the view, or strips across it
const PlanNote = ({ analysis }) => {
  const { plan } = analysis;
  const { region } = plan;
  return <span className="qiv-muted">
    Image values of the view, <span className="qiv-mono">x {region.x}–{region.x + region.w - 1}, y {region.y}–{region.y + region.h - 1}</span>:{' '}
    {plan.sampled
      ? <span title="Large views are read in strips across them, evenly spaced: full-width strips for the statistics and the columns, full-height strips for the rows. Zoom in to read all the pixels.">sampled, {formatInteger(plan.rows)} of {formatInteger(region.h)} rows and {formatInteger(plan.columns)} of {formatInteger(region.w)} columns</span>
      : <>all {formatInteger(region.w * region.h)} pixels</>}
  </span>;
};

const profile_settings = { band: 'std', scale: 'fit' };
const BANDS = [
  { value: 'std', label: 'Band: ±1 std dev' },
  { value: 'minmax', label: 'Band: min–max' },
  { value: 'none', label: 'No band' },
];

const ImageProfiles = ({ state, comparing, names, shown, marker, onGuideChange }) => {
  const { a, b } = state.results;
  const [settings, setSettings] = useState(() => ({ ...profile_settings }));
  const change = patch => {
    Object.assign(profile_settings, patch);
    setSettings(previous => ({ ...previous, ...patch }));
  };
  useEffect(() => () => onGuideChange(null), [onGuideChange]);
  const both = comparing && b && b.channels.map(c => c.key).join() === a.channels.map(c => c.key).join();
  const series = [{ columns: a.columns, rows: a.rows }, ...(both ? [{ columns: b.columns, rows: b.rows, dashed: true }] : [])];
  const lines = a.channels.map(channel => ({ name: channel.name, color: channel.color, shown: shown(channel) }));
  const { sensor } = a;
  const max = sensor.white ?? a.range[1];
  const references = [
    ...(sensor.black !== null ? [{ value: sensor.black, label: `black ${sensor.black}` }] : []),
    ...(sensor.white !== null ? [{ value: sensor.white, label: `white ${sensor.white}` }] : []),
  ];
  const period = sensor.kind === 'mosaic' ? 2 * sensor.cfa.block : 1;
  const per = period > 1 ? `, by ${period} pixels (a period of the CFA)` : '';
  const digits = a.integers ? 1 : 3;
  return <div className="qiv-profiles">
    <div className="qiv-profiles-settings">
      <Select value={settings.band} options={BANDS} onChange={band => change({ band })} label="Band" title="Around the average: how much the values vary across each column or row" />
      <Select value={settings.scale} options={[{ value: 'fit', label: 'Values: fit' }, { value: 'full', label: `Values: 0–${formatValue(max, a.integers, 0)}` }]} onChange={scale => change({ scale })} label="Values axis" />
    </div>
    <div className="qiv-profiles-plots">
      <ProfilePlot title="Columns" detail={`average of each column${per}`} axis="x" series={series} lines={lines} band={settings.band} scale={settings.scale} max={max} references={references} digits={digits} marker={marker?.x ?? null} onGuideChange={onGuideChange} />
      <ProfilePlot title="Rows" detail={`average of each row${per}`} axis="y" series={series} lines={lines} band={settings.band} scale={settings.scale} max={max} references={references} digits={digits} marker={marker?.y ?? null} onGuideChange={onGuideChange} />
    </div>
    <div className="qiv-histogram-footer">
      <PlanNote analysis={a} />
      {!both && comparing && b && <span className="qiv-muted">{names.b} has other channels: not plotted</span>}
    </div>
  </div>;
};

// The histograms of the channels' values
const drawHistograms = (element, analyses, shown, log) => {
  const ratio = window.devicePixelRatio || 1;
  const width = element.clientWidth;
  const height = element.clientHeight;
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  const context = element.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const plot_width = width - MARGIN.left - MARGIN.right;
  const plot_height = height - MARGIN.top - MARGIN.bottom;
  if (plot_width <= 0 || plot_height <= 0) return;
  const style = getComputedStyle(element);
  const text = style.color;
  const dark = isLight(text);
  const [first] = analyses;
  const [lo, hi] = first.range;
  const bins = first.histograms[0]?.length ?? 1;
  const share = (counts, k, total) => {
    const v = counts[k] / (total || 1);
    return log ? Math.log10(1 + 1e4 * v) : v;
  };
  let max = 0;
  for (const analysis of analyses)
    analysis.histograms.forEach((counts, c) => {
      if (!shown(analysis.channels[c])) return;
      const total = analysis.stats[c]?.count ?? 0;
      // not the clipped values: they'd squash the rest
      for (let k = 1; k < counts.length - 1; k++) max = Math.max(max, share(counts, k, total));
    });
  const X = v => MARGIN.left + (v - lo) / (hi - lo || 1) * plot_width;
  const Y = v => MARGIN.top + (1 - Math.min(1, v / (max || 1))) * plot_height;
  const snap = v => Math.round(v * ratio) / ratio + 0.5 / ratio;
  context.font = `10.5px ${style.getPropertyValue('--qiv-mono').trim() || 'monospace'}`;
  context.strokeStyle = style.getPropertyValue('--qiv-border').trim() || 'rgba(128,128,128,0.3)';
  context.fillStyle = text;
  context.globalAlpha = 0.65;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.beginPath();
  for (const tick of niceTicks(lo, hi, Math.max(2, Math.floor(plot_width / 80)))) {
    const x = snap(X(tick));
    context.moveTo(x, MARGIN.top);
    context.lineTo(x, MARGIN.top + plot_height);
    context.fillText(String(tick), Math.min(width - MARGIN.right - 10, Math.max(MARGIN.left + 10, x)), MARGIN.top + plot_height + 5);
  }
  context.stroke();
  context.globalAlpha = 1;
  // black and white
  context.setLineDash([3, 3]);
  context.strokeStyle = text;
  context.globalAlpha = 0.55;
  context.textAlign = 'left';
  for (const [value, label] of [[first.sensor.black, 'black'], [first.sensor.white, 'white']]) {
    if (value === null || value < lo || value > hi) continue;
    const x = snap(X(value));
    context.beginPath();
    context.moveTo(x, MARGIN.top);
    context.lineTo(x, MARGIN.top + plot_height);
    context.stroke();
    context.fillText(label, Math.min(x + 3, width - MARGIN.right - 30), MARGIN.top);
  }
  context.setLineDash([]);
  context.globalAlpha = 1;
  context.save();
  context.beginPath();
  context.rect(MARGIN.left, MARGIN.top - 2, plot_width, plot_height + 2);
  context.clip();
  const center = k => lo + (k + 0.5) * (hi - lo) / bins;
  analyses.forEach((analysis, s) => {
    analysis.histograms.forEach((counts, c) => {
      const channel = analysis.channels[c];
      if (!shown(channel)) return;
      const total = analysis.stats[c]?.count ?? 0;
      const color = channel.color ?? text;
      context.beginPath();
      context.moveTo(X(lo), Y(0));
      for (let k = 0; k < counts.length; k++) context.lineTo(X(center(k)), Y(share(counts, k, total)));
      context.lineTo(X(hi), Y(0));
      if (s === 0) {
        context.globalAlpha = dark ? 0.14 : 0.1;
        context.fillStyle = color;
        context.fill();
        context.globalAlpha = 1;
      }
      context.strokeStyle = color;
      context.lineWidth = 1.25;
      context.setLineDash(s ? [4, 3] : []);
      context.stroke();
    });
  });
  context.restore();
};

const ImageHistogram = ({ state, comparing, shown }) => {
  const { a, b } = state.results;
  const canvas = useRef(null);
  const [log, setLog] = useState(false);
  const [hover, setHover] = useState(null);
  const both = comparing && b && b.channels.map(c => c.key).join() === a.channels.map(c => c.key).join() && b.range.join() === a.range.join();
  const analyses = both ? [a, b] : [a];
  const draw = useEffectEvent(() => {
    if (canvas.current) drawHistograms(canvas.current, analyses, shown, log);
  });
  useEffect(() => {
    draw();
  });
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [lo, hi] = a.range;
  const bins = a.histograms[0]?.length ?? 1;
  const onPointerMove = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left - MARGIN.left) / (rect.width - MARGIN.left - MARGIN.right);
    setHover(fraction < 0 || fraction > 1 ? null : Math.min(bins - 1, Math.floor(fraction * bins)));
  };
  const range = k => {
    const from = lo + k * (hi - lo) / bins;
    const to = lo + (k + 1) * (hi - lo) / bins;
    return a.integers && to - from <= 1 ? String(Math.round(from)) : `${formatValue(from, a.integers, 0)}–${formatValue(to, a.integers, 0)}`;
  };
  const left = k => `calc(${MARGIN.left}px + (100% - ${MARGIN.left + MARGIN.right}px) * ${(k + 0.5) / bins})`;
  return <div className="qiv-image-histogram">
    <div className="qiv-profiles-settings">
      <Select value={log ? 'log' : 'linear'} options={[{ value: 'linear', label: 'Counts: linear' }, { value: 'log', label: 'Counts: log' }]} onChange={value => setLog(value === 'log')} label="Counts axis" title="A log scale shows the rare values, e.g. hot pixels" />
    </div>
    <div className="qiv-profile-plot qiv-image-histogram-plot" onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={canvas} aria-hidden="true" />
      {hover !== null && <div className="qiv-histogram-cursor qiv-profile-cursor" style={{ left: left(hover) }} />}
    </div>
    <div className="qiv-histogram-readout qiv-mono qiv-profile-readout">
      {hover !== null ? <>
        <span>{range(hover)}</span>
        {a.channels.map((channel, c) => shown(channel) && <span key={channel.key}>
          <span style={{ color: channel.color ?? undefined }}>{channel.name}</span> {formatShare(a.histograms[c][hover] / (a.stats[c]?.count || 1))}{both ? ` / ${formatShare(b.histograms[c][hover] / (b.stats[c]?.count || 1))}` : ''}
        </span>)}
      </> : <span className="qiv-muted">Hover to read the share of each channel's values</span>}
    </div>
    <div className="qiv-histogram-footer">
      <PlanNote analysis={a} />
    </div>
  </div>;
};

// The channels' buttons, on image values: click one to show it alone, shift+click to show or hide it
export const ImageChannelButtons = ({ analysis, hidden, onChange }) => {
  if (!analysis) return null;
  const groups = [];
  for (const channel of analysis.channels) {
    const key = channel.cell ?? channel.key;
    if (!groups.some(g => g.key === key)) groups.push({ key, color: channel.cell ? CFA_COLORS[channel.cell] : channel.color });
  }
  if (groups.length < 2) return null;
  const keys = groups.map(g => g.key);
  const toggle = (key, adding) => {
    if (!adding) {
      const alone = keys.every(k => hidden.has(k) === (k !== key));
      return onChange(alone ? new Set() : new Set(keys.filter(k => k !== key)));
    }
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (next.size < keys.length) onChange(next);
  };
  return <span className="qiv-histogram-channels">
    {groups.map(({ key, color }) => <button
      key={key}
      type="button"
      className={`qiv-histogram-channel ${hidden.has(key) ? 'qiv-off' : ''}`}
      style={{ '--qiv-channel': color ?? 'currentColor' }}
      aria-pressed={!hidden.has(key)}
      title={`${key}: click to show it alone, shift+click to show or hide it`}
      onClick={event => toggle(key, event.shiftKey)}
    >
      <i className="qiv-histogram-swatch" />{key}
    </button>)}
  </span>;
};

export const GroupingPicker = ({ analysis, value, onChange }) => {
  if (analysis?.sensor.kind !== 'mosaic') return null;
  const options = GROUPINGS.filter(g => g.value !== 'sub' || analysis.sensor.cfa.block > 1);
  return <Segmented className="qiv-analysis-views qiv-grouping" label="Channels" options={options} value={options.some(o => o.value === value) ? value : 'cfa'} onChange={onChange} />;
};

// The view of the analysis panel, on the image's values
export const ImageValuesView = ({ view, state, names, comparing, hidden, marker, onGuideChange }) => {
  if (!state.results?.a) return state.status === 'error' ? null : <div className="qiv-image-loading"><Spinner size={14} label="Reading the image's values" /></div>;
  const shown = channel => !hidden.has(channel.cell ?? channel.key);
  const loading = state.status === 'loading';
  return <div className={`qiv-image-values ${loading ? 'qiv-loading' : ''}`}>
    {loading && <div className="qiv-progress" role="progressbar" aria-label="Reading the image's values" aria-valuenow={Math.round(100 * (state.progress ?? 0))}><i style={{ width: `${100 * (state.progress ?? 0)}%` }} /></div>}
    {state.status === 'error' && <div className="qiv-message qiv-danger-text">{state.error}</div>}
    {view === 'histogram' && <ImageHistogram state={state} comparing={comparing} shown={shown} />}
    {view === 'profiles' && <ImageProfiles state={state} comparing={comparing} names={names} shown={shown} marker={marker} onGuideChange={onGuideChange} />}
    {view === 'stats' && <ImageStats state={state} comparing={comparing} names={names} shown={shown} />}
  </div>;
};
