// Cache the app shell and the Tesseract chi_tra payload.
// Traineddata is also written to IndexedDB by Tesseract (cacheMethod: write).

const CACHE = 'game-tts-v3-1';

const SHELL = [
  './',
  './index.html',
  './test.html',
  './js/pipeline.js',
  './js/ocr.js',
  './js/app.js',
  './js/test-page.js',
  './samples/manifest.json',
];

function isModelRequest(url) {
  if (url.hostname !== 'cdn.jsdelivr.net') return false;
  return (
    url.pathname.includes('/tesseract.js@')
    || url.pathname.includes('/tesseract.js-core@')
    || url.pathname.includes('/@tesseract.js-data/chi_tra/')
  );
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
