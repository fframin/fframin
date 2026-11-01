// オフライン対応と「共有」受け取り（Web Share Target）用の Service Worker
const CACHE = 'buzz-recipes-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/db.js',
  './js/image.js',
  './js/ocr.js',
  './js/recipe-text.js',
  './js/card.js',
  './js/ai.js',
  './js/importer.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// js/db.js と同じスキーマ
const DB_NAME = 'buzz-recipes';
const DB_VERSION = 1;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recipes')) {
        db.createObjectStore('recipes', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function handleShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    const files = form.getAll('images').filter((f) => f && typeof f !== 'string' && f.size > 0);
    const item = {
      id: 'shared',
      title: String(form.get('title') || ''),
      text: String(form.get('text') || ''),
      url: String(form.get('url') || ''),
      files,
    };
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction('inbox', 'readwrite');
      t.objectStore('inbox').put(item);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    return Response.redirect(new URL('./#/new?shared=1', scope).href, 303);
  } catch (err) {
    return Response.redirect(new URL('./#/new', scope).href, 303);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // ネット優先・失敗時はキャッシュ（更新がすぐ反映され、オフラインでも動く）
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});
