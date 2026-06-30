// Firebase Messaging 전용 서비스 워커
// FCM이 백그라운드 푸시 메시지를 처리하기 위해 필요한 파일입니다.
//
// 사용 방법 (현재 앱은 service-worker.js를 메인 SW로 사용 중):
//   현재 index.html에서 getToken() 호출 시 serviceWorkerRegistration 파라미터로
//   service-worker.js를 직접 지정하고 있으므로, 이 파일은 자동 등록되지 않습니다.
//   service-worker.js 대신 이 파일을 FCM SW로 사용하려면 getToken() 호출에서
//   serviceWorkerRegistration 옵션을 제거하면 FCM이 이 파일을 자동으로 등록합니다.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyC6UPuWD-YpBlEpa1iHrhAr0VLraq0SpjA",
  authDomain: "bwsywedd.firebaseapp.com",
  projectId: "bwsywedd",
  storageBucket: "bwsywedd.firebasestorage.app",
  messagingSenderId: "1013025075511",
  appId: "1:1013025075511:web:d7fc71edb15dddc740aab2"
});

const messaging = firebase.messaging();

// 백그라운드 FCM 메시지 수신 핸들러
// 앱이 백그라운드이거나 닫혀 있을 때 FCM 메시지를 수신하면 이 핸들러가 호출됩니다
messaging.onBackgroundMessage(payload => {
  const notif = payload.notification || {};
  const title = notif.title || '우리의 결혼 준비';
  const options = {
    body: notif.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: (payload.data && payload.data.tag) || 'wedding-notification',
    data: payload.data || {}
  };
  return self.registration.showNotification(title, options);
});
