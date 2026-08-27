// Background message handler for web push notifications.
// This file is intentionally a classic (non-module) script, loaded via
// importScripts - Safari/iOS support for module-type service workers has
// historically been inconsistent, and Firebase's own docs use this pattern
// for exactly that reason.
//
// NOTE: this config must be filled in with the SAME values as
// firebase-config.js. A service worker can't easily import that file (it's
// an ES module, this isn't), so the values are duplicated here on purpose -
// this is standard practice for Firebase web push and is not a secret
// (same as the main app config).
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
});

const messaging = firebase.messaging();

// IMPORTANT: the Cloud Function must send a data-only payload (no top-level
// "notification" field). If it sends "notification", Firebase's SDK
// auto-displays it in the background AND this handler would also fire,
// producing two notifications for the same message. Data-only means this
// is the one and only place a background notification gets built.
messaging.onBackgroundMessage((payload) => {
  const { title, body, url } = payload.data || {};
  if (!title) return;
  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    data: { url: url || "/" },
  });
});

// Tapping a notification should focus/open the relevant page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
