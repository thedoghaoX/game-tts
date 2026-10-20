// Offline pipeline check, then PP-OCRv5 in headless Chrome on /samples.
// Usage: npm test

import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { toTraditional } from '../js/chinese.js';
import {
  LIMITS,
  changeScore,
  charAccuracy,
  coverSourceRect,
  createSession,
  cropRGBA,
  decideSpeak,
  detectDialogBox,
  downscaleGray,
  gateFrame,
  meanLuma,
  normalizedSimilarity,
  preprocessRGBA,
  sourceRectToCoverPercent,
  simulateReading,
  stabilizeDialogBox,
} from '../js/pipeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const PHOTO_GT = '我很期待大家的萬聖節裝扮！請各位務必要在31號當天以前準備好恐怖的服裝跟飾品喔！';

function assert(cond, message) {
  if (!cond) failures.push(message);
}

function readPNG(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function fill(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function paintBox(textShift) {
  const width = 220;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 18;
    data[i + 1] = 40;
    data[i + 2] = 28;
    data[i + 3] = 255;
  }
  for (let y = 40; y < 90; y++) {
    for (let x = 30; x < 190; x++) {
      const p = (y * width + x) * 4;
      data[p] = 245;
      data[p + 1] = 245;
      data[p + 2] = 240;
    }
  }
  const x0 = 50 + textShift;
  for (let y = 58; y < 72; y++) {
    for (let x = x0; x < x0 + 28; x++) {
      const p = (y * width + x) * 4;
      data[p] = 20;
      data[p + 1] = 20;
      data[p + 2] = 20;
    }
  }
  return { width, height, data };
}

function unitTests() {
  assert(normalizedSimilarity('耀西發現了一本神奇的書', '耀西發現了一本神奇的書') === 1, 'identical similarity');
  const almost = normalizedSimilarity('耀西發現了一本神奇的書', '耀西發現了一本神奇的畫');
  assert(almost > 0.8, `one-character edit should count as the same line, got ${almost}`);
  assert(normalizedSimilarity('耀西發現了一本神奇的書', '這座島上住著許多奇妙的生物') < 0.8, 'different lines');

  const session = createSession();
  const first = decideSpeak(session, '耀西發現了一本神奇的書', 90);
  const repeat = decideSpeak(session, '耀西發現了一本神奇的書', 90);
  const near = decideSpeak(session, '耀西發現了一本神奇的畫', 90);
  const next = decideSpeak(session, '這座島上住著許多奇妙的生物', 88);
  const garbage = decideSpeak(session, '€2ir', 80);
  const unsure = decideSpeak(session, '耀西找到出口了', 20);
  assert(first.speak && first.reason === 'new', 'first line is spoken');
  assert(!repeat.speak && repeat.reason === 'duplicate', 'exact repeat skipped');
  assert(!near.speak && near.reason === 'duplicate', 'similar line skipped');
  assert(next.speak, 'new line spoken');
  assert(!garbage.speak && garbage.reason === 'no-text', 'non-Chinese skipped');
  assert(!unsure.speak && unsure.reason === 'low-confidence', 'low confidence skipped');

  const converted = toTraditional('我很期待大家的萬聖節装扮请各位务必要在31號当天以前準備好恐怖的服装跟饰品喔');
  assert(converted.includes('裝扮') && converted.includes('請各位') && converted.includes('務必要'), `opencc cn->tw ${converted}`);
  assert(converted.includes('當天') && converted.includes('服裝') && converted.includes('飾品'), `opencc leftovers ${converted}`);
  assert(toTraditional(PHOTO_GT) === PHOTO_GT, 'traditional ground truth is unchanged by cn->tw');
  const acc = charAccuracy(converted, PHOTO_GT);
  assert(acc >= 0.8, `opencc string accuracy ${acc}`);

  const dark = fill(40, 20, [12, 16, 24]);
  for (let y = 6; y < 14; y++) {
    for (let x = 8; x < 28; x++) {
      const p = (y * 40 + x) * 4;
      dark.data[p] = 250;
      dark.data[p + 1] = 245;
      dark.data[p + 2] = 230;
    }
  }
  const prepared = preprocessRGBA(dark.data, dark.width, dark.height, { scale: 2, maxWidth: 200 });
  assert(prepared.width === 80 && prepared.height === 40, `upscale size ${prepared.width}x${prepared.height}`);
  const center = (20 * prepared.width + 30) * 4;
  const corner = 0;
  assert(prepared.data[center] < 40, 'light glyph becomes black text');
  assert(prepared.data[corner] > 200, 'dark background becomes white');

  const flat = downscaleGray(fill(32, 16, [10, 10, 10]).data, 32, 16, 8, 4);
  const bright = downscaleGray(fill(32, 16, [200, 200, 200]).data, 32, 16, 8, 4);
  assert(changeScore(flat, flat).diff === 0, 'identical frames have zero diff');
  assert(changeScore(flat, bright).diff > LIMITS.CHANGE_THRESHOLD, 'solid change exceeds threshold');
  const noisy = new Uint8Array(flat);
  for (let i = 0; i < noisy.length; i += 2) noisy[i] = Math.min(255, noisy[i] + 3);
  assert(changeScore(flat, noisy).diff <= LIMITS.CHANGE_THRESHOLD, 'small noise stays under the threshold');

  const gate = createSession();
  const t0 = gateFrame(gate, flat, 0);
  assert(t0.reason === 'baseline' && !t0.runOcr, 'first frame is baseline');
  const t1 = gateFrame(gate, flat, 500);
  assert(t1.reason === 'settling' && !t1.runOcr, 'one stable frame is not enough');
  const t2 = gateFrame(gate, flat, 1000);
  assert(t2.runOcr && t2.reason === 'stable-change', 'two stable frames run OCR');
  const t3 = gateFrame(gate, flat, 2000);
  assert(!t3.runOcr && t3.reason === 'unchanged', 'unchanged frame skips OCR');
  const move = gateFrame(gate, bright, 1100);
  assert(move.reason === 'changing' && !move.runOcr, 'big diff waits');
  const settling = gateFrame(gate, bright, 1400);
  assert(settling.reason === 'settling' && !settling.runOcr, 'new text needs a second stable frame');
  const settled = gateFrame(gate, bright, 1700);
  assert(settled.reason === 'throttle' && !settled.runOcr, 'OCR is limited to about once a second');
  const later = gateFrame(gate, bright, 2100);
  assert(later.runOcr, 'OCR runs again after the interval once the new frame is stable');

  const jitter = createSession();
  gateFrame(jitter, flat, 0);
  gateFrame(jitter, bright, 400);
  gateFrame(jitter, flat, 800);
  const stillMoving = gateFrame(jitter, bright, 5000);
  assert(!stillMoving.runOcr, 'flicker never becomes stable');

  const full = coverSourceRect(1920, 1080, 1024, 768, { x: 0, y: 0, w: 100, h: 100 });
  assert(full.sx > 0 && full.sy === 0, 'cover crop drops the hidden sides of a wider video');
  assert(full.sx + full.sw <= 1920, 'source rect stays inside the frame');
  const bottom = coverSourceRect(1920, 1080, 1024, 768, { x: 10, y: 64, w: 80, h: 28 });
  assert(bottom.sy > full.sh * 0.5, 'default crop maps to the lower part of the visible frame');
  const roundTrip = sourceRectToCoverPercent(1920, 1080, 1024, 768, bottom);
  const back = coverSourceRect(1920, 1080, 1024, 768, roundTrip);
  assert(Math.abs(back.sx - bottom.sx) <= 2 && Math.abs(back.sy - bottom.sy) <= 2, 'cover mapping round-trips');

  const before = paintBox(0);
  const after = paintBox(70);
  const fullDiff = changeScore(
    downscaleGray(before.data, before.width, before.height),
    downscaleGray(after.data, after.width, after.height),
  ).diff;
  const boxA = detectDialogBox(before.data, before.width, before.height);
  const boxB = detectDialogBox(after.data, after.width, after.height);
  assert(boxA && boxB, 'synthetic white dialog is found');
  const cropA = cropRGBA(before.data, before.width, before.height, boxA);
  const cropB = cropRGBA(after.data, after.width, after.height, boxB);
  const cropDiff = changeScore(
    downscaleGray(cropA.data, cropA.width, cropA.height),
    downscaleGray(cropB.data, cropB.width, cropB.height),
  ).diff;
  console.log(`dialog change full ${fullDiff.toFixed(1)}% crop ${cropDiff.toFixed(1)}%`);
  assert(cropDiff > fullDiff, 'change detection on the dialog is stronger than on the whole frame');
  assert(cropDiff > LIMITS.CHANGE_THRESHOLD, `dialog crop should exceed the OCR threshold, diff ${cropDiff}`);
  const held = stabilizeDialogBox(boxA, { ...boxA, x: boxA.x + 1 });
  assert(held.x === boxA.x, 'a one-pixel nudge keeps the previous box');

  const photo = jpeg.decode(fs.readFileSync(path.join(root, 'samples/ipad-tv-dialog.jpg')), {
    useTArray: true,
    formatAsRGBA: true,
  });
  const photoBox = detectDialogBox(photo.data, photo.width, photo.height);
  assert(photoBox, 'iPad photo dialog box was not found');
  if (photoBox) {
    const ratio = (photoBox.w * photoBox.h) / (photo.width * photo.height);
    const cropped = cropRGBA(photo.data, photo.width, photo.height, photoBox);
    const luma = meanLuma(cropped.data, cropped.width, cropped.height);
    console.log(`photo box ${photoBox.x},${photoBox.y} ${photoBox.w}x${photoBox.h} ratio ${ratio.toFixed(3)} luma ${luma.toFixed(1)}`);
    assert(ratio > 0.02 && ratio < 0.25, `photo dialog area ratio ${ratio}`);
    assert(photoBox.w / photoBox.h > 1.7 && photoBox.w / photoBox.h < 6.5, 'photo dialog aspect');
    assert(luma > 140, `photo dialog should be the bright box, luma ${luma}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples/manifest.json'), 'utf8'));
  const byFile = new Map(manifest.samples.filter((sample) => sample.file.endsWith('.png')).map((sample) => [sample.id, readPNG(path.join(root, 'samples', sample.file))]));
  const speckleDiff = changeScore(
    downscaleGray(byFile.get('a').data, byFile.get('a').width, byFile.get('a').height),
    downscaleGray(byFile.get('a-speckle').data, byFile.get('a-speckle').width, byFile.get('a-speckle').height),
  ).diff;
  console.log('speckle diff', speckleDiff.toFixed(2));
  assert(speckleDiff <= LIMITS.CHANGE_THRESHOLD, `speckle should stay under the OCR threshold, diff ${speckleDiff}`);

  const shots = manifest.sequence.map((id) => {
    const image = byFile.get(id);
    const sample = manifest.samples.find((item) => item.id === id);
    return {
      id,
      gray: downscaleGray(image.data, image.width, image.height),
      text: sample.text,
      confidence: 90,
    };
  });
  const reading = simulateReading(shots);
  const aligned = reading.speaks.length === manifest.expectedSpeaks.length
    && reading.speaks.every((spoken, index) => normalizedSimilarity(spoken, manifest.expectedSpeaks[index]) > LIMITS.SIM_THRESHOLD);
  assert(reading.rereads === 0, `reread count ${reading.rereads}`);
  assert(aligned, `speak sequence ${JSON.stringify(reading.speaks)}`);
}

function contentType(file) {
  const ext = path.extname(file);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.tar') return 'application/octet-stream';
  return 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname);
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function listenForPort(child) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`chrome did not open a debugging port\n${buffered}`)), 20000);
    const onData = (chunk) => {
      buffered += chunk.toString();
      const match = buffered.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)\//);
      if (match) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function chromeOcr(pageUrl) {
  const profile = fs.mkdtempSync('/tmp/game-tts-chrome-');
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const portPromise = listenForPort(chrome);
  chrome.stdout.on('data', () => {});
  const debugPort = await portPromise;
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page) throw new Error(`no chrome page in ${JSON.stringify(list)}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('devtools websocket failed')));
  });
  // Runtime.enable is sent after the helper below is defined.
  let nextId = 0;
  const waiters = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      console.error('browser exception:', msg.params?.exceptionDetails?.text, msg.params?.exceptionDetails?.exception?.description);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args || []).map((arg) => arg.value || arg.description || '').join(' ');
      if (text) console.log('console:', text);
    }
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  });
  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await send('Runtime.enable');
  const deadline = Date.now() + 180000;
  let result = null;
  let lastLog = '';
  while (Date.now() < deadline) {
    const reply = await send('Runtime.evaluate', {
      expression: 'window.__RESULT || null',
      returnByValue: true,
    });
    const value = reply.result?.result?.value;
    if (value) {
      result = value;
      break;
    }
    const status = await send('Runtime.evaluate', {
      expression: 'document.getElementById("status")?.textContent || ""',
      returnByValue: true,
    });
    const text = status.result?.result?.value || '';
    if (text && text !== lastLog) {
      console.log('browser:', text);
      lastLog = text;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  ws.close();
  chrome.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    console.warn('profile cleanup:', err.message);
  }
  if (!result) throw new Error('browser OCR timed out');
  return result;
}

