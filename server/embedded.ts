// Files baked into the single-file programs, as base64, keyed by path under public/ or examples/.
// This stays empty when running from source; scripts/build-binaries.mjs fills it in only while compiling.
export const EMBEDDED: Record<string, string> = {};
