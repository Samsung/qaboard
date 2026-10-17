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

const makeImage = (width, height, reference) => new Promise(resolve => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas, reference);
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

const App = () => {
  const [images, setImages] = useState(null);
  const [mode, setMode] = useState('side-by-side');
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    Promise.all([makeImage(960, 640, false), makeImage(960, 640, true)]).then(([a, b]) => setImages({ a, b }));
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
      reference={{ url: images.b, label: 'reference' }}
      mode={mode}
      onModeChange={setMode}
      syncKey="chart"
      regionSets={regions}
      getPixels={getPixels}
      theme={theme}
      style={{ maxWidth: 1200 }}
    />
    <h4 style={{ color: theme === 'dark' ? '#fff' : '#000' }}>Synced with the viewer above</h4>
    <ImageViewer image={images.b} syncKey="chart" theme={theme} style={{ maxWidth: 600 }} />
  </div>;
};

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
