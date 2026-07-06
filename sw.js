const CACHE_NAME = 'fincas-serrano-v36';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=13',
  '/app.js',
  '/manifest.json',
  '/favicon.png?v=8',
  '/icon-512.png?v=8',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // No interceptar peticiones de la función serverless para evitar conflictos
  if (e.request.url.includes('/api/sync') || e.request.url.includes('/.netlify/functions/')) {
    return;
  }
  
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    })
  );
});
