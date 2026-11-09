// Service Worker der FCJJ-App: nur für Push-Mitteilungen (kein Offline-Zwischenspeicher).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { t: "FCJJ", b: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.t || "FC Jeunesse Junglinster", {
    body: m.b || "", tag: m.tag || undefined, icon: "bilder/icon-192.png", badge: "bilder/icon-192.png",
    data: { u: m.u || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const ziel = new URL(e.notification.data?.u || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const offen = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of offen) if (c.url.startsWith(self.registration.scope) && "focus" in c) { await c.navigate(ziel).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(ziel);
  })());
});
