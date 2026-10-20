import {
  DEFAULT_CROP,
  LIMITS,
  GATE_REASON_ZH,
  coverSourceRect,
  createSession,
  decideSpeak,
  downscaleGray,
  gateFrame,
  preprocessRGBA,
} from './pipeline.js';
import { createChiTraWorker } from './ocr.js';

const video = document.getElementById('video');
const statusMain = document.getElementById('statusMain');
const statusDetail = document.getElementById('statusDetail');
const lastEl = document.getElementById('last');
const toggleBtn = document.getElementById('toggle');
const unlockBtn = document.getElementById('unlock');
const resetCropBtn = document.getElementById('resetCrop');
const clearSpokenBtn = document.getElementById('clearSpoken');
const cropEl = document.getElementById('crop');
const thresholdInput = document.getElementById('threshold');
const thresholdLabel = document.getElementById('thresholdValue');

const CROP_KEY = 'game-tts-crop';
const THRESH_KEY = 'game-tts-threshold';

let worker = null;
let running = false;
let loopTimer = null;
let busy = false;
let audioUnlocked = false;
let sawLangDownload = false;
let crop = loadCrop();
let session = createSession();

const captureCanvas = document.createElement('canvas');
const ocrCanvas = document.createElement('canvas');

function setStatus(main, detail, isError) {
  statusMain.textContent = main;
  statusDetail.textContent = detail || '';
  statusDetail.classList.toggle('error', !!isError);
}

function loadCrop() {
  try {
    const raw = localStorage.getItem(CROP_KEY);
    if (!raw) return { ...DEFAULT_CROP };
    const parsed = JSON.parse(raw);
    if (!isValidCrop(parsed)) return { ...DEFAULT_CROP };
    return parsed;
  } catch {
    return { ...DEFAULT_CROP };
  }
}

function isValidCrop(value) {
  if (!value) return false;
  const keys = ['x', 'y', 'w', 'h'];
  if (!keys.every((key) => Number.isFinite(value[key]))) return false;
  return value.w >= 18 && value.h >= 12 && value.x >= 0 && value.y >= 0
    && value.x + value.w <= 100.5 && value.y + value.h <= 100.5;
}

function saveCrop() {
  const rounded = {
    x: round1(crop.x),
    y: round1(crop.y),
    w: round1(crop.w),
    h: round1(crop.h),
  };
  crop = rounded;
  localStorage.setItem(CROP_KEY, JSON.stringify(rounded));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function updateCropUI() {
  cropEl.style.left = `${crop.x}%`;
  cropEl.style.top = `${crop.y}%`;
  cropEl.style.width = `${crop.w}%`;
  cropEl.style.height = `${crop.h}%`;
}

function loadThreshold() {
  const raw = Number(localStorage.getItem(THRESH_KEY));
  if (Number.isFinite(raw) && raw >= 1 && raw <= 20) return raw;
  return LIMITS.CHANGE_THRESHOLD;
}

function currentThreshold() {
  return Number(thresholdInput.value);
}

thresholdInput.value = String(loadThreshold());
thresholdLabel.textContent = thresholdInput.value;
thresholdInput.addEventListener('input', () => {
  thresholdLabel.textContent = thresholdInput.value;
  localStorage.setItem(THRESH_KEY, thresholdInput.value);
});

updateCropUI();

let drag = null;
cropEl.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-handle]');
  drag = {
    mode: handle ? handle.dataset.handle : 'move',
    x: event.clientX,
    y: event.clientY,
    crop: { ...crop },
  };
  cropEl.setPointerCapture(event.pointerId);
  event.preventDefault();
});
cropEl.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = ((event.clientX - drag.x) / window.innerWidth) * 100;
  const dy = ((event.clientY - drag.y) / window.innerHeight) * 100;
  crop = applyCropGesture(drag.crop, drag.mode, dx, dy);
  updateCropUI();
});
function endDrag() {
  if (!drag) return;
  drag = null;
  saveCrop();
}
cropEl.addEventListener('pointerup', endDrag);
cropEl.addEventListener('pointercancel', endDrag);

