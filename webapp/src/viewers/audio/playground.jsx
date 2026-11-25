// A page with the audio viewer alone, with generated audio: npm start, then open /audio-viewer.html
// ?seconds=30&channels=2&rate=48000 for other files, ?dark for the dark theme, ?single without a reference,
// ?reference-rate=44100 for a reference at another rate (no difference then), ?sounds=12 for more compact rows,
// ?new=<url>&ref=<url> for your own files (e.g. files in webapp/public/)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes } from '@blueprintjs/core';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { AudioViewer } from './AudioViewer';
import { encodeWav } from './wav';
import { synthesize } from './generate';
import { side_color } from '../../sideColors';

const params = new URLSearchParams(window.location.search);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

const url = buffer => URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
const seconds = parseFloat(params.get('seconds') || '10');
const rate = parseInt(params.get('rate') || '48000', 10);
const channels = parseInt(params.get('channels') || '2', 10);
const reference_rate = parseInt(params.get('reference-rate') || String(rate), 10);
let src = params.get('new'), src_ref = params.get('ref');
if (!src) {
  const t0 = performance.now();
  src = url(encodeWav(synthesize({ seconds, rate, channels }), rate));
  // a little noise, too much gain, and a quarter tone up
  src_ref = params.has('single') ? undefined : url(encodeWav(synthesize({ seconds, rate: reference_rate, channels, noise: 0.01, clip: 1.6, pitch: 2 ** (0.5 / 12) }), reference_rate));
  console.log(`generated the audio in ${Math.round(performance.now() - t0)} ms`);
}
// a grid of short sounds, as logged media show them
const sounds = Array.from({ length: parseInt(params.get('sounds') || '6', 10) }, (_, i) => ({
  caption: `sample_${String(i).padStart(3, '0')} · step 1200`,
  src: url(encodeWav(synthesize({ seconds: 2 + (i % 3), rate: 16000, channels: 1, pitch: 1 + i * 0.15 }), 16000)),
  src_ref: url(encodeWav(synthesize({ seconds: 2 + (i % 3), rate: 16000, channels: 1, pitch: 1 + i * 0.15, noise: 0.02 * (i % 2), clip: 1 + (i % 3) * 0.3 }), 16000)),
}));

const labels = { new: 'agent/denoiser', reference: 'main', colors: { new: side_color(0), reference: side_color(1) } };
const card = { background: 'var(--qa-surface)', padding: 12, borderRadius: 3, marginBottom: 16 };
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
      <h3 style={{ marginTop: 0 }}>chirp.wav</h3>
      <div style={card}>
        <AudioViewer src={src} src_ref={src_ref} labels={labels} caption="step 1200" onError={error => console.error(error)}/>
      </div>
      <h3>Compact rows</h3>
      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px 16px' }}>
        {sounds.map(sound => <AudioViewer key={sound.caption} compact {...sound} labels={labels}/>)}
      </div>
    </div>
  </StrictMode>,
);
