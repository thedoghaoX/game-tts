// PP-OCRv5 via PaddleOCR.js inside a module worker.
// The worker loads onnxruntime-web's plain WASM build only (no JSEP, no WebGPU).

export const MODEL_BYTES = {
  det: 4_843_520,
  rec: 16_701_440,
};

export function assetUrls() {
  return {
    det: new URL('../models/PP-OCRv5_mobile_det_onnx_infer.tar', import.meta.url).href,
    rec: new URL('../models/PP-OCRv5_mobile_rec_onnx_infer.tar', import.meta.url).href,
    wasm: new URL('../vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
    wasmMjs: new URL('../vendor/ort/ort-wasm-simd-threaded.js', import.meta.url).href,
  };
}

export function createOcrClient() {
  const worker = new Worker(new URL('./ocr-worker.bundle.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();

  worker.onmessage = (event) => {
    const msg = event.data || {};
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.type === 'error') slot.reject(new Error(msg.message || 'OCR 失敗'));
    else slot.resolve(msg);
  };
  worker.onerror = (event) => {
    const err = new Error(event?.message || 'OCR worker 失敗');
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  };

  function call(message, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer || []);
    });
  }

  const urls = assetUrls();
  const ready = call({
    type: 'init',
    detUrl: urls.det,
    recUrl: urls.rec,
    wasmUrl: urls.wasm,
    wasmMjsUrl: urls.wasmMjs,
  });

  return {
    ready,
    async recognize(source) {
      await ready;
      const bitmap = typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap
        ? source
        : await createImageBitmap(source);
      const msg = await call({ type: 'recognize', image: bitmap }, [bitmap]);
      return {
        text: msg.text || '',
        confidence: Number(msg.confidence || 0),
      };
    },
    terminate() {
      worker.terminate();
    },
  };
}
