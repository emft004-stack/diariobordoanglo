"use strict";

const CACHE = "diario-bordo-anglo-shell-v3";
const BASE = new URL("./", self.registration.scope);
const SHELL = [
  "",
  "index.html",
  "manifest.webmanifest",
  "styles.css",
  "app.js",
  "icon-192.png",
  "icon-512.png"
].map(path => new URL(path, BASE).href);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.indexOf("diario-bordo-anglo-shell-") === 0 && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin
      || url.pathname.indexOf(new URL(BASE).pathname) !== 0) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(new URL("index.html", BASE).href))
    );
    return;
  }
  if (SHELL.indexOf(url.href) >= 0) {
    event.respondWith(
      caches.match(request).then(response => response || fetch(request))
    );
  }
});
