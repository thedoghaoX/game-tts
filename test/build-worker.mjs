// Bundle the OCR worker so GitHub Pages can host it without node_modules.
// `onnxruntime-web` is pinned to the plain WASM build. The full package and
// the WebGPU build pull in ort-wasm-simd-threaded.jsep.wasm, which leaks and
// crashes WebKit 26 (onnxruntime issue 26827).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'js/ocr-worker.bundle.js');

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['js/ocr-worker-entry.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile,
  legalComments: 'none',
  banner: {
    js: `if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.HTMLImageElement === "undefined") globalThis.HTMLImageElement = function HTMLImageElement() {};
if (typeof globalThis.HTMLCanvasElement === "undefined" && typeof OffscreenCanvas === "function") {
  globalThis.HTMLCanvasElement = OffscreenCanvas;
}
if (typeof globalThis.Image === "undefined") globalThis.Image = function Image() {};
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") throw new Error("OCR worker cannot create <" + tag + ">");
      if (typeof OffscreenCanvas !== "function") throw new Error("\u6b64\u700f\u89bd\u5668\u7684 Worker \u6c92\u6709 OffscreenCanvas");
      return new OffscreenCanvas(1, 1);
    },
    getElementById() { return null; },
  };
}
`,
  },
  alias: {
    'onnxruntime-web': path.join(root, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'),
  },
  plugins: [{
    name: 'stub-node-builtins',
    setup(build) {
      build.onResolve({ filter: /^(fs|path|crypto|module)$/ }, (args) => ({
        path: args.path,
        namespace: 'node-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  }],
});

const bundled = fs.readFileSync(outfile, 'utf8');
if (bundled.includes('ort-wasm-simd-threaded.jsep')) {
  throw new Error('worker bundle references the JSEP wasm binary');
}
if (!bundled.includes('PP-OCRv5') && !bundled.includes('textDetectionModelName')) {
  throw new Error('worker bundle is missing the PaddleOCR entry');
}
const kb = Math.round(fs.statSync(outfile).size / 1024);
console.log(`built ${path.relative(root, outfile)} (${kb} KB), plain WASM only`);
