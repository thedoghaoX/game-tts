import {
  LIMITS,
  charAccuracy,
  cropRGBA,
  detectDialogBox,
  downscaleGray,
  normalizedSimilarity,
  scoreReading,
  simulateReading,
} from './pipeline.js';
import { createOcrClient } from './ocr.js';
import { toTraditional } from './chinese.js';

const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const tableEl = document.getElementById('rows');
const sequenceEl = document.getElementById('sequence');

function setStatus(text) {
  statusEl.textContent = text;
}

async function loadImageData(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function runSuite() {
  runBtn.disabled = true;
  summaryEl.textContent = '';
  tableEl.innerHTML = '';
  sequenceEl.innerHTML = '';
  window.__RESULT = null;
  try {
    setStatus('讀取 samples/manifest.json …');
    const manifest = await (await fetch('./samples/manifest.json')).json();
    setStatus('載入 PP-OCRv5（plain WASM，第一次較慢）…');
    const client = createOcrClient();
    const ready = await client.ready;
    if (ready.summary?.detProvider && ready.summary.detProvider !== 'wasm') {
      throw new Error(`backend ${ready.summary.detProvider}`);
    }

    const recognized = [];
    for (const sample of manifest.samples) {
      setStatus(`辨識 ${sample.file} …`);
      const image = await loadImageData(`./samples/${sample.file}`);
      let source = image;
      let box = null;
      if (sample.detect) {
        box = detectDialogBox(image.data, image.width, image.height);
        if (!box) throw new Error(`${sample.id} 找不到對話框`);
        const cropped = cropRGBA(image.data, image.width, image.height, box);
        source = new ImageData(cropped.data, cropped.width, cropped.height);
      }
      const result = await client.recognize(source);
      const text = toTraditional(result.text || '');
      const confidence = Number(result.confidence || 0);
      const score = scoreReading(sample.text, text, confidence);
      const accuracy = sample.text ? charAccuracy(text, sample.text) : null;
      if (sample.detect && accuracy != null) {
        score.pass = accuracy >= (sample.minCharAccuracy ?? 0.8);
      }
      recognized.push({
        sample, text, confidence, score, accuracy, box, image,
      });
      const row = document.createElement('tr');
      const metric = sample.detect && accuracy != null
        ? accuracy.toFixed(2)
        : (sample.text ? score.similarity.toFixed(2) : '—');
      row.innerHTML = `
        <td>${sample.id}</td>
        <td>${escapeHtml(sample.text || '（無字）')}</td>
        <td>${escapeHtml(score.got || '（空）')}</td>
        <td>${metric}</td>
        <td>${Math.round(confidence)}</td>
        <td>${score.pass ? '通過' : '失敗'}</td>`;
      tableEl.appendChild(row);
    }

    const byId = new Map(recognized.map((item) => [item.sample.id, item]));
    const shots = manifest.sequence.map((id) => {
      const item = byId.get(id);
      const gray = downscaleGray(item.image.data, item.image.width, item.image.height);
      return { id, gray, text: item.text, confidence: item.confidence };
    });
    const reading = simulateReading(shots);
    const expected = manifest.expectedSpeaks.map((text) => text);
    const aligned = reading.speaks.length === expected.length
      && reading.speaks.every((spoken, index) => normalizedSimilarity(spoken, expected[index]) > LIMITS.SIM_THRESHOLD);
    const passed = recognized.filter((item) => item.score.pass).length;
    const accuracy = passed / recognized.length;
    const photo = recognized.find((item) => item.sample.detect);

    summaryEl.textContent = [
      `準確率 ${passed}/${recognized.length}（${Math.round(accuracy * 100)}%）`,
      photo ? `照片字元準確率 ${Math.round(photo.accuracy * 100)}%` : '',
      `重唸次數 ${reading.rereads}`,
      `辨識次數 ${reading.ocrRuns}`,
      `唸出：${reading.speaks.join(' ／ ') || '（沒有）'}`,
      aligned ? '朗讀順序與預期一致' : '朗讀順序和預期不同',
      `後端 ${ready.summary?.detProvider || 'wasm'}`,
    ].filter(Boolean).join('\n');

    reading.events.forEach((event) => {
      const line = document.createElement('li');
      line.textContent = `${event.id}：${event.reason}${event.text ? `「${event.text}」` : ''}`;
      sequenceEl.appendChild(line);
    });

    window.__RESULT = {
      ok: true,
      provider: ready.summary?.detProvider || 'wasm',
      passed,
      total: recognized.length,
      aligned,
      rereads: reading.rereads,
      speaks: reading.speaks,
      rows: recognized.map((item) => ({
        id: item.sample.id,
        pass: item.score.pass,
        text: item.score.got,
        raw: item.text,
        confidence: item.confidence,
        similarity: item.score.similarity,
        accuracy: item.accuracy,
        box: item.box,
      })),
    };
    client.terminate();
    setStatus('測試完成');
  } catch (err) {
    const message = err?.message || String(err);
    window.__RESULT = { ok: false, error: message, stack: err?.stack || '' };
    setStatus(`測試失敗：${message}`);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', () => {
  runSuite();
});

const auto = new URLSearchParams(location.search).has('auto');
if ('serviceWorker' in navigator && !auto) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

if (auto) runSuite();
