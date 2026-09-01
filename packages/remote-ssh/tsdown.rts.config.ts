import { defineConfig } from 'tsdown';

// dist/rts.js: the deployable RTS server bundle — a single self-contained
// ESM file on node builtins only, run on the remote as `node rts.js`.
// dist/rts.cjs: the CommonJS twin used as the SEA entry (single-executable
// blobs require a CJS main) by scripts/build-sea.mjs.
// Built ahead of the library (see the `build` script) so
// scripts/gen-rts-bundle.mjs can embed its source.
export default defineConfig({
  entry: { rts: './src/server/main.ts' },
  format: ['esm', 'cjs'],
  dts: false,
  outDir: 'dist',
  clean: true,
  // The package is "type": "module"; plain .js (not .mjs) keeps the
  // deployable artifact at the documented path dist/rts.js.
  fixedExtension: false,
  deps: {
    alwaysBundle: [],
    neverBundle: [],
  },
});
