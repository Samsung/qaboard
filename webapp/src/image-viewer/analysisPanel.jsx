// The analysis panel, under the images: the histogram of the view, the profiles of its rows and columns, or its
// statistics. Users pick the view in its header; the channels shown are the same for all.
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';

import { ANALYSES, STATS, alongImage, formatStat, formatStatDelta, profilesOf, statsOf, statsTsv } from './analysis';
import { pixelDensityRatio } from './comparison';
import { CHANNELS } from './histogram';
import { CHANNEL_COLORS, CHANNEL_TITLES, ChannelButtons, Histogram, LineLegend, readHistograms } from './panels';
import { ProfilePlot } from './profilePlot';
import { GroupingPicker, ImageChannelButtons, ImageValuesView, SensorCard, useImageAnalysis } from './sensorPanel';
import { Button, Segmented, Select } from './ui';

// What the viewers display, read again after they draw (at most every 250ms), and when `key` changes
const useAfterDraws = (controller, read, key) => {
  const [value, setValue] = useState(null);
  const update = useEffectEvent(() => setValue(read()));
  useEffect(() => {
    let timer = null;
    const stop = controller.onDraw(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        update();
      }, 250);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [controller]);
  useEffect(() => {
    const timer = setTimeout(update, 0);
    return () => clearTimeout(timer);
  }, [key]);
  return value;
};

const CORS_ERROR = "The image server doesn't allow reading the pixels (CORS)";

// What the analysis measures: the displayed values (8-bit, what users see), or the image's own (getPixels)
const VALUES = [
  { value: 'display', label: 'Displayed', title: 'The displayed values: 8-bit sRGB, at the screen\'s resolution' },
  { value: 'image', label: 'Image values', title: "The image's own values (raw, 10-bit, 16-bit…), at full resolution, per channel of the sensor: R, Gr, Gb, B" },
];

export const AnalysisPanel = ({ controller, comparing, names, view, onViewChange, channels, onChannelsChange, range, onRangeChange, onGuideChange, values, onValuesChange, images, sizes, getPixels, imageValuesUnavailable, sensor, onSensorChange, sensorRemembered }) => {
  const image_values = values === 'image' && !!getPixels;
  const state = useImageAnalysis({ controller, images, comparing, sizes, getPixels, setting: sensor, active: image_values });
  const [hidden, setHidden] = useState(() => new Set());
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const pixel = image_values && pointer ? controller.imagePixel('a', pointer.point) : null;
  const marker = pixel ? { x: pixel.x + 0.5, y: pixel.y + 0.5 } : null;
  const analysis = state.results?.a ?? null;
  const values_options = VALUES.map(option => option.value === 'image' && !getPixels
    ? { ...option, title: imageValuesUnavailable ?? "The app doesn't read the image's own values" }
    : option);
  return <div className="qiv-analysis">
    <div className="qiv-histogram-header">
      <span className="qiv-analysis-pickers">
        <Segmented className="qiv-analysis-views" label="Analysis of the view" options={ANALYSES} value={view} onChange={onViewChange} />
        <Segmented
          className={`qiv-analysis-views qiv-analysis-values ${getPixels ? '' : 'qiv-unavailable'}`}
          label="Values"
          options={values_options}
          value={image_values ? 'image' : 'display'}
          onChange={value => (value === 'display' || getPixels) && onValuesChange(value)}
        />
      </span>
      <span className="qiv-histogram-legend">
        {image_values ? <>
          <GroupingPicker analysis={analysis} value={sensor.grouping} onChange={grouping => onSensorChange({ ...sensor, grouping })} />
          <ImageChannelButtons analysis={analysis} hidden={hidden} onChange={setHidden} />
        </> : <ChannelButtons channels={channels} onChange={onChannelsChange} hint={view === 'histogram' ? 'The range you drag applies to the channels shown.' : ''} />}
        {view !== 'stats' && <LineLegend names={names} comparing={comparing} />}
      </span>
    </div>
    {image_values ? <>
      <SensorCard state={state} setting={sensor} onSettingChange={onSensorChange} names={names} comparing={comparing} remembered={sensorRemembered} />
      <ImageValuesView view={view} state={state} names={names} comparing={comparing} hidden={hidden} marker={marker} onGuideChange={onGuideChange} />
    </> : <>
      {view === 'histogram' && <Histogram controller={controller} comparing={comparing} names={names} channels={channels} range={range} onRangeChange={onRangeChange} />}
      {view === 'profiles' && <Profiles controller={controller} comparing={comparing} names={names} channels={channels} onGuideChange={onGuideChange} />}
      {view === 'stats' && <Stats controller={controller} comparing={comparing} names={names} channels={channels} />}
    </>}
  </div>;
};


// --- Profiles ---

// How users like their profiles, for the next viewers of the page
const profile_settings = { source: 'view', band: 'std', scale: 'fit' };
const SOURCES = [
  { value: 'view', label: 'Average of the view' },
  { value: 'pointer', label: 'Row and column under the pointer' },
];
const BANDS = [
  { value: 'std', label: 'Band: ±1 std dev' },
  { value: 'minmax', label: 'Band: min–max' },
  { value: 'none', label: 'No band' },
];
const SCALES = [
  { value: 'fit', label: 'Values: fit' },
  { value: 'full', label: 'Values: 0–255' },
];

