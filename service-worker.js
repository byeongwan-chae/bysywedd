const CACHE_NAME = 'wedding-app-v1';
const CACHE_URLS = [
  '.',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Firebase / CDN 요청은 캐시하지 않음
  const url = event.request.url;
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('gstatic.com') ||
      url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ──────────────────────────────────────────
// 푸시 알림 수신 (FCM 연동 시 활성화)
//
// FCM 연동 방법:
// 1. Firebase 콘솔 > 프로젝트 설정 > 클라우드 메시징에서
//    VAPID 키(웹 푸시 인증서)를 생성하세요.
// 2. index.html에서 getMessaging(), getToken(messaging, {vapidKey: '...'}) 으로
//    FCM 토큰을 발급받아 Firestore에 저장하세요.
// 3. 서버(Cloud Functions 등)에서 해당 토큰으로 pushNotification을 보내세요.
// 4. 아래 push 이벤트 핸들러의 주석을 해제하세요.
// ──────────────────────────────────────────

/*
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '우리의 결혼 준비';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'wedding-notification',
    data: data
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
*/

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('.');
    })
  );
});
