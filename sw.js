// Service worker: оболочка приложения открывается без интернета.
// Network-first, чтобы обновления приходили сразу, а офлайн — из кэша.
// Запросы к /api/ и к файлам в Vercel Blob не кэшируются здесь
// (скачанные книги хранятся в IndexedDB).
const CACHE = "mybook-v9";
const SHELL = ["./", "./index.html", "./app.js?v=9", "./tags.js", "./vendor/blob-client.js", "./styles.css?v=9", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-180.png"];

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (e) => {
	const req = e.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(CACHE).then((c) => c.put(req, copy));
				}
				return res;
			})
			.catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))),
	);
});
