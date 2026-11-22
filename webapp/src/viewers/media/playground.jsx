// The "Logged media" section alone, with generated runs: npm start, then open /logged-media.html
// ?steps=50&keys=10 for more steps and keys, ?dark for the dark theme, ?cards=2 for the cards of two runs (their step
// is the same, like on a commit's page), ?noref without a reference.
// The files are generated in the browser (images drawn on a canvas): the items' viewers are simple ones, not the app's
// (the image viewer needs an image server). The tables and histograms are the real ones.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Classes, FocusStyleManager } from '@blueprintjs/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import LoggedMedia from './LoggedMedia';
import { MediaContext } from './context';
import { Thumbnail } from './ImageGrid';
import { side_color } from '../../sideColors';
import { fileQuery } from '../../api/queries';

FocusStyleManager.onlyShowFocusOnTabs();
const params = new URLSearchParams(window.location.search);
const step_count = Math.max(1, parseInt(params.get('steps') || '30', 10));
const key_count = Math.max(1, parseInt(params.get('keys') || '8', 10));
const card_count = Math.max(1, parseInt(params.get('cards') || '1', 10));
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

// a deterministic random, so that screenshots don't change
const random_of = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const blob = (text, type = 'text/plain') => URL.createObjectURL(new Blob([text], { type }));
const STEP = 100;

// A scene that gets sharper as the training goes: shapes on a gradient, and the boxes a detector found
const scene = (random, step_index, variant, reference) => {
  const width = 96, height = 72;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${(variant * 70) % 360}, 45%, 30%)`);
  gradient.addColorStop(1, `hsl(${(variant * 70 + 120) % 360}, 45%, 60%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const progress = (step_index + 1) / step_count * (reference ? 0.8 : 1);
  const boxes = [];
  const labels = ['cat', 'dog', 'car'];
  for (let i = 0; i < 2 + (variant % 2); i++) {
    const x = 8 + ((variant * 23 + i * 31) % 60), y = 8 + ((variant * 17 + i * 19) % 40);
    const w = 18 + i * 4, h = 14 + i * 3;
    context.fillStyle = `hsl(${i * 120}, 70%, 60%)`;
    context.beginPath();
    context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    context.fill();
    // noise, less and less
    for (let n = 0; n < 200 * (1 - progress); n++) {
      context.fillStyle = `rgba(255,255,255,${random() * 0.6})`;
      context.fillRect(random() * width, random() * height, 1, 1);
    }
    const jitter = (1 - progress) * 8;
    boxes.push({ x: Math.round(x + (random() - 0.5) * jitter), y: Math.round(y + (random() - 0.5) * jitter), w, h, label: labels[i], score: +(0.3 + 0.65 * progress * random() + 0.05).toFixed(2), group: 'predictions' });
  }
  // the ground truth, as fractions of the image
  boxes.push({ x: 0.05, y: 0.75, w: 0.3, h: 0.2, label: 'sign', units: 'fraction', group: 'ground_truth' });
  return { url: canvas.toDataURL('image/png'), width, height, boxes };
};