function applyCropGesture(start, mode, dx, dy) {
  const minW = 18;
  const minH = 12;
  let { x, y, w, h } = start;
  const right = x + w;
  const bottom = y + h;
  if (mode === 'move') {
    x = clamp(x + dx, 0, 100 - w);
    y = clamp(y + dy, 0, 100 - h);
    return { x, y, w, h };
  }
  if (mode.includes('e')) w = clamp(w + dx, minW, 100 - x);
  if (mode.includes('s')) h = clamp(h + dy, minH, 100 - y);
  if (mode.includes('w')) {
    const nx = clamp(x + dx, 0, right - minW);
    w = right - nx;
    x = nx;
  }
  if (mode.includes('n')) {
    const ny = clamp(y + dy, 0, bottom - minH);
    h = bottom - ny;
    y = ny;
  }
  return { x, y, w, h };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

resetCropBtn.addEventListener('click', () => {
  crop = { ...DEFAULT_CROP };
  updateCropUI();
  saveCrop();
});

clearSpokenBtn.addEventListener('click', () => {
  session.spoken = [];
  lastEl.textContent = '';
  setStatus(statusMain.textContent, '已清除唸過的句子，同一句可以再唸一次');
});

function pickVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  return voices.find((voice) => /zh[-_]TW/i.test(voice.lang))
    || voices.find((voice) => /^zh/i.test(voice.lang))
    || null;
}

function makeUtterance(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-TW';
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  return utterance;
}

// Must run inside the click/tap call stack. iOS ignores speechSynthesis until then.
function unlockAudio() {
  if (!window.speechSynthesis) {
    setStatus('這台裝置沒有語音', '請用 iPad Safari 開啟', true);
    return;
  }
  const utterance = makeUtterance('聲音已開啟');
  utterance.onerror = (event) => {
    audioUnlocked = false;
    unlockBtn.textContent = '開啟聲音';
    unlockBtn.classList.remove('secondary');
    const code = event?.error || '';
    if (code === 'not-allowed') {
      setStatus('語音被擋住了', '請關掉靜音，再點一次「開啟聲音」', true);
    } else if (code === 'language-unavailable' || code === 'voice-unavailable' || code === 'synthesis-unavailable') {
      setStatus('沒有中文語音', '請到系統設定加入中文（台灣）語音', true);
    } else {
      setStatus('語音沒有播出', code ? `原因：${code}` : '請關掉靜音後再試', true);
    }
  };
  window.speechSynthesis.speak(utterance);
  audioUnlocked = true;
  unlockBtn.textContent = '聲音已開';
  unlockBtn.classList.add('secondary');
}

unlockBtn.addEventListener('click', () => {
  unlockAudio();
});

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const utterance = makeUtterance(text);
  // cancel() then speak() in the same turn is dropped on iOS, so wait a frame.
  window.speechSynthesis.cancel();
  setTimeout(() => window.speechSynthesis.speak(utterance), 60);
  lastEl.textContent = `剛唸：${text}`;
}

function captureCrop() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const rect = coverSourceRect(vw, vh, video.clientWidth, video.clientHeight, crop);
  captureCanvas.width = rect.sw;
  captureCanvas.height = rect.sh;
  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  return ctx.getImageData(0, 0, rect.sw, rect.sh);
}

