// Minimal service worker — exists mainly to satisfy the "installable"
// requirement for Add to Home Screen on Chrome/Android (iOS Safari doesn't
// require one). Precaches the static app shell so the tool's login screen
// still loads if opened with a flaky connection; everything dynamic
// (Firebase Auth/Firestore calls, the gstatic SDK imports) always goes to
// the network — this is NOT an offline-data app, just an offline-shell one.
const CACHE_NAME = "asante-training-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/tool.js",
  "./js/firebase-config.js",
  "./manifest.json",
  "./icons/training-192.png",
  "./icons/training-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell (so you always get the newest deploy when
// online), falling back to the cached copy only when the network fails.
// Everything else (Firebase, gstatic) is untouched — never intercepted.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---------- Push notifications ----------
// The payload is whatever JSON api/admin/send-push.js sent: { title, body, url }.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Asante & Grove — Training Tool", {
      body: data.body || "You have a new message.",
      icon: "icons/training-192.png",
      badge: "icons/training-192.png",
      data: { url: data.url || "./" }
    })
  );
});

// Opens (or reuses) a window and takes it straight to the deep-linked
// tab/thread from the notification — not just the app's home screen.
// Reuses an already-open tab via navigate() when one exists (avoids
// stacking duplicate tabs); otherwise opens a fresh one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      const existing = clientList.find(c => new URL(c.url).origin === self.location.origin);
      if (existing) {
        if ("navigate" in existing) await existing.navigate(targetUrl).catch(() => {});
        return existing.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