unitTests();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('unit tests passed');

const server = await startServer();
const port = server.address().port;
try {
  const result = await chromeOcr(`http://127.0.0.1:${port}/test.html?auto=1`);
  if (!result.ok) {
    console.error(result.error || result);
    if (result.stack) console.error(result.stack);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  assert(result.provider === 'wasm', `provider ${result.provider}`);
  const photo = result.rows.find((row) => row.id === 'ipad-tv');
  assert(photo, 'missing ipad-tv OCR row');
  if (photo) {
    console.log(`photo accuracy ${(photo.accuracy * 100).toFixed(1)}%`);
    console.log(photo.text);
    assert(photo.accuracy >= 0.8, `char accuracy ${photo.accuracy} for "${photo.text}"`);
    assert(photo.pass, 'photo row did not pass');
    const spoken = decideSpeak(createSession(), photo.text, photo.confidence);
    assert(spoken.speak, `photo text should be read aloud, ${spoken.reason}`);
  }
  for (const row of result.rows) {
    if (row.id === 'ipad-tv') continue;
    assert(row.pass, `${row.id} accuracy failed: got "${row.text}"`);
  }
  assert(result.rereads === 0, `rereads ${result.rereads}`);
  assert(result.aligned, `speak sequence ${JSON.stringify(result.speaks)}`);
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  server.close();
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('offline sample test passed');
