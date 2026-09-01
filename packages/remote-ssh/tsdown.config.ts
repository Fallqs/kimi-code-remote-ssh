import { defineConfig } from 'tsdown';

// The library entries (dist/index.js, dist/server/index.js) consumed by the
// harness-side transport layer. The deployable RTS server bundle has its own
// config (tsdown.rts.config.ts); the `build` script chains
// rts → gen-rts-bundle → this library build, because `#/generated/rts-bundle`
// (the RTS source embedded for packaged builds) is generated from dist/rts.js.
export default defineConfig({
  entry: ['./src/index.ts', './src/server/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: false,
  fixedExtension: false,
  deps: {
    alwaysBundle: [],
    neverBundle: [],
  },
});
