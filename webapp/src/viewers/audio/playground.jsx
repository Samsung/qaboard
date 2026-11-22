// A page with the audio viewer alone, with generated audio: npm start, then open /audio-viewer.html
// ?seconds=30&channels=2&rate=48000 for other files, ?dark for the dark theme, ?single without a reference,
// ?new=<url>&ref=<url> for your own files (e.g. files in webapp/public/)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes } from '@blueprintjs/core';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { AudioViewer } from './AudioViewer';
import { generatePair } from './generate';
import { side_color } from '../../sideColors';

const params = new URLSearchParams(window.location.search);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

let src = params.get('new'), src_ref = params.get('ref');
if (!src) {
  const t0 = performance.now();
  const files = generatePair({
    seconds: parseFloat(params.get('seconds') || '10'),
    rate: parseInt(params.get('rate') || '48000', 10),
    channels: parseInt(params.get('channels') || '2', 10),
  });
  console.log(`generated the audio in ${Math.round(performance.now() - t0)} ms`);
  const url = buffer => URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  src = url(files.new);
  src_ref = params.has('single') ? undefined : url(files.reference);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
      <h3 style={{ marginTop: 0 }}>chirp.wav</h3>
      <div style={{ background: 'var(--qa-surface)', padding: 12, borderRadius: 3 }}>
        <AudioViewer
          src={src} src_ref={src_ref}
          labels={{ new: 'agent/denoiser', reference: 'main', colors: { new: side_color(0), reference: side_color(1) } }}
          caption="step 1200" caption_ref="step 1200"
          onError={error => console.error(error)}
        />
      </div>
    </div>
  </StrictMode>,
);
