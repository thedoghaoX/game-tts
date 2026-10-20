// Shared capture, preprocess, frame gate, and speak-dedupe logic.
// No DOM and no network so the iPad page and the offline test use the same code.

export const LIMITS = {
  DIFF_W: 64,
  DIFF_H: 32,
  // Percent of downscaled pixels that must move by more than NOISE_FLOOR.
  // A whole subtitle line on these samples is about 9; speckle stays near 0.
  CHANGE_THRESHOLD: 3,
  NOISE_FLOOR: 18,
  STABLE_FRAMES: 2,
  MIN_OCR_INTERVAL_MS: 1000,
  FRAME_MS: 450,
  MIN_LEN: 2,
  // Skip when normalized similarity is above this. > 0.8 means "same text".
  SIM_THRESHOLD: 0.8,
  CJK_MIN_RATIO: 0.5,
  MIN_CONFIDENCE: 40,
  HISTORY: 8,
  UPSCALE: 2,
  CONTRAST: 1.6,
  MAX_OCR_WIDTH: 1600,
};

export const DEFAULT_CROP = { x: 10, y: 64, w: 80, h: 28 };

export function normalize(text) {
  return (text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[|｜`~^]+/g, '')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b ? [...b].length : 0;
  if (!b) return [...a].length;
  const aa = [...a];
  const bb = [...b];
  let prev = new Uint16Array(bb.length + 1);
  let curr = new Uint16Array(bb.length + 1);
  for (let j = 0; j <= bb.length; j++) prev[j] = j;
  for (let i = 1; i <= aa.length; i++) {
    curr[0] = i;
    const ca = aa[i - 1];
    for (let j = 1; j <= bb.length; j++) {
      const cost = ca === bb[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[bb.length];
}

// 1 - distance / max(length). 1 means identical.
export function normalizedSimilarity(a, b) {
  if (!a || !b) return 0;
  const aa = [...a];
  const bb = [...b];
  const longer = Math.max(aa.length, bb.length);
  if (longer === 0) return 1;
  return (longer - levenshtein(a, b)) / longer;
}

export function cjkRatio(text) {
  if (!text) return 0;
  const chars = [...text];
  let n = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) n += 1;
  }
  return n / chars.length;
}

export function createSession() {
  return {
    prevGray: null,
    pendingChange: false,
    frameStable: 0,
    lastOcrAt: -Infinity,
    spoken: [],
  };
}

function assertSameLength(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    throw new Error('frame buffers must be the same non-empty length');
  }
}

export function meanAbsDiff(a, b) {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// diff is the percent of pixels that moved past the noise floor, so a new
// subtitle counts even when most of the crop is an unchanged background.
export function changeScore(a, b, noiseFloor = LIMITS.NOISE_FLOOR) {
  assertSameLength(a, b);
  let sum = 0;
  let hot = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    sum += delta;
    if (delta >= noiseFloor) hot += 1;
  }
  const hotRatio = hot / a.length;
  return { mean: sum / a.length, hotRatio, diff: hotRatio * 100 };
}

// Box-filter the crop down to a tiny grayscale buffer for cheap change detection.
export function downscaleGray(src, sw, sh, dw = LIMITS.DIFF_W, dh = LIMITS.DIFF_H) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    let y1 = Math.floor(((y + 1) * sh) / dh);
    if (y1 <= y0) y1 = y0 + 1;
    if (y1 > sh) y1 = sh;
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      let x1 = Math.floor(((x + 1) * sw) / dw);
      if (x1 <= x0) x1 = x0 + 1;
      if (x1 > sw) x1 = sw;
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) {
          const i = (row + xx) * 4;
          sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
          n += 1;
        }
      }
      out[y * dw + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

function clampByte(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

export function upscaleBilinear(src, sw, sh, scale) {
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const xMax = sw - 1;
  const yMax = sh - 1;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = sy < 0 ? 0 : Math.min(yMax, Math.floor(sy));
    const y1 = Math.min(yMax, y0 + 1);
    const fy = sy <= 0 ? 0 : sy - y0;
    const fy1 = 1 - fy;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = sx < 0 ? 0 : Math.min(xMax, Math.floor(sx));
      const x1 = Math.min(xMax, x0 + 1);
      const fx = sx <= 0 ? 0 : sx - x0;
      const fx1 = 1 - fx;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      const w00 = fx1 * fy1;
      const w10 = fx * fy1;
      const w01 = fx1 * fy;
      const w11 = fx * fy;
      dst[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      dst[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      dst[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      dst[o + 3] = 255;
    }
  }
  return { data: dst, width: dw, height: dh };
}

function toGray(src) {
  const gray = new Uint8Array(src.length / 4);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  return gray;
}

function applyContrast(gray, factor) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = clampByte((gray[i] - 128) * factor + 128);
  }
  return out;
}

export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let max = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = t;
    }
  }
  return threshold;
}

// Light glyphs on a dark subtitle box become black text on white, which LSTM reads more reliably.
export function binarizeGray(gray) {
  const threshold = otsuThreshold(gray);
  let bright = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > threshold) bright += 1;
  const brightIsText = bright < gray.length / 2;
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const isBright = gray[i] > threshold;
    const isText = brightIsText ? isBright : !isBright;
    out[i] = isText ? 0 : 255;
  }
  return out;
}

export function grayToRGBA(gray, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = gray[i];
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { data, width, height };
}

// grayscale + contrast + upscale + binarize. Upscale runs first so the threshold sees smoother edges.
export function preprocessRGBA(src, width, height, opts = {}) {
  const contrast = opts.contrast ?? LIMITS.CONTRAST;
  let scale = opts.scale ?? LIMITS.UPSCALE;
  const maxWidth = opts.maxWidth ?? LIMITS.MAX_OCR_WIDTH;
  if (width * scale > maxWidth) scale = maxWidth / width;
  if (scale < 1) scale = 1;
  const scaled = upscaleBilinear(src, width, height, scale);
  const contrasted = applyContrast(toGray(scaled.data), contrast);
  const binary = binarizeGray(contrasted);
  return grayToRGBA(binary, scaled.width, scaled.height);
}

/**
 * Compare this frame with the previous one.
 * OCR runs only after a change, once the crop has stayed still for STABLE_FRAMES,
 * and never more often than MIN_OCR_INTERVAL_MS.
 */
export function gateFrame(session, gray, now, opts = {}) {
  const changeThreshold = opts.changeThreshold ?? LIMITS.CHANGE_THRESHOLD;
  const stableFrames = opts.stableFrames ?? LIMITS.STABLE_FRAMES;
  const minInterval = opts.minOcrIntervalMs ?? LIMITS.MIN_OCR_INTERVAL_MS;

  if (!session.prevGray) {
    session.prevGray = gray;
    session.pendingChange = true;
    session.frameStable = 0;
    return { runOcr: false, diff: null, reason: 'baseline' };
  }

  const score = changeScore(session.prevGray, gray);
  const diff = score.diff;
  session.prevGray = gray;

  if (diff > changeThreshold) {
    session.pendingChange = true;
    session.frameStable = 0;
    return { runOcr: false, diff, reason: 'changing' };
  }

  session.frameStable += 1;
  if (!session.pendingChange) {
    return { runOcr: false, diff, reason: 'unchanged' };
  }
  if (session.frameStable < stableFrames) {
    return { runOcr: false, diff, reason: 'settling' };
  }
  if (now - session.lastOcrAt < minInterval) {
    return { runOcr: false, diff, reason: 'throttle' };
  }

  session.pendingChange = false;
  session.lastOcrAt = now;
  return { runOcr: true, diff, reason: 'stable-change' };
}

export function decideSpeak(session, rawText, confidence = 100) {
  const text = normalize(rawText);
  if ([...text].length < LIMITS.MIN_LEN || cjkRatio(text) < LIMITS.CJK_MIN_RATIO) {
    return { speak: false, text, reason: 'no-text' };
  }
  if (confidence < LIMITS.MIN_CONFIDENCE) {
    return { speak: false, text, reason: 'low-confidence' };
  }
  for (const prev of session.spoken) {
    if (normalizedSimilarity(text, prev) > LIMITS.SIM_THRESHOLD) {
      return { speak: false, text, reason: 'duplicate' };
    }
  }
  session.spoken.push(text);
  if (session.spoken.length > LIMITS.HISTORY) session.spoken.shift();
  return { speak: true, text, reason: 'new' };
}

export function countRereads(speaks) {
  let n = 0;
  for (let i = 0; i < speaks.length; i++) {
    for (let j = 0; j < i; j++) {
      if (normalizedSimilarity(speaks[i], speaks[j]) > LIMITS.SIM_THRESHOLD) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

// Map a viewport crop (percent of the <video> element, object-fit: cover) into source pixels.
export function coverSourceRect(videoWidth, videoHeight, elemWidth, elemHeight, crop) {
  const videoAspect = videoWidth / videoHeight;
  const elemAspect = elemWidth / elemHeight;
  let dispW;
  let dispH;
  let offX;
  let offY;
  if (videoAspect > elemAspect) {
    dispH = elemHeight;
    dispW = elemHeight * videoAspect;
    offX = (dispW - elemWidth) / 2;
    offY = 0;
  } else {
    dispW = elemWidth;
    dispH = elemWidth / videoAspect;
    offX = 0;
    offY = (dispH - elemHeight) / 2;
  }
  const scaleX = videoWidth / dispW;
  const scaleY = videoHeight / dispH;
  let sx = ((crop.x / 100) * elemWidth + offX) * scaleX;
  let sy = ((crop.y / 100) * elemHeight + offY) * scaleY;
  let sw = (crop.w / 100) * elemWidth * scaleX;
  let sh = (crop.h / 100) * elemHeight * scaleY;
  if (sx < 0) {
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    sh += sy;
    sy = 0;
  }
  if (sx + sw > videoWidth) sw = videoWidth - sx;
  if (sy + sh > videoHeight) sh = videoHeight - sy;
  return {
    sx: Math.floor(sx),
    sy: Math.floor(sy),
    sw: Math.max(1, Math.floor(sw)),
    sh: Math.max(1, Math.floor(sh)),
  };
}

export function simulateShot(session, gray, now, repeats = 3, interval = LIMITS.FRAME_MS, gateOpts = {}) {
  let runOcr = false;
  let reason = '';
  let diff = null;
  let t = now;
  for (let i = 0; i < repeats; i++) {
    t += interval;
    const gate = gateFrame(session, gray, t, gateOpts);
    reason = gate.reason;
    diff = gate.diff;
    if (gate.runOcr) runOcr = true;
  }
  return { runOcr, now: t, reason, diff };
}

export function simulateReading(shots, opts = {}) {
  const session = createSession();
  const speaks = [];
  const events = [];
  let now = 0;
  let ocrRuns = 0;
  for (const shot of shots) {
    const result = simulateShot(
      session,
      shot.gray,
      now,
      opts.repeats ?? 3,
      opts.interval ?? LIMITS.FRAME_MS,
      opts.gateOpts,
    );
    now = result.now;
    if (result.runOcr) {
      ocrRuns += 1;
      const decision = decideSpeak(session, shot.text, shot.confidence ?? 100);
      events.push({ id: shot.id, ...decision, diff: result.diff });
      if (decision.speak) speaks.push(decision.text);
    } else {
      events.push({ id: shot.id, speak: false, text: '', reason: result.reason, diff: result.diff });
    }
  }
  return { speaks, ocrRuns, events, rereads: countRereads(speaks) };
}

export function scoreReading(expected, ocrText, confidence = 100) {
  const got = normalize(ocrText);
  const exp = normalize(expected);
  if (!exp) {
    const decision = decideSpeak(createSession(), got, confidence);
    return { pass: !decision.speak, similarity: 0, got, reason: decision.reason };
  }
  const similarity = normalizedSimilarity(exp, got);
  return {
    pass: similarity > LIMITS.SIM_THRESHOLD,
    similarity,
    got,
    reason: similarity > LIMITS.SIM_THRESHOLD ? 'match' : 'mismatch',
  };
}

export const GATE_REASON_ZH = {
  baseline: '對準中',
  changing: '畫面變化中',
  settling: '等待畫面穩定',
  unchanged: '畫面沒變，略過辨識',
  throttle: '略過辨識（省電，最多約每秒一次）',
  'stable-change': '辨識中',
};

const PUNCT_RE = /[\p{P}\p{S}]/u;

// Accuracy ignores whitespace (via normalize) and punctuation. Simplified and
// traditional characters stay distinct, so conversion has to happen first.
export function stripForAccuracy(text) {
  return [...normalize(text)].filter((ch) => !PUNCT_RE.test(ch)).join('');
}

export function charAccuracy(got, expected) {
  const a = stripForAccuracy(got);
  const b = stripForAccuracy(expected);
  if (!b) return a ? 0 : 1;
  return 1 - levenshtein(a, b) / [...b].length;
}

export function boxIou(a, b) {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Keep the previous box when the new one barely moved, so change detection
// does not see a shift of the same dialog as a new frame.
export function stabilizeDialogBox(previous, next, minIou = 0.85) {
  if (!next) return null;
  if (!previous) return next;
  if (boxIou(previous, next) >= minIou) return previous;
  return next;
}

function dilateBinary(src, w, h, radius) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    const span = radius * 2 + 1;
    for (let x = 0; x < w + radius; x++) {
      if (x < w) count += src[row + x];
      const drop = x - span;
      if (drop >= 0) count -= src[row + drop];
      const dest = x - radius;
      if (dest >= 0 && dest < w && count > 0) out[row + dest] = 1;
    }
  }
  const vert = new Uint8Array(src.length);
  for (let x = 0; x < w; x++) {
    let count = 0;
    const span = radius * 2 + 1;
    for (let y = 0; y < h + radius; y++) {
      if (y < h) count += out[y * w + x];
      const drop = y - span;
      if (drop >= 0) count -= out[drop * w + x];
      const dest = y - radius;
      if (dest >= 0 && dest < h && count > 0) vert[dest * w + x] = 1;
    }
  }
  return vert;
}

function erodeBinary(src, w, h, radius) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    const span = radius * 2 + 1;
    for (let x = 0; x < w + radius; x++) {
      if (x < w) count += src[row + x];
      const drop = x - span;
      if (drop >= 0) count -= src[row + drop];
      const dest = x - radius;
      if (dest >= 0 && dest < w) {
        const left = Math.max(0, dest - radius);
        const right = Math.min(w - 1, dest + radius);
        if (count === right - left + 1) out[row + dest] = 1;
      }
    }
  }
  const vert = new Uint8Array(src.length);
  for (let x = 0; x < w; x++) {
    let count = 0;
    const span = radius * 2 + 1;
    for (let y = 0; y < h + radius; y++) {
      if (y < h) count += out[y * w + x];
      const drop = y - span;
      if (drop >= 0) count -= out[drop * w + x];
      const dest = y - radius;
      if (dest >= 0 && dest < h) {
        const top = Math.max(0, dest - radius);
        const bottom = Math.min(h - 1, dest + radius);
        if (count === bottom - top + 1) vert[dest * w + x] = 1;
      }
    }
  }
  return vert;
}

/**
 * Find the large bright rounded dialog (white or cream, dark text).
 * Coordinates are pixels of the input image. Returns null when nothing matches.
 */
export function detectDialogBox(src, width, height, opts = {}) {
  if (!src || width < 8 || height < 8) return null;
  const maxSide = opts.maxSide ?? 420;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const luma = new Uint8Array(dw * dh);
  const mask = new Uint8Array(dw * dh);
  const lumaMin = opts.lumaMin ?? 175;
  const satMax = opts.satMax ?? 55;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      const i = (sy * width + sx) * 4;
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const yv = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
      const p = y * dw + x;
      luma[p] = yv;
      if (yv >= lumaMin && mx - mn <= satMax) mask[p] = 1;
    }
  }
  const radius = opts.closeRadius ?? 2;
  const closed = erodeBinary(dilateBinary(mask, dw, dh, radius), dw, dh, radius);
  const seen = new Uint8Array(closed.length);
  const stack = [];
  let best = null;
  const frameArea = dw * dh;
  for (let start = 0; start < closed.length; start++) {
    if (!closed[start] || seen[start]) continue;
    let count = 0;
    let minx = dw;
    let miny = dh;
    let maxx = 0;
    let maxy = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % dw;
      const y = (p / dw) | 0;
      count += 1;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      if (x > 0) {
        const q = p - 1;
        if (closed[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
      if (x + 1 < dw) {
        const q = p + 1;
        if (closed[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
      if (y > 0) {
        const q = p - dw;
        if (closed[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
      if (y + 1 < dh) {
        const q = p + dw;
        if (closed[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    const area = bw * bh;
    if (area < frameArea * 0.008 || area > frameArea * 0.42) continue;
    const fill = count / area;
    const aspect = bw / bh;
    if (fill < 0.5 || aspect < 1.7 || aspect > 6.2) continue;
    let sum = 0;
    let dark = 0;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const v = luma[y * dw + x];
        sum += v;
      }
    }
    const mean = sum / area;
    if (mean < 145) continue;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        if (luma[y * dw + x] < mean - 45) dark += 1;
      }
    }
    const darkRatio = dark / area;
    if (darkRatio < 0.035 || darkRatio > 0.42) continue;
    const score = area * fill * Math.min(darkRatio, 0.22);
    if (!best || score > best.score) {
      best = { minx, miny, maxx, maxy, score };
    }
  }
  if (!best) return null;
  let x0 = best.minx / scale;
  let y0 = best.miny / scale;
  let x1 = (best.maxx + 1) / scale;
  let y1 = (best.maxy + 1) / scale;
  const padX = (x1 - x0) * 0.035;
  const padY = (y1 - y0) * 0.08;
  x0 = Math.max(0, x0 - padX);
  y0 = Math.max(0, y0 - padY);
  x1 = Math.min(width, x1 + padX);
  y1 = Math.min(height, y1 + padY);
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const w = Math.max(1, Math.ceil(x1) - x);
  const h = Math.max(1, Math.ceil(y1) - y);
  return { x, y, w, h, score: best.score };
}

export function cropRGBA(src, width, height, box) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(box.y)));
  const w = Math.max(1, Math.min(width - x, Math.floor(box.w)));
  const h = Math.max(1, Math.min(height - y, Math.floor(box.h)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * width + x) * 4;
    data.set(src.subarray(srcOff, srcOff + w * 4), row * w * 4);
  }
  return { data, width: w, height: h };
}

export function meanLuma(src, width, height) {
  if (!width || !height) return 0;
  let sum = 0;
  const n = width * height;
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }
  return sum / n;
}

// Inverse of coverSourceRect: source pixels -> percent of the <video> element.
export function sourceRectToCoverPercent(videoWidth, videoHeight, elemWidth, elemHeight, rect) {
  const videoAspect = videoWidth / videoHeight;
  const elemAspect = elemWidth / elemHeight;
  let dispW;
  let dispH;
  let offX;
  let offY;
  if (videoAspect > elemAspect) {
    dispH = elemHeight;
    dispW = elemHeight * videoAspect;
    offX = (dispW - elemWidth) / 2;
    offY = 0;
  } else {
    dispW = elemWidth;
    dispH = elemWidth / videoAspect;
    offX = 0;
    offY = (dispH - elemHeight) / 2;
  }
  const scaleX = videoWidth / dispW;
  const scaleY = videoHeight / dispH;
  return {
    x: ((rect.sx / scaleX) - offX) / elemWidth * 100,
    y: ((rect.sy / scaleY) - offY) / elemHeight * 100,
    w: (rect.sw / scaleX) / elemWidth * 100,
    h: (rect.sh / scaleY) / elemHeight * 100,
  };
}
