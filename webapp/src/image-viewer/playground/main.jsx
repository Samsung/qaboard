// A page with the image viewer alone, with generated images: npm start, then open /image-viewer.html
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ImageViewer } from '../index';

// A test chart: gradients, color patches, fine lines and text. The reference differs in a few places.
const draw = (canvas, reference) => {
  const { width, height } = canvas;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#000');
  gradient.addColorStop(1, '#fff');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height / 3);
  const colors = ['#e5484d', '#30a46c', '#3e63dd', '#ffc53d', '#8e4ec6', '#12a594', '#f76b15', '#6e56cf'];
  colors.forEach((color, i) => {
    context.fillStyle = color;
    context.fillRect(i * width / colors.length, height / 3, width / colors.length, height / 3);
  });
  context.fillStyle = '#ddd';
  context.fillRect(0, 2 * height / 3, width, height / 3);
  context.strokeStyle = '#222';
  for (let x = 0; x < width / 2; x += 4) {
    context.beginPath();
    context.moveTo(x + 0.5, 2 * height / 3);
    context.lineTo(x + 0.5, height);
    context.stroke();
  }
  context.fillStyle = '#111';
  context.font = `${Math.round(height / 10)}px sans-serif`;
  context.fillText('QA-Board', width * 0.55, height * 0.88);
  if (reference) {
    // a slightly different color, a blur, a shifted line
    context.fillStyle = '#e8524d';
    context.fillRect(0, height / 3, width / colors.length / 2, height / 6);
    context.filter = 'blur(2px)';
    context.drawImage(canvas, width * 0.55, height * 0.75, width * 0.4, height * 0.2, width * 0.55, height * 0.75, width * 0.4, height * 0.2);
    context.filter = 'none';
    context.fillStyle = '#ddd';
    context.fillRect(40, 2 * height / 3, 4, height / 3);
  }
};

const makeImage = (width, height, reference, tweak) => new Promise(resolve => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas, reference);
  tweak?.(canvas.getContext('2d'), width, height);
  canvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png');
});

// The image's values: what we drew, but as 10-bit values, like a raw image. The viewer asks by tiles of 64x64.
const decoded = new Map();
const decode = url => {
  if (!decoded.has(url)) decoded.set(url, (async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0);
    return context;
  })());
  return decoded.get(url);
};
const getPixels = async (image, { x, y, w, h }) => {
  const rgba = (await decode(image.url)).getImageData(x, y, w, h).data;
  const data = new Uint16Array(w * h * 3);
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < 3; c++) data[3 * i + c] = rgba[4 * i + c] * 4;
  return { data, width: w, height: h, channels: 3, mode: 'RGB;10' };
};

// Raw images: the chart through a Tetra (Quad Bayer) GRBG color filter, 10-bit, with a black level and noise, shown in
// gray as a raw viewer would. The new image has no metadata (the viewer guesses its CFA), the reference has some.
const RAW_GAINS = { R: 0.5, G: 1, B: 0.7 };
// ?raw=300x400 makes them of that size
const RAW_SIZE = /^(\d+)x(\d+)$/.exec(new URLSearchParams(window.location.search).get('raw') ?? '');
const makeRaw = (url, { black = 64, seed = 1, metadata = null } = {}) => new Promise(resolve => {
  const img = new Image();
  img.onload = () => {
    const [w, h] = RAW_SIZE ? [Number(RAW_SIZE[1]), Number(RAW_SIZE[2])] : [img.naturalWidth, img.naturalHeight];
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0, w, h);
    const rgba = context.getImageData(0, 0, w, h).data;
    const values = new Uint16Array(w * h);
    const gray = context.createImageData(w, h);
    let random = seed;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const cell = 2 * (Math.floor(y / 2) % 2) + (Math.floor(x / 2) % 2);
        const color = 'GRBG'[cell];
        const c = 'RGB'.indexOf(color);
        random = (random * 16807) % 2147483647;
        const noise = ((random / 2147483647) - 0.5) * 12;
        const v = Math.max(0, Math.min(1023, Math.round(black + rgba[4 * (y * w + x) + c] * 3.4 * RAW_GAINS[color] + noise)));
        values[y * w + x] = v;
        const i = 4 * (y * w + x);
        gray.data[i] = gray.data[i + 1] = gray.data[i + 2] = v >> 2;
        gray.data[i + 3] = 255;
      }
    context.putImageData(gray, 0, 0);
    canvas.toBlob(blob => resolve({ url: URL.createObjectURL(blob), values, width: w, height: h, metadata }), 'image/png');
  };
  img.src = url;
});
const raws = new Map();
const getRawPixels = async (image, { x, y, w, h }) => {
  const raw = raws.get(image.url);
  const width = Math.min(w, raw.width - x);
  const height = Math.min(h, raw.height - y);
  const data = new Uint16Array(width * height);
  for (let j = 0; j < height; j++) data.set(raw.values.subarray((y + j) * raw.width + x, (y + j) * raw.width + x + width), j * width);
  // a server would be a bit slower
  await new Promise(resolve => setTimeout(resolve, 20));
  return { data, width, height, channels: 1, mode: 'I;16', sensor: raw.metadata ?? undefined };
};