// The profiles of what the viewers display: [{ name, dashed, columns, rows }], along the first image's pixels (the
// viewers show the same place). With `line` ({ x, y }, a pixel of the first image), along its row and column only.
// Throws when we can't read the pixels.
const readProfiles = (controller, comparing, line) => {
  const transform = controller.imageTransform('a');
  if (!transform?.scale) return [];
  const ratio = pixelDensityRatio();
  const { origin, scale } = transform;
  // zoomed in, the screen pixels over the same image pixel are one position
  const merge = scale * ratio >= 1;
  const toX = k => ((k + 0.5) / ratio - origin.x) / scale;
  const toY = k => ((k + 0.5) / ratio - origin.y) / scale;
  const series = [['a', false], ...(comparing ? [['b', true]] : [])].map(([name, dashed]) => {
    const canvas = controller.canvas(name);
    if (!canvas?.width || !canvas.height) return null;
    const { width, height } = canvas;
    const context = canvas.getContext('2d');
    if (line) {
      // only the row and the column of the pixel: cheap enough to follow the pointer
      const x = Math.floor((origin.x + (line.x + 0.5) * scale) * ratio);
      const y = Math.floor((origin.y + (line.y + 0.5) * scale) * ratio);
      const empty = { n: 0, count: [] };
      const columns = y >= 0 && y < height ? profilesOf(context.getImageData(0, y, width, 1).data, width, 1, { line: { x: -1, y: 0 } }).columns : empty;
      const rows = x >= 0 && x < width ? profilesOf(context.getImageData(x, 0, 1, height).data, 1, height, { line: { x: 0, y: -1 } }).rows : empty;
      return { name, dashed, columns: alongImage(columns, toX, merge), rows: alongImage(rows, toY, merge) };
    }
    const data = context.getImageData(0, 0, width, height).data;
    const { columns, rows } = profilesOf(data, width, height, { step: width * height > 1.5e6 ? 2 : 1 });
    return { name, dashed, columns: alongImage(columns, toX, merge), rows: alongImage(rows, toY, merge) };
  });
  return series.filter(Boolean);
};

const Profiles = ({ controller, comparing, names, channels, onGuideChange }) => {
  const [settings, setSettings] = useState(() => ({ ...profile_settings }));
  const change = patch => {
    Object.assign(profile_settings, patch);
    setSettings(previous => ({ ...previous, ...patch }));
  };
  const { source, scale } = settings;
  const at_pointer = source === 'pointer';
  // a single row or column doesn't vary
  const band = at_pointer ? 'none' : settings.band;

  // The pixel under the pointer, on any of the images; the row and column profiled stay when it leaves them
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const pixel = pointer ? controller.imagePixel('a', pointer.point) : null;
  const [pointed, setLine] = useState(null);
  useEffect(() => controller.subscribePointer(() => {
    const current = controller.getPointer();
    const next = current ? controller.imagePixel('a', current.point) : null;
    if (next) setLine(previous => previous?.x === next.x && previous?.y === next.y ? previous : next);
  }), [controller]);

  const line_key = at_pointer && pointed ? `${pointed.x},${pointed.y}` : '';
  const result = useAfterDraws(controller, () => {
    // before users point at a pixel: the center of the view
    const region = !pointed && at_pointer ? controller.visibleRegion() : null;
    const line = pointed ?? (region && { x: Math.floor(region.x + region.w / 2), y: Math.floor(region.y + region.h / 2) });
    if (at_pointer && !line) return { series: [] };
    try {
      return { series: readProfiles(controller, comparing, at_pointer ? line : null), line };
    } catch {
      return { error: CORS_ERROR };
    }
  }, `${comparing}|${source}|${line_key}`);
  const series = result?.series ?? [];
  const line = result?.line ?? null;
  useEffect(() => () => onGuideChange(null), [onGuideChange]);

  const lines = CHANNELS.map((name, c) => ({ name, color: c === 3 ? null : CHANNEL_COLORS[c], shown: channels[c] }));
  const titles = at_pointer
    ? { x: line ? `Row ${line.y}` : 'Row under the pointer', y: line ? `Column ${line.x}` : 'Column under the pointer' }
    : { x: 'Columns', y: 'Rows' };
  const details = at_pointer
    ? { x: 'values along the row, by column', y: 'values along the column, by row' }
    : { x: `average of each column, ${band === 'minmax' ? 'with its min and max' : band === 'std' ? '±1 std dev' : 'by x'}`, y: `average of each row, ${band === 'minmax' ? 'with its min and max' : band === 'std' ? '±1 std dev' : 'by y'}` };
  return <div className="qiv-profiles">
    <div className="qiv-profiles-settings">
      <Select value={source} options={SOURCES} onChange={value => change({ source: value })} label="Profiles of" title="The average of each column and row of the view, or the values along the row and column under the pointer" />
      {!at_pointer && <Select value={settings.band} options={BANDS} onChange={value => change({ band: value })} label="Band" title="Around the average: how much the values vary across each column or row" />}
      <Select value={scale} options={SCALES} onChange={value => change({ scale: value })} label="Values axis" title="Fit the values axis to the values, or show all the 8-bit values" />
      {at_pointer && !pointed && <span className="qiv-muted">The center of the view: move the pointer over the images</span>}
    </div>
    {result?.error ? <div className="qiv-message qiv-histogram-message qiv-profiles-message">{result.error}</div> : <div className="qiv-profiles-plots">
      <ProfilePlot title={titles.x} detail={details.x} axis="x" series={series} lines={lines} band={band} scale={scale} marker={pixel ? pixel.x + 0.5 : null} onGuideChange={onGuideChange} />
      <ProfilePlot title={titles.y} detail={details.y} axis="y" series={series} lines={lines} band={band} scale={scale} marker={pixel ? pixel.y + 0.5 : null} onGuideChange={onGuideChange} />
    </div>}
    <div className="qiv-histogram-footer">
      <span className="qiv-muted">{at_pointer ? 'The row and column stay when the pointer leaves the images' : 'Of the view: zoom in to profile a part of the image'}</span>
      <span className="qiv-muted qiv-analysis-note">displayed values, 8-bit · x and y: pixels of {comparing ? names.a : 'the image'}</span>
    </div>
  </div>;
};


