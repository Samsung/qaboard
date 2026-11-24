/**
 * The trends are standalone, like the viewers (src/viewers/__tests__/isolation.test.js): they import only React,
 * Blueprint and their own files, and style only their own elements. The app draws them through src/CommitsTrends.jsx,
 * which loads the components on demand; the small model (model.js) can be imported anywhere.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['../*.{js,jsx}', '!../playground.jsx'], { query: '?raw', import: 'default', eager: true });
const app = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/__tests__/**', '!../../**/*.test.{js,jsx}', '!../../trends/**'], { query: '?raw', import: 'default', eager: true });
const imports = source => [
  ...source.matchAll(/^\s*import\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm),
  ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/^\s*export\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm),
].map(m => m[1]);

describe('the trends', () => {
  it('import nothing from the app', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    for (const [file, source] of Object.entries(sources))
      for (const specifier of imports(source))
        expect([file, specifier]).toEqual([file, expect.toSatisfy(s => /^\.\/[\w.-]+$/.test(s) || ['react', '@blueprintjs/core'].includes(s))]);
  });

  it('are reached by one file of the app, which loads their components on demand', () => {
    const adapter = '../../CommitsTrends.jsx';
    for (const [file, source] of Object.entries(app)) {
      if (file === adapter) continue;
      expect([file, imports(source).filter(s => s.includes('trends/'))]).toEqual([file, []]);
    }
    // the adapter imports the model (small), and the components only with import()
    const source = app[adapter];
    expect(source).toMatch(/\bimport\(\s*['"]\.\/trends\/Trends['"]/);
    const statically = [...source.matchAll(/^\s*import\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map(m => m[1]).filter(s => s.includes('trends/'));
    expect(statically).toEqual(['./trends/model']);
  });

  it('style only their own elements', () => {
    const css = readFileSync(resolve(cwd(), 'src/trends/trends.css'), 'utf-8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? [];
    expect(rules.length).toBeGreaterThan(20);
    for (const selectors of rules)
      for (const selector of selectors.split(',').map(s => s.trim()).filter(Boolean))
        expect(selector.replace(/^\.bp6-dark\s+/, '')).toMatch(/^\.qa-trends/);
  });
});
