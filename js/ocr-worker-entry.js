import './worker-prelude.js';
import { PaddleOCR } from '@paddleocr/paddleocr-js';

// Plain WASM only. onnxruntime-web JSEP and the native WebGPU EP leak memory
// and crash WebKit 26 (onnxruntime issue 26827). The bundler aliases
// `onnxruntime-web` to the wasm build, and wasmPaths below point at
// ort-wasm-simd-threaded.wasm, not the .jsep.wasm binary.
// numThreads is 1 because GitHub Pages cannot send COOP/COEP, so
// SharedArrayBuffer multithreading is unavailable on iPad Safari.

function lineItems(items, imageHeight) {
  const lines = (items || []).map((item) => {
    const poly = item.poly || [];
    const ys = poly.map((point) => (Array.isArray(point) ? point[1] : point.y) || 0);
    const xs = poly.map((point) => (Array.isArray(point) ? point[0] : point.x) || 0);
    return {
      text: String(item.text || '').replace(/\s+/g, '').trim(),
      score: Number(item.score || 0),
      y: ys.length ? Math.min(...ys) : 0,
      x: xs.length ? Math.min(...xs) : 0,
    };
  }).filter((line) => line.text);
  lines.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const hasLong = lines.some((line) => [...line.text].length >= 8);
  const kept = lines.filter((line) => {
    if (!hasLong || [...line.text].length >= 5) return true;
    // Name plates sit above the dialog. Keep short lines that are part of the body.
    return line.y > imageHeight * 0.28;
  });
  const text = kept.map((line) => line.text).join('\n');
  const confidence = kept.length
    ? (kept.reduce((sum, line) => sum + (Number.isFinite(line.score) ? line.score : 0), 0) / kept.length) * 100
    : 0;
  return { text, confidence };
}

let engine = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  handle(msg).catch((err) => {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err?.message || String(err),
    });
  });
};

async function handle(msg) {
  if (msg.type === 'init') {
    const wasmUrl = String(msg.wasmUrl || '');
    const wasmMjsUrl = String(msg.wasmMjsUrl || '');
    if (/jsep|webgpu/i.test(wasmUrl) || /jsep|webgpu/i.test(wasmMjsUrl)) {
      throw new Error('拒絕載入 JSEP／WebGPU（WebKit 26 會洩漏並崩潰）');
    }
    engine = await PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      worker: false,
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textDetectionModelAsset: { url: msg.detUrl },
      textRecognitionModelAsset: { url: msg.recUrl },
      ortOptions: {
        backend: 'wasm',
        numThreads: 1,
        simd: true,
        proxy: false,
        wasmPaths: {
          mjs: wasmMjsUrl,
          wasm: wasmUrl,
        },
      },
    });
    const summary = engine.getInitializationSummary() || {};
    if (summary.detProvider && summary.detProvider !== 'wasm') {
      throw new Error(`OCR 必須使用 WASM，目前是 ${summary.detProvider}`);
    }
    if (summary.recProvider && summary.recProvider !== 'wasm') {
      throw new Error(`OCR 必須使用 WASM，目前是 ${summary.recProvider}`);
    }
    self.postMessage({
      type: 'ready',
      id: msg.id,
      summary: {
        backend: summary.backend || 'wasm',
        detProvider: summary.detProvider || 'wasm',
        recProvider: summary.recProvider || 'wasm',
      },
    });
    return;
  }

  if (msg.type === 'recognize') {
    if (!engine) throw new Error('OCR 尚未就緒');
    const image = msg.image;
    const height = image?.height || 0;
    const [result] = await engine.predict(image, {
      textDetLimitSideLen: 960,
      textDetLimitType: 'max',
    });
    if (image && typeof image.close === 'function') image.close();
    const { text, confidence } = lineItems(result?.items, height || result?.image?.height || 0);
    self.postMessage({ type: 'result', id: msg.id, text, confidence });
  }
}
