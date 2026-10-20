// Tesseract.js chi_tra only.
// cacheMethod "write" stores the unpacked traineddata in IndexedDB (browser) or on disk (Node).
// The service worker additionally keeps the .gz response in the Cache API, so the slow fetch happens once.

export const TESSERACT_VERSION = '5.1.1';

export const TESSACT_PARAMS = {
  tessedit_pageseg_mode: '6',
  preserve_interword_spaces: '0',
  user_defined_dpi: '300',
};

export function workerOptions({ logger, errorHandler, cachePath = 'game-tts' } = {}) {
  return {
    cachePath,
    cacheMethod: 'write',
    gzip: true,
    logger: logger || (() => {}),
    errorHandler: errorHandler || (() => {}),
  };
}

export async function createChiTraWorker(opts = {}) {
  const Tesseract = globalThis.Tesseract;
  if (!Tesseract) throw new Error('Tesseract 尚未載入');
  const worker = await Tesseract.createWorker('chi_tra', 1, workerOptions(opts));
  await worker.setParameters(TESSACT_PARAMS);
  return worker;
}
