// Module workers have no document and no importScripts. OpenCV.js and
// PaddleOCR.js still create a canvas while turning an ImageBitmap into a Mat.
// Installing this before those libraries load lets them use OffscreenCanvas.

const scope = globalThis;

if (typeof scope.window === 'undefined') {
  scope.window = scope;
}

if (typeof scope.document === 'undefined') {
  scope.document = {
    createElement(tag) {
      if (tag !== 'canvas') {
        throw new Error(`OCR worker cannot create <${tag}>`);
      }
      if (typeof OffscreenCanvas !== 'function') {
        throw new Error('此瀏覽器的 Worker 沒有 OffscreenCanvas');
      }
      return new OffscreenCanvas(1, 1);
    },
    getElementById() {
      return null;
    },
  };
}
