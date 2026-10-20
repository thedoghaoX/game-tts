// Cache the app shell, the PP-OCRv5 model archives, and the plain WASM runtime.
// Models and ort-wasm-simd-threaded.wasm are cache-first so the iPad only
// downloads them once. The JSEP/WebGPU binary is never requested.

const CACHE = 'game-tts-v4-paddle';

const SHELL = [
  './',
  './index.html',
  './test.html',
  './js/pipeline.js',
  './js/ocr.js',
  './js/app.js',
  './js/test-page.js',
  './js/chinese.js',
  './samples/manifest.json',
  './vendor/opencc/full.js',
];

function isModelRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.includes('/models/') || url.pathname.includes('/vendor/ort/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isModelRequest(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});
