// A page with the flame graph viewer alone, with generated profiles: npm start, then open /flame-graph-viewer.html
// ?stacks=300000 for bigger profiles, ?dark for the dark theme, ?new=<url>&ref=<url> for your own profiles
// (e.g. files in webapp/public/, any format the viewer reads), &name= the file name to show, &new_label= and
// &ref_label= the names of the commits. The generated profiles differ in known ways: see generate.js.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Classes } from '@blueprintjs/core';
import "normalize.css";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "../../App.css";

import { FlameGraphReport } from './FlameGraphReport';
import { generateFolded } from './generate';
import { decodeProfileBytes, parseProfile } from './formats';
import { side_color } from '../../sideColors';

const params = new URLSearchParams(window.location.search);
const stacks = parseInt(params.get('stacks') || '3000', 10);
if (params.has('dark')) document.documentElement.classList.add(Classes.DARK);

const get = url => fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`))).then(decodeProfileBytes);
let text_new, text_ref;
let path = 'cpu.folded';
if (params.has('new')) {
  path = params.get('new');
  [text_new, text_ref] = await Promise.all([get(path), params.has('ref') ? get(params.get('ref')) : undefined]);
} else {
  const t0 = performance.now();
  text_new = generateFolded({ stacks });
  text_ref = generateFolded({ stacks, reference: true });
  console.log(`generated ${stacks} stacks in ${Math.round(performance.now() - t0)} ms, ${(text_new.length / 1e6).toFixed(1)} MB`);
}
// how long parsing takes, for both profiles (the viewer parses them again)
const t0 = performance.now();
parseProfile(text_new, path);
if (text_ref) parseProfile(text_ref, path);
console.log(`parsed in ${Math.round(performance.now() - t0)} ms`);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ padding: 16, maxWidth: 1212, margin: '0 auto', background: 'var(--qa-background)', minHeight: '100vh' }}>
      <h3 style={{ marginTop: 0, color: 'var(--qa-text)' }}>{params.get('name') || path}</h3>
      <FlameGraphReport
        text_new={text_new}
        text_ref={text_ref}
        path={path}
        labels={{ new: params.get('new_label') || 'cache/shared', reference: params.get('ref_label') || 'main', colors: { new: side_color(0), reference: side_color(1) } }}
      />
    </div>
  </StrictMode>,
);
