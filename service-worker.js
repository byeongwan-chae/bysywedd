const CACHE_NAME = 'wedding-app-v2';
const CACHE_URLS = [
  '.',
  './index.html',
  './manifest.json'
];

// ── Install: 핵심 파일 캐시 후 즉시 활성화 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting(); // waiting 없이 바로 activate로 진입
});

// ── Activate: 구 버전 캐시 전부 삭제 후 즉시 제어권 확보 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // 열려 있는 탭 즉시 장악
  );
});

// ── Fetch: Network-First 전략 ──
// Firebase / CDN은 항상 네트워크, 앱 파일은 네트워크 우선 → 실패 시 캐시
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Firebase / CDN 요청은 캐시 없이 네트워크만
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('gstatic.com') ||
      url.includes('cdnjs.cloudflare.com')) {
    return; // 기본 fetch 동작에 맡김
  }

  // 앱 파일: 네트워크 우선, 실패 시 캐시로 폴백
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 성공하면 캐시도 업데이트
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)) // 오프라인 시 캐시 사용
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

// 백그라운드 푸시 수신 핸들러 (FCM onBackgroundMessage에 해당)
// FCM은 Web Push Protocol을 통해 이 push 이벤트로 메시지를 전달합니다
self.addEventListener('push', event => {
  const payload = event.data ? event.data.json() : {};
  // FCM 페이로드 형식: { notification: { title, body }, data: {...} }
  const notif = payload.notification || {};
  const title = notif.title || payload.title || '우리의 결혼 준비';
  const options = {
    body: notif.body || payload.body || '',
    icon: notif.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: (payload.data && payload.data.tag) || 'wedding-notification',
    data: payload.data || {}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

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
