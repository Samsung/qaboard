// Builds the image viewer (src/image-viewer/) as a library, for other apps: npm run build:image-viewer
// The package is in build-image-viewer/: `npm pack` or `npm publish` there. See src/image-viewer/README.md.
import { copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const source = 'src/image-viewer';
const outDir = 'build-image-viewer';

// The package's description, types and documentation
const packageFiles = () => ({
  name: 'image-viewer-package-files',
  closeBundle() {
    for (const file of ['package.json', 'README.md', 'index.d.ts'])
      copyFileSync(`${source}/${file}`, `${outDir}/${file}`);
  },
});

export default defineConfig({
  plugins: [react(), packageFiles()],
  // the app's favicons...
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: `${source}/index.js`,
      formats: ['es'],
      fileName: 'index',
      cssFileName: 'style',
    },
    rollupOptions: {
      // the app's own
      external: ['react', 'react-dom', 'react/jsx-runtime', 'openseadragon'],
    },
  },
});