// A run's files: { [path]: url }, and its media.jsonl
const generate = (seed, reference) => {
  const random = random_of(seed);
  const files = {};
  const lines = [];
  const log = (step_index, item) => lines.push(JSON.stringify({ _step: step_index * STEP, _time: 1731500000 + step_index * 30, index: 0, ...item }));
  const KINDS = ['images', 'histogram', 'table', 'text', 'image', 'histogram', 'html', 'audio'];
  const keys = Array.from({ length: key_count }, (_, i) => {
    const kind = KINDS[i % KINDS.length];
    const name = {
      images: 'val/samples', histogram: i < 8 ? 'weights/fc1' : `weights/layer${i}`, table: 'val/predictions',
      text: 'generation/answer', image: 'train/attention', html: 'report', audio: 'tts/sample',
    }[kind];
    return { kind, name: i >= KINDS.length && kind !== 'histogram' ? `${name}_${i}` : name, variant: i };
  });
  for (let s = 0; s < step_count; s++) {
    for (const { kind, name, variant } of keys) {
      // some keys are logged less often
      const every = kind === 'table' || kind === 'html' ? 5 : kind === 'images' ? 2 : 1;
      if (s % every !== 0 && s !== step_count - 1) continue;
      // the reference logged a bit less
      if (reference && s >= step_count - 2) continue;
      const step = s * STEP;
      if (kind === 'images' || kind === 'image') {
        const count = kind === 'images' ? 4 : 1;
        for (let index = 0; index < count; index++) {
          const { url, width, height, boxes } = scene(random, s, variant + index, reference);
          const path = `media/${name}/${step}_${index}.png`;
          files[path] = url;
          log(s, { key: name, kind: 'image', index, path, width, height, boxes: kind === 'images' ? boxes : undefined, caption: `sample ${index}` });
        }
      } else if (kind === 'histogram') {
        // a distribution that drifts and narrows as the training goes
        const center = (reference ? 0.4 : 0.8) * s / step_count + variant * 0.1;
        const spread = 1.5 - s / step_count;
        const bins = Array.from({ length: 33 }, (_, i) => center - 3 * spread + i * 6 * spread / 32);
        const counts = Array.from({ length: 32 }, (_, i) => Math.round(1000 * Math.exp(-(((i - 16) / 6) ** 2)) * (0.8 + 0.4 * random())));
        log(s, { key: name, kind: 'histogram', bins, counts });
      } else if (kind === 'table') {
        const data = Array.from({ length: 200 }, (_, i) => {
          const image = scene(random, s, i % 5, reference);
          const path = `media/${name}/${step}_0/${i}_0.png`;
          files[path] = image.url;
          return [{ kind: 'image', path, width: image.width, height: image.height }, ['cat', 'dog', 'car', 'sign'][i % 4], +(random()).toFixed(3), i % 7 === 0 ? null : Math.round(random() * 100)];
        }).slice(0, 200);
        const path = `media/${name}/${step}_0.table.json`;
        files[path] = blob(JSON.stringify({ columns: ['image', 'label', 'score', 'iou'], data }), 'application/json');
        log(s, { key: name, kind: 'table', path, columns: ['image', 'label', 'score', 'iou'], rows: data.length });
      } else if (kind === 'text') {
        const path = `media/${name}/${step}_0.txt`;
        files[path] = blob(`Q: what is in the picture?\nA: ${['a cat', 'a cat on a mat', 'a grey cat on a red mat', 'a grey cat sleeping on a red mat'][Math.min(3, Math.floor(4 * s / step_count))]}${reference ? '.' : ''}\n`);
        log(s, { key: name, kind: 'text', path });
      } else {
        const ext = kind === 'html' ? 'html' : 'wav';
        const path = `media/${name}/${step}_0.${ext}`;
        files[path] = kind === 'html' ? blob(`<h3>Report at step ${step}</h3>`, 'text/html') : blob('', 'audio/wav');
        log(s, { key: name, kind, path, caption: kind === 'audio' ? 'hello world' : undefined });
      }
    }
  }
  files['media.jsonl'] = blob(lines.join('\n') + '\n');
  return files;
};

const runs = Array.from({ length: card_count }, (_, i) => ({
  new: { id: 2 * i + 1, output_dir_url: `/playground/new-${i}`, files: generate(11 + i, false), test_input_path: `scene_${i}` },
  ref: params.has('noref') ? undefined : { id: 2 * i + 2, output_dir_url: `/playground/ref-${i}`, files: generate(11 + i, true), test_input_path: `scene_${i}` },
}));
const fileUrl = (output, path) => output?.files?.[path];

// Simple viewers, instead of the app's: images side by side, with their boxes, texts side by side
const Side = ({ title, children }) => <div style={{ minWidth: 0 }}><div className={Classes.TEXT_MUTED} style={{ fontSize: 11 }}>{title}</div>{children}</div>;
const TextFile = ({ url }) => {
  const { data } = useQuery(fileQuery(url, { responseType: 'text' }));
  return <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{data ?? '…'}</pre>;
};
const Viewer = ({ output_new, output_ref, path, path_ref, boxes }) => {
  const url_new = fileUrl(output_new, path);
  const url_ref = output_ref ? fileUrl(output_ref, path_ref) : undefined;
  let side;
  if (path.endsWith('.png'))
    side = (url, item) => <div style={{ transform: 'scale(2.5)', transformOrigin: 'top left', width: 96 * 2.5, height: 72 * 2.5 }}>
      <Thumbnail src={url} item={item}/>
    </div>;
  else if (path.endsWith('.txt'))
    side = url => <TextFile url={url}/>;
  else
    side = () => <div className={Classes.TEXT_MUTED} style={{ fontSize: 12, padding: 8, border: '1px dashed rgba(128,128,128,0.4)' }}>The app's viewer for <code>{path.split('/').pop()}</code></div>;
  // the playground's image boxes, back from the viewer's regions
  const item = { width: 96, height: 72, boxes: (boxes ?? []).map(({ imageWidth, label, ...box }) => ({ ...box, label, units: imageWidth === 1 ? 'fraction' : undefined })) };
  return <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
    <Side title="new">{side(url_new, item)}</Side>
    {url_ref && <Side title="reference">{side(url_ref, { width: 96, height: 72 })}</Side>}
  </div>;
};

const labels = { new: 'feature/augment', reference: 'main', colors: { new: side_color(0), reference: side_color(1) } };
const Page = () => {
  // like a commit's page: the step chosen is the same for all the cards
  const [controls, setControls] = useState({});
  return <MediaContext.Provider value={{ fileUrl, Viewer }}>
    <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
      {runs.map((run, i) => <Card key={i} style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>scene_{i} · Logged media</h4>
        <LoggedMedia
          path="media.jsonl"
          output_new={run.new}
          output_ref={run.ref}
          labels={labels}
          media_step={controls.media_step}
          onControlsChange={changes => setControls(controls => ({ ...controls, ...changes }))}
        />
      </Card>)}
    </div>
  </MediaContext.Provider>;
};

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <Page/>
    </QueryClientProvider>
  </StrictMode>,
);
