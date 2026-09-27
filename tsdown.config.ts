import { defineConfig } from "tsdown"

export default defineConfig({
  // One entry per public subpath; each is also in package.json#exports and size-limit.
  entry: {
    index: "src/index.ts",
    pageviews: "src/pageviews.ts",
    identity: "src/identity.ts",
    autocapture: "src/autocapture.ts",
    search: "src/search.ts",
    flags: "src/flags.ts",
    experiments: "src/experiments.ts"
  },
  format: "esm",
  platform: "browser",
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  hash: false,
  fixedExtension: false
})
