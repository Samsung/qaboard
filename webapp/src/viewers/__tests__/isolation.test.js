/**
 * The benchmark, flame graph and parallel coordinates viewers are standalone components, like the image viewer
 * (src/image-viewer/): they import only third-party packages and their own files, the app reaches them only through
 * their adapter, they are loaded lazily, and their styles don't leak to the rest of the page.
 * Run with: cd webapp && npm test -- isolation
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

// vitest runs in webapp/, and gives CSS files empty with ?raw
const stylesheets = folder => {
  const dir = resolve(cwd(), 'src/viewers', folder);
  return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.css')).map(f => [f, readFileSync(resolve(dir, f), 'utf-8')]));
};

// what a file imports, statically or dynamically
const imports = source => [
  ...source.matchAll(/^\s*import\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm),
  ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/^\s*export\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm),
].map(m => m[1]);

// The playgrounds (playground.jsx) are development pages, outside the build: they may use the app's CSS.
// - adapter: the only file of the app that imports from the viewer's folder,
// - lazy: where the viewer's code is split from the app's: the file that has the dynamic import(), and what it imports.
//   OutputViewer.jsx loads the adapters of the viewers of output files; an adapter can also load its viewer itself.
const viewers = {
  benchmarks: {
    sources: import.meta.glob(['../benchmarks/*.{js,jsx}', '!../benchmarks/playground.jsx'], { query: '?raw', import: 'default', eager: true }),
    css: stylesheets('benchmarks'),
    packages: ['react', '@blueprintjs/core', '@tanstack/react-virtual'],
    prefixes: ['qa-bench'],
    adapter: '../benchmarks-viewer.jsx',
    lazy: { file: '../OutputViewer.jsx', specifier: './benchmarks-viewer' },
  },
  flamegraph: {
    sources: import.meta.glob(['../flamegraph/*.{js,jsx}', '!../flamegraph/playground.jsx'], { query: '?raw', import: 'default', eager: true }),
    css: stylesheets('flamegraph'),
    packages: ['react', '@blueprintjs/core', 'd3-selection', 'd3-flame-graph'],
    // d3-flame-graph's own classes are only styled under .flame-graph
    prefixes: ['qa-flame', 'flame-graph'],
    adapter: '../flame-graph.jsx',
    lazy: { file: '../OutputViewer.jsx', specifier: './flame-graph' },
  },
  parallel: {
    sources: import.meta.glob(['../parallel/*.{js,jsx}', '!../parallel/playground.jsx'], { query: '?raw', import: 'default', eager: true }),
    css: stylesheets('parallel'),
    packages: ['react', '@blueprintjs/core'],
    prefixes: ['qa-parallel'],
    // the plot of Tuning Analysis: its adapter loads it when a report shows it
    adapter: '../../components/tuning/ParallelCoordinatesPlot.jsx',
    lazy: { file: '../../components/tuning/ParallelCoordinatesPlot.jsx', specifier: '../../viewers/parallel/ParallelCoordinates' },
  },
};

// Everything else in the app, but the viewers' own folders and the tests
const app = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/__tests__/**', '!../../**/*.test.{js,jsx}', '!../benchmarks/**', '!../flamegraph/**', '!../parallel/**'], { query: '?raw', import: 'default', eager: true });

describe.each(Object.entries(viewers))('the %s viewer', (folder, { sources, css, packages, prefixes, adapter, lazy }) => {
  it("imports nothing from the app", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(2);
    for (const [file, source] of Object.entries(sources))
      for (const specifier of imports(source))
        expect([file, specifier]).toEqual([file, expect.toSatisfy(s => /^\.\/[\w.-]+$/.test(s) || packages.includes(s))]);
  });

  it('is reached by the app only through its adapter, loaded lazily', () => {
    for (const [file, source] of Object.entries(app)) {
      const inside = imports(source).filter(s => s.includes(`${folder}/`));
      if (file === adapter) continue;
      expect([file, inside]).toEqual([file, []]);
    }
    expect(app[adapter]).toBeDefined();
    // split from the app's code: imported with import(), and not statically, where the viewer says it is
    const loader = app[lazy.file];
    const specifier = lazy.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(loader).toMatch(new RegExp(`\\bimport\\(\\s*['"]${specifier}['"]`));
    expect(loader).not.toMatch(new RegExp(`^\\s*import\\s[^'"]*['"]${specifier}['"]`, 'm'));
    // ... and what it loads is the adapter, or the viewer from its adapter
    const loaded = lazy.file === adapter ? lazy.specifier.includes(`${folder}/`) : lazy.specifier.replace(/^\.\//, '../') === adapter.replace(/\.jsx$/, '');
    expect([lazy.file, lazy.specifier, loaded]).toEqual([lazy.file, lazy.specifier, true]);
  });

  it("styles only its own elements", () => {
    expect(Object.keys(css).length).toBeGreaterThan(0);
    for (const [file, source] of Object.entries(css)) {
      expect(source.length).toBeGreaterThan(100);
      const rules = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@container[^{]*\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
      for (const selectors of rules) {
        for (const selector of selectors.split(',').map(s => s.trim()).filter(Boolean)) {
          // a dark theme ancestor is fine; the selector must then be about the viewer's classes
          const own = selector.replace(/^\.bp6-dark\s+/, '');
          expect([file, selector]).toEqual([file, expect.toSatisfy(() => prefixes.some(p => own.startsWith(`.${p}`)))]);
        }
      }
    }
  });
});
