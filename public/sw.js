const CACHE_VERSION = 'v' + Date.now();
const CACHE_NAME = 'sann-music-' + CACHE_VERSION;

// Install — skip waiting langsung aktif
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate — hapus semua cache lama
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name.startsWith('sann-music-') && name !== CACHE_NAME)
                    .map(name => {
                        console.log('[SW] Hapus cache lama:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => clients.claim())
    );
});

// Fetch — network first, cache sebagai fallback
self.addEventListener('fetch', (event) => {
    // Jangan cache API calls
    if (event.request.url.includes('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache response terbaru
                if (response && response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Offline fallback dari cache
                return caches.match(event.request);
            })
    );
});