async function tick() {
  if (!running || !worker || busy) return;
  const image = captureCrop();
  if (!image) return;
  const gray = downscaleGray(image.data, image.width, image.height);
  const gate = gateFrame(session, gray, performance.now(), {
    changeThreshold: currentThreshold(),
  });
    const diffText = gate.diff == null ? '' : `差異 ${gate.diff.toFixed(1)}%`;
  if (!gate.runOcr) {
    setStatus(GATE_REASON_ZH[gate.reason] || gate.reason, diffText);
    return;
  }

  busy = true;
  setStatus('辨識中…', diffText);
  try {
    const prepared = preprocessRGBA(image.data, image.width, image.height);
    ocrCanvas.width = prepared.width;
    ocrCanvas.height = prepared.height;
    ocrCanvas.getContext('2d').putImageData(
      new ImageData(prepared.data, prepared.width, prepared.height),
      0,
      0,
    );
    const result = await worker.recognize(ocrCanvas);
    const text = result?.data?.text || '';
    const confidence = Number(result?.data?.confidence ?? 0);
    const decision = decideSpeak(session, text, confidence);
    const seen = decision.text || '（無文字）';
    if (decision.speak) {
      speak(decision.text);
      setStatus(`唸出：${decision.text}`, `信心 ${Math.round(confidence)}`);
    } else if (decision.reason === 'duplicate') {
      setStatus('這句唸過了，略過', seen);
    } else if (decision.reason === 'low-confidence') {
      setStatus('信心太低，不唸', `${seen}（${Math.round(confidence)}）`);
    } else {
      setStatus('掃描中', `看到：${seen}`);
    }
  } catch (err) {
    setStatus('辨識失敗', err?.message || String(err), true);
  } finally {
    busy = false;
  }
}

async function loop() {
  if (!running) return;
  const started = performance.now();
  await tick();
  if (!running) return;
  const wait = Math.max(50, LIMITS.FRAME_MS - (performance.now() - started));
  loopTimer = setTimeout(loop, wait);
}

function cameraErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '沒有相機權限。請用 Safari 打開，並允許相機。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '找不到相機。';
  }
  if (name === 'SecurityError') {
    return '需要 HTTPS 才能開相機。請用 GitHub Pages 網址開啟。';
  }
  return `${name || '錯誤'}：${err?.message || '無法開啟相機'}`;
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('此瀏覽器沒有相機 API'), { name: 'NotSupportedError' });
  }
  const audio = false;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch (err) {
    if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
      return navigator.mediaDevices.getUserMedia({
        audio,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    }
    throw err;
  }
}

async function ensureWorker() {
  if (worker) return;
  sawLangDownload = false;
  setStatus('載入繁中字庫…', '第一次會下載，之後從瀏覽器快取讀取');
  worker = await createChiTraWorker({
    logger: (message) => {
      if (message.status === 'loading language traineddata' && message.progress > 0 && message.progress < 1) {
        sawLangDownload = true;
      }
      if (!running) {
        const pct = message.progress != null ? ` ${Math.round(message.progress * 100)}%` : '';
        setStatus(`載入 OCR：${message.status}${pct}`, sawLangDownload ? '正在下載繁中字庫' : '檢查快取');
      }
    },
    errorHandler: (err) => {
      const text = typeof err === 'string' ? err : (err?.message || String(err));
      setStatus('OCR 錯誤', text, true);
    },
  });
}

async function start() {
  if (running) return;
  toggleBtn.disabled = true;
  try {
    await ensureWorker();
    setStatus(sawLangDownload ? '字庫已下載並寫入快取' : '字庫來自快取', '正在開啟相機…');
    const stream = await openCamera();
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    running = true;
    session = createSession();
    session.spoken = [];
    toggleBtn.textContent = '停止';
    toggleBtn.classList.add('stop');
    setStatus('已開始', audioUnlocked ? '藍色框對準字幕，新的字會自動唸' : '建議先點「開啟聲音」，否則 iPad 可能不會出聲');
    loop();
  } catch (err) {
    setStatus('無法開始', cameraErrorMessage(err), true);
  } finally {
    toggleBtn.disabled = false;
  }
}

function stop() {
  running = false;
  busy = false;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  toggleBtn.textContent = '開始掃描';
  toggleBtn.classList.remove('stop');
  setStatus('已停止', '字庫仍留在快取，下次不用重新下載');
}

toggleBtn.addEventListener('click', () => {
  if (running) {
    stop();
    return;
  }
  if (!audioUnlocked) unlockAudio();
  start();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Cache is optional; IndexedDB inside Tesseract still covers the traineddata.
  });
}
