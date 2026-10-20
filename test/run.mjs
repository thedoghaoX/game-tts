// Offline pipeline check: unit tests, then OCR on /samples.
// Usage: npm test

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import {
  LIMITS,
  changeScore,
  coverSourceRect,
  createSession,
  decideSpeak,
  downscaleGray,
  gateFrame,
  normalizedSimilarity,
  preprocessRGBA,
  scoreReading,
  simulateReading,
} from '../js/pipeline.js';
import { TESSACT_PARAMS } from '../js/ocr.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function assert(cond, message) {
  if (!cond) failures.push(message);
}

function readPNG(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function toPNG(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
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
}

async function ocrSamples() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples/manifest.json'), 'utf8'));
  const worker = await createWorker('chi_tra', 1, {
    cachePath: path.join(root, '.cache/tess'),
    cacheMethod: 'write',
    gzip: true,
    logger: (message) => {
      if (message.status === 'loading language traineddata') {
        process.stdout.write(`\rtraineddata ${Math.round((message.progress || 0) * 100)}%   `);
      }
    },
  });
  await worker.setParameters(TESSACT_PARAMS);

  const recognized = [];
  for (const sample of manifest.samples) {
    const image = readPNG(path.join(root, 'samples', sample.file));
    const prepared = preprocessRGBA(image.data, image.width, image.height);
    const result = await worker.recognize(toPNG(prepared));
    const text = result?.data?.text || '';
    const confidence = Number(result?.data?.confidence ?? 0);
    const score = scoreReading(sample.text, text, confidence);
    recognized.push({ sample, text, confidence, score, image });
    const sim = sample.text ? score.similarity.toFixed(2) : '—';
    console.log(`\n${sample.id}\t${score.pass ? 'PASS' : 'FAIL'}\tsim=${sim}\tconf=${Math.round(confidence)}\t${score.got}`);
    assert(score.pass, `${sample.id} accuracy failed: got "${score.got}" expected "${sample.text}"`);
  }

  const byId = new Map(recognized.map((item) => [item.sample.id, item]));
  const shots = manifest.sequence.map((id) => {
    const item = byId.get(id);
    return {
      id,
      gray: downscaleGray(item.image.data, item.image.width, item.image.height),
      text: item.text,
      confidence: item.confidence,
    };
  });
  const reading = simulateReading(shots);
  console.log('\nspeaks:', reading.speaks);
  console.log('ocr runs:', reading.ocrRuns, 'rereads:', reading.rereads);
  reading.events.forEach((event) => {
    console.log(`  ${event.id}\t${event.reason}\t${event.text || ''}`);
  });

  const expected = manifest.expectedSpeaks;
  const aligned = reading.speaks.length === expected.length
    && reading.speaks.every((spoken, index) => normalizedSimilarity(spoken, expected[index]) > LIMITS.SIM_THRESHOLD);
  assert(reading.rereads === 0, `reread count ${reading.rereads}`);
  assert(aligned, `speak sequence ${JSON.stringify(reading.speaks)} != ${JSON.stringify(expected)}`);

  const speckle = byId.get('a-speckle');
  const speckleShot = simulateReading([
    { id: 'a', gray: downscaleGray(byId.get('a').image.data, byId.get('a').image.width, byId.get('a').image.height), text: byId.get('a').text, confidence: 90 },
    { id: 'a-speckle', gray: downscaleGray(speckle.image.data, speckle.image.width, speckle.image.height), text: speckle.text, confidence: 90 },
  ]);
  const speckleDiff = changeScore(
    downscaleGray(byId.get('a').image.data, byId.get('a').image.width, byId.get('a').image.height),
    downscaleGray(speckle.image.data, speckle.image.width, speckle.image.height),
  ).diff;
  console.log('speckle diff', speckleDiff.toFixed(2), 'shots', speckleShot.events.map((event) => event.reason).join(','));
  assert(speckleDiff <= LIMITS.CHANGE_THRESHOLD, `speckle should stay under the OCR threshold, diff ${speckleDiff}`);

  await worker.terminate();
  const passed = recognized.filter((item) => item.score.pass).length;
  console.log(`\naccuracy ${passed}/${recognized.length}`);
  console.log(`rereads ${reading.rereads}`);
}

unitTests();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('unit tests passed');

try {
  await ocrSamples();
} catch (err) {
  console.error(err);
  process.exit(1);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('offline sample test passed');
