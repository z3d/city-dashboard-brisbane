// Service Worker for City Dashboard
// Network-first strategy: try network, fall back to cached copy
// Ensures the app loads even when offline (especially in standalone/home-screen mode)

var CACHE_NAME = 'city-dashboard-v1';

self.addEventListener('install', function(event) {
  // Precache the page immediately so it's available offline from the start
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.add('/');
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) {
          return name !== CACHE_NAME;
        }).map(function(name) {
          return caches.delete(name);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var request = event.request;

  // Only handle same-origin navigation/HTML requests
  if (request.mode !== 'navigate' && !(request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').indexOf('text/html') !== -1)) {
    return;
  }

  event.respondWith(
    fetch(request).then(function(response) {
      // Got a good response — update the cache
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put('/', clone);
        });
      }
      return response;
    }).catch(function() {
      // Network failed — serve from cache
      return caches.match('/').then(function(cached) {
        return cached || new Response('<!DOCTYPE html><html><body style="background:#1a1a2e;color:#e4e4e4;font-family:sans-serif;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Offline</h2><p>Waiting for network&hellip;</p><button onclick="location.reload()" style="margin-top:20px;padding:12px 32px;font-size:18px;background:rgba(255,255,255,0.15);color:#e4e4e4;border:1px solid rgba(255,255,255,0.3);border-radius:8px;cursor:pointer;-webkit-appearance:none">Retry</button></div></body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' }
        });
      });
    })
  );
});
