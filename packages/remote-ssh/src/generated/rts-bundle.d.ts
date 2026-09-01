/**
 * Stub for the build-time-generated `rts-bundle.ts` (written by the
 * rts-bundle-embed plugin in tsdown.config.ts, gitignored). Keeps
 * `#/generated/rts-bundle` type-resolvable on a fresh clone; at runtime the
 * missing module yields no export, which `readLocalBundle` treats as "no
 * embedded bundle" and falls back to the on-disk dist/rts.js.
 */
export declare const RTS_BUNDLE_SOURCE: string;
