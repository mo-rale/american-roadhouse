// Service worker: shows a notification when the server sends a push (a new order, a new inquiry, an edited order)
// and puts the number of things waiting on the app icon. It does not cache pages, so the site always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  const tasks = [self.registration.showNotification(d.title || 'American Roadhouse', {
    body: d.body || '',
    icon: '/assets/brand/icon-192.png',
    badge: '/assets/brand/badge-96.png',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    vibrate: [140, 70, 140],
    data: { url: d.url || '/' },
  })];
  if (typeof d.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    tasks.push(d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.split('#')[0] === target.split('#')[0] && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
