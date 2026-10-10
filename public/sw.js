/* Service worker mínimo: permite exibir notificações de mensagens no Android
 * (o Chrome para Android exige um service worker para notificações) e,
 * ao tocar na notificação, volta para a página da operação.
 * Não faz cache nem rastreamento em segundo plano. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (ev) { ev.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf('/civil.html') !== -1 && 'focus' in lista[i]) return lista[i].focus();
      }
      return self.clients.openWindow ? self.clients.openWindow('civil.html') : null;
    })
  );
});