const App = () => {
  const [images, setImages] = useState(null);
  const [mode, setMode] = useState('side-by-side');
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    Promise.all([
      makeImage(960, 640, false),
      makeImage(960, 640, true),
      // other files of the run, to compare with: a ground truth, the input
      makeImage(960, 640, false, (context, width, height) => {
        context.fillStyle = '#3e63dd';
        context.fillRect(width * 0.3, height * 0.05, width * 0.2, height * 0.2);
      }),
      makeImage(960, 640, false, context => {
        context.filter = 'blur(3px) grayscale(1)';
        context.drawImage(context.canvas, 0, 0);
      }),
    ]).then(async ([a, b, gt, input]) => {
      const raw_a = await makeRaw(a, { black: 64, seed: 3 });
      const raw_b = await makeRaw(b, {
        black: 64,
        seed: 5,
        metadata: { cfa: { pattern: 'GRBG', block: 2 }, bitDepth: 10, whiteLevel: 1023, blackLevel: 64, source: 'the playground', fields: { pattern: 'GRBG', samplePerPixel: '2x2', imageType: 'UI10', pedestal: 64 } },
      });
      raws.set(raw_a.url, raw_a);
      raws.set(raw_b.url, raw_b);
      setImages({ a, b, gt, input, raw_a: raw_a.url, raw_b: raw_b.url });
    });
  }, []);
  if (!images) return null;
  const regions = [{ id: 'presets', label: 'Presets', regions: [
    { x: 0, y: 213, w: 120, h: 107, label: 'Red patch' },
    { x: 0, y: 427, w: 80, h: 60, label: 'Lines' },
    { x: 520, y: 480, w: 400, h: 140, label: 'Text' },
  ] }];
  return <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', background: theme === 'dark' ? '#252a31' : '#fff', minHeight: '100vh' }}>
    <p>
      <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme} theme</button>
    </p>
    <ImageViewer
      image={{ url: images.a, label: 'new' }}
      reference={{ url: images.b, label: 'reference', detail: 'The same file in the reference run' }}
      compareWith={[
        { id: 'gt/chart.png', image: images.gt, group: 'Suggested', detail: 'Same name, in gt/' },
        { id: 'input.png', image: images.input, group: 'This run' },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `debug/stage_${i + 1}.png`, image: images.input, group: 'This run' })),
      ]}
      compareScopes={[
        { value: 'all', label: 'All runs', title: 'Every run compares with its own file of that name', phrase: 'in every run' },
        { value: 'run', label: 'This run', title: 'Only this run: the others keep what they compare with', phrase: 'in this run only' },
      ]}
      mode={mode}
      onModeChange={setMode}
      syncKey="chart"
      regionSets={regions}
      getPixels={getPixels}
      theme={theme}
      style={{ maxWidth: 1200 }}
    />
    <h4 style={{ color: theme === 'dark' ? '#fff' : '#000' }}>Raw images: Tetra GRBG, 10-bit (the new one without metadata)</h4>
    <ImageViewer
      className="playground-raw"
      image={{ url: images.raw_a, label: 'new' }}
      reference={{ url: images.raw_b, label: 'reference' }}
      getPixels={getRawPixels}
      defaultAnalysisValues="image"
      theme={theme}
      style={{ maxWidth: 1200 }}
    />
    <h4 style={{ color: theme === 'dark' ? '#fff' : '#000' }}>Synced with the viewer above</h4>
    <ImageViewer image={images.b} syncKey="chart" theme={theme} style={{ maxWidth: 600 }} />
  </div>;
};

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
