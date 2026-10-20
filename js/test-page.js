import {
  LIMITS,
  downscaleGray,
  preprocessRGBA,
  scoreReading,
  simulateReading,
  normalizedSimilarity,
} from './pipeline.js';
import { createChiTraWorker } from './ocr.js';

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

function preparedCanvas(imageData) {
  const prepared = preprocessRGBA(imageData.data, imageData.width, imageData.height);
  const canvas = document.createElement('canvas');
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  canvas.getContext('2d').putImageData(new ImageData(prepared.data, prepared.width, prepared.height), 0, 0);
  return canvas;
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  summaryEl.textContent = '';
  tableEl.innerHTML = '';
  sequenceEl.innerHTML = '';
  try {
    setStatus('讀取 samples/manifest.json …');
    const manifest = await (await fetch('./samples/manifest.json')).json();
    setStatus('載入繁中字庫（第一次較慢，之後走快取）…');
    const worker = await createChiTraWorker({
      logger: (message) => {
        if (message.status && message.status.includes('language')) {
          const pct = message.progress != null ? ` ${Math.round(message.progress * 100)}%` : '';
          setStatus(`${message.status}${pct}`);
        }
      },
    });

    const recognized = [];
    for (const sample of manifest.samples) {
      setStatus(`辨識 ${sample.file} …`);
      const image = await loadImageData(`./samples/${sample.file}`);
      const result = await worker.recognize(preparedCanvas(image));
      const text = result?.data?.text || '';
      const confidence = Number(result?.data?.confidence ?? 0);
      const score = scoreReading(sample.text, text, confidence);
      recognized.push({ sample, text, confidence, score, image });
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${sample.id}</td>
        <td>${escapeHtml(sample.text || '（無字）')}</td>
        <td>${escapeHtml(score.got || '（空）')}</td>
        <td>${sample.text ? score.similarity.toFixed(2) : '—'}</td>
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

    summaryEl.textContent = [
      `準確率 ${passed}/${recognized.length}（${Math.round(accuracy * 100)}%）`,
      `重唸次數 ${reading.rereads}`,
      `辨識次數 ${reading.ocrRuns}`,
      `唸出：${reading.speaks.join(' ／ ') || '（沒有）'}`,
      aligned ? '朗讀順序與預期一致' : '朗讀順序和預期不同',
    ].join('\n');

    reading.events.forEach((event) => {
      const line = document.createElement('li');
      line.textContent = `${event.id}：${event.reason}${event.text ? `「${event.text}」` : ''}`;
      sequenceEl.appendChild(line);
    });

    await worker.terminate();
    setStatus('測試完成');
  } catch (err) {
    setStatus(`測試失敗：${err?.message || err}`);
  } finally {
    runBtn.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