// --- Statistics ---

const Stats = ({ controller, comparing, names, channels }) => {
  const result = useAfterDraws(controller, () => {
    const series = readHistograms(controller, comparing, null);
    if (!series) return { error: CORS_ERROR };
    return { series, region: controller.visibleRegion() };
  }, String(comparing));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (result?.error) return <div className="qiv-message qiv-histogram-message qiv-profiles-message">{result.error}</div>;
  const [first, second] = result?.series ?? [];
  const stats = (s, c) => s ? statsOf(s.bins[c], s.total) : null;
  const shown = CHANNELS.map((name, c) => ({ name, c })).filter(({ c }) => channels[c]);
  const rows = shown.flatMap(({ name, c }) => [
    { channel: name, image: names.a, stats: stats(first, c) },
    ...(comparing ? [{ channel: name, image: names.b, stats: stats(second, c) }] : []),
  ]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(statsTsv(rows));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const region = result?.region;
  const cells = (values, delta = null) => STATS.map(stat => <td key={stat.key} className="qiv-mono">
    {delta ? formatStatDelta(stat, delta[0]?.[stat.key], delta[1]?.[stat.key]) : formatStat(stat, values?.[stat.key])}
  </td>);
  return <div className="qiv-stats">
    <div className="qiv-stats-scroll">
      <table className="qiv-stats-table">
        <thead>
          <tr>
            <th className="qiv-stats-channel" scope="col">Channel</th>
            {comparing && <th scope="col" className="qiv-stats-image">Image</th>}
            {STATS.map(stat => <th key={stat.key} scope="col" title={stat.title}>{stat.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map(({ name, c }) => {
            const a = stats(first, c);
            const b = stats(second, c);
            const channel = <th scope="row" rowSpan={comparing ? 3 : 1} className="qiv-stats-channel" title={CHANNEL_TITLES[c]}>
              <span className="qiv-histogram-channel-name" style={{ color: c === 3 ? undefined : CHANNEL_COLORS[c] }}>{name}</span>
            </th>;
            if (!comparing) return <tr key={name} className="qiv-stats-group">{channel}{cells(a)}</tr>;
            return [
              <tr key={`${name}-a`} className="qiv-stats-group">{channel}<td className="qiv-stats-image">{names.a}</td>{cells(a)}</tr>,
              <tr key={`${name}-b`}><td className="qiv-stats-image">{names.b}</td>{cells(b)}</tr>,
              <tr key={`${name}-delta`} className="qiv-stats-delta"><td className="qiv-stats-image" title={`${names.a} − ${names.b}`}>Δ</td>{cells(null, [a, b])}</tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
    <div className="qiv-histogram-footer">
      <span className="qiv-muted">
        {region ? <>Of the view: <span className="qiv-mono">x {Math.floor(region.x)}–{Math.ceil(region.x + region.w) - 1}, y {Math.floor(region.y)}–{Math.ceil(region.y + region.h) - 1}</span> ({Math.round(region.w)}×{Math.round(region.h)} pixels of {comparing ? names.a : 'the image'}). Zoom in to measure a part of the image.</> : 'Of the view'}
      </span>
      <span className="qiv-stats-actions">
        <span className="qiv-muted qiv-analysis-note">displayed values, 8-bit</span>
        <Button icon={copied ? 'tick' : 'clipboard'} text={copied ? 'Copied' : 'Copy'} className="qiv-small" title="Copy the table, to paste in a spreadsheet (tab-separated values)" onClick={copy} disabled={!first} />
      </span>
    </div>
  </div>;
};
