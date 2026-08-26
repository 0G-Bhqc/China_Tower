import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The final artifact is one inline module; do not emit a module-preload
    // polyfill that contains a dormant fetch() path.
    modulePreload: false,
  },
});
