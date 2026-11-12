// My Book — аудиокниги, синхронизированные между устройствами.
//
// Файлы и метаданные хранятся в Vercel Blob (см. api/). Место прослушивания синхронизируется
// между устройствами. Книгу можно скачать на устройство (IndexedDB) и слушать без интернета.

import { readTags } from "./tags.js";
import { uploadPresigned } from "./vendor/blob-client.js";

const SKIP_BACK = 15;
const SKIP_FWD = 30;
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const SLEEP_OPTIONS = [
	{ label: "Выключен", value: 0 },
	{ label: "5 минут", value: 5 },
	{ label: "15 минут", value: 15 },
	{ label: "30 минут", value: 30 },
	{ label: "45 минут", value: 45 },
	{ label: "1 час", value: 60 },
	{ label: "До конца главы", value: "chapter" },
];
// Как часто отправлять место прослушивания на сервер (бережём лимиты Vercel Blob)
const PUSH_WHILE_PLAYING_MS = 5 * 60 * 1000;
const PUSH_MIN_GAP_MS = 15 * 1000;
const REFRESH_MIN_GAP_MS = 2 * 60 * 1000;
const MULTIPART_FROM = 50 * 1024 * 1024;

const LS_PASS = "mybook:password";
const LS_LIB = "mybook:library";
const LS_LAST = "mybook:last";
const lsPosKey = (id) => `mybook:pos:${id}`;

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>';
const SM = 'style="fill:currentColor;stroke:none"';
const ICON_PLAY_SM = ICON_PLAY.replace("<svg ", `<svg ${SM} `);
const ICON_PAUSE_SM = ICON_PAUSE.replace("<svg ", `<svg ${SM} `);
const ICON_DONE = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_DL = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* ======================= Helpers ======================= */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12));
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const baseName = (name) => name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
const extOf = (name) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || "bin").toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const AUDIO_TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac", webm: "audio/webm" };

function fmt(sec) {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	sec = Math.floor(sec);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtLong(sec) {
	sec = Math.max(0, Math.round(sec / 60)) * 60;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (h && m) return `${h} ч ${m} мин`;
	if (h) return `${h} ч`;
	return `${m} мин`;
}

const fmtMb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + " ГБ" : Math.max(1, Math.round(n / 1048576)) + " МБ");

const pluralChapters = (n) => {
	const m10 = n % 10, m100 = n % 100;
	const w = m10 === 1 && m100 !== 11 ? "глава" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "главы" : "глав";
	return `${n} ${w}`;
};

function commonPrefix(names) {
	if (!names.length) return "";
	let p = names[0];
	for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
	return p.replace(/[\s\-_.,(\[#№]*\d*[\s\-_.,(\[#№]*$/u, "").trim();
}

function placeholderCover(title) {
	let h = 0;
	for (const ch of title || "?") h = (h * 31 + ch.codePointAt(0)) % 360;
	const letters = (title || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},60%,45%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360},65%,22%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><text x="150" y="150" dy=".35em" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="110" font-weight="700" fill="rgba(255,255,255,.92)">${esc(letters)}</text></svg>`;
	return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function probeDuration(blob) {
	return new Promise((resolve) => {
		const a = new Audio();
		const url = URL.createObjectURL(blob);
		let done = false;
		const finish = (d) => {
			if (done) return;
			done = true;
			URL.revokeObjectURL(url);
			a.removeAttribute("src");
			resolve(Number.isFinite(d) ? d : 0);
		};
		a.preload = "metadata";
		a.onloadedmetadata = () => finish(a.duration);
		a.onerror = () => finish(0);
		setTimeout(() => finish(0), 15000);
		a.src = url;
	});
}

const lsGet = (k) => {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
};
const lsSet = (k, v) => {
	try {
		v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
	} catch {}
};

/* ======================= IndexedDB: скачанные файлы ======================= */

let dbPromise;
function db() {
	dbPromise ??= new Promise((resolve, reject) => {
		const req = indexedDB.open("mybook-offline", 1);
		req.onupgradeneeded = () => req.result.createObjectStore("files"); // key = URL файла в Blob
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

async function idb(mode, fn) {
	const d = await db();
	return new Promise((resolve, reject) => {
		const tx = d.transaction("files", mode);
		const req = fn(tx.objectStore("files"));
		tx.oncomplete = () => resolve(req?.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const localFiles = new Set(); // URL файлов, которые уже есть на устройстве
const getLocal = (url) => idb("readonly", (s) => s.get(url));
const putLocal = async (url, blob) => {
	await idb("readwrite", (s) => s.put(blob, url));
	localFiles.add(url);
};
const delLocal = async (url) => {
	await idb("readwrite", (s) => s.delete(url));
	localFiles.delete(url);
};
async function loadLocalIndex() {
	try {
		const keys = await idb("readonly", (s) => s.getAllKeys());
		keys.forEach((k) => localFiles.add(k));
	} catch (e) {
		console.warn("IndexedDB недоступна", e);
	}
}

/* ======================= API ======================= */

let password = lsGet(LS_PASS) || "";

class AuthError extends Error {}

async function api(method, body, { keepalive = false } = {}) {
	const res = await fetch("/api/library", {
		method,
		headers: { "x-mybook-password": password, ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
		cache: "no-store",
		keepalive,
	});
	if (res.status === 401) throw new AuthError("unauthorized");
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

async function uploadFile(pathname, blob, contentType, onProgress) {
	const opts = (multipart) => ({
		access: "private",
		handleUploadUrl: "/api/upload",
		headers: { "x-mybook-password": password },
		contentType,
		multipart,
		onUploadProgress: onProgress ? ({ loaded }) => onProgress(loaded) : undefined,
	});
	if (blob.size > MULTIPART_FROM) {
		// большие файлы — частями (с повтором неудачных частей); если не вышло — одним запросом
		try {
			return (await uploadPresigned(pathname, blob, opts(true))).url;
		} catch (e) {
			console.warn("multipart upload failed, retrying as single upload", e);
		}
	}
	return (await uploadPresigned(pathname, blob, opts(false))).url;
}

/* ======================= State ======================= */

let books = []; // [{id,title,author,cover,chapters,createdAt, metaUrl, progressUrl, chapterIndex, position, speed, finished, t}]
let current = null;
let currentUrl = null;
let pendingSeek = null;
let lastLsSave = 0;
let sleep = { mode: 0, endsAt: 0 };
let sleepTick = null;
let seeking = false;
let lastRefresh = 0;
let retriedLinks = false;
const pushTimers = new Map();
const lastPush = new Map();
const downloads = new Map(); // bookId -> { loaded, total, abort }

const totalDuration = (b) => b.chapters.reduce((s, c) => s + (c.duration || 0), 0);
const chapterStart = (b, i) => b.chapters.slice(0, i).reduce((s, c) => s + (c.duration || 0), 0);
const globalPos = (b) => chapterStart(b, b.chapterIndex) + (b.position || 0);
const bookSize = (b) => b.chapters.reduce((s, c) => s + (c.size || 0), 0);
const isDownloaded = (b) => b.chapters.every((c) => localFiles.has(c.url));
const isPlayable = (b) => navigator.onLine || isDownloaded(b);

function readLocalPos(id) {
	try {
		return JSON.parse(lsGet(lsPosKey(id)) || "null");
	} catch {
		return null;
	}
}

function writeLocalPos(b, synced = false) {
	lsSet(lsPosKey(b.id), JSON.stringify({ c: b.chapterIndex, p: b.position, s: b.speed, f: !!b.finished, t: b.t || Date.now(), synced }));
}

function cacheLibrary() {
	const strip = books.map(({ id, title, author, cover, chapters, createdAt, metaUrl, progressUrl }) => ({ id, title, author, cover, chapters, createdAt, metaUrl, progressUrl }));
	lsSet(LS_LIB, JSON.stringify(strip));
}

function hydrate(meta) {
	const b = { chapterIndex: 0, position: 0, speed: 1, finished: false, t: 0, ...meta };
	const local = readLocalPos(b.id);
	if (local) Object.assign(b, { chapterIndex: local.c, position: local.p, speed: local.s || 1, finished: !!local.f, t: local.t });
	b.chapterIndex = Math.min(Math.max(0, b.chapterIndex | 0), b.chapters.length - 1);
	return b;
}

/* ======================= Синхронизация ======================= */

async function refreshLibrary(force = false) {
	if (!password || !navigator.onLine) return updateNetStatus();
	if (!force && Date.now() - lastRefresh < REFRESH_MIN_GAP_MS) return;
	lastRefresh = Date.now();
	$("sync-btn").classList.add("spin");
	try {
		const { books: remote } = await api("GET");
		const prev = new Map(books.map((b) => [b.id, b]));
		const next = [];
		for (const r of remote) {
			const { progress, ...meta } = r;
			const existing = prev.get(r.id);
			const b = existing ? Object.assign(existing, meta) : hydrate(meta);
			b.progressUrl = progress?.url || b.progressUrl || null;
			const local = readLocalPos(b.id);
			const localT = local?.t || 0;
			const isPlayingThis = current?.id === b.id && !audio.paused;
			if (progress && progress.t > localT && !isPlayingThis) {
				// на другом устройстве послушали дальше — берём оттуда
				Object.assign(b, { chapterIndex: Math.min(progress.c, b.chapters.length - 1), position: progress.p, speed: progress.s, finished: progress.f, t: progress.t });
				writeLocalPos(b, true);
				if (current?.id === b.id) await setChapter(b.chapterIndex, b.position);
			} else if (local && !local.synced && localT > (progress?.t || 0)) {
				schedulePush(b, 0);
			}
			next.push(b);
		}
		// книги, удалённые на другом устройстве
		for (const [id, b] of prev) {
			if (!remote.some((r) => r.id === id)) {
				if (current?.id === id) unloadCurrent();
				for (const c of b.chapters) if (localFiles.has(c.url)) await delLocal(c.url).catch(() => {});
			}
		}
		books = next;
		cacheLibrary();
		renderLibrary();
		if (current) {
			current = books.find((b) => b.id === current.id) || null;
			renderPlayerMeta();
			updateMini();
		} else {
			restoreLast();
		}
	} catch (e) {
		if (e instanceof AuthError) return logout();
		console.warn("refresh failed", e);
		lastRefresh = 0;
	} finally {
		$("sync-btn").classList.remove("spin");
		updateNetStatus();
	}
}

function schedulePush(b, delay) {
	if (!b || !password) return;
	clearTimeout(pushTimers.get(b.id));
	const since = Date.now() - (lastPush.get(b.id) || 0);
	const wait = Math.max(delay, PUSH_MIN_GAP_MS - since, 0);
	pushTimers.set(b.id, setTimeout(() => pushProgress(b), wait));
}

async function pushProgress(b, { keepalive = false } = {}) {
	clearTimeout(pushTimers.get(b.id));
	pushTimers.delete(b.id);
	if (!navigator.onLine || !password) return;
	const local = readLocalPos(b.id);
	if (local?.synced) return;
	lastPush.set(b.id, Date.now());
	const sentT = local?.t || b.t || Date.now();
	try {
		const res = await api(
			"POST",
			{ action: "progress", id: b.id, t: sentT, c: b.chapterIndex, p: b.position, s: b.speed, f: b.finished, oldUrl: b.progressUrl },
			{ keepalive },
		);
		b.progressUrl = res.url;
		const now = readLocalPos(b.id);
		// если за время запроса позиция не менялась — помечаем как синхронизированную
		if (now && now.t === sentT) lsSet(lsPosKey(b.id), JSON.stringify({ ...now, synced: true }));
		cacheLibrary();
	} catch (e) {
		if (e instanceof AuthError) return logout();
		console.warn("push failed", e);
	}
}

function flushPushes(keepalive) {
	for (const b of books) {
		const local = readLocalPos(b.id);
		if (local && !local.synced) pushProgress(b, { keepalive });
	}
}

function updateNetStatus() {
	const el = $("net-status");
	if (!navigator.onLine) {
		el.hidden = false;
		el.textContent = "Нет интернета. Доступны только скачанные книги, место прослушивания синхронизируется позже.";
	} else el.hidden = true;
}

/* ======================= Вход ======================= */

function showLogin(message = "") {
	$("login").hidden = false;
	$("library").hidden = true;
	$("player").hidden = true;
	$("mini").hidden = true;
	$("login-error").textContent = message;
	$("login-pass").focus();
}

function logout(message = "Неверный пароль или он был изменён.") {
	password = "";
	lsSet(LS_PASS, null);
	showLogin(message);
}

$("login-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	password = $("login-pass").value;
	$("login-error").textContent = "";
	try {
		await api("GET");
		lsSet(LS_PASS, password);
		$("login").hidden = true;
		$("library").hidden = false;
		$("login-pass").value = "";
		await refreshLibrary(true);
	} catch (err) {
		password = "";
		$("login-error").textContent =
			err instanceof AuthError
				? "Неверный пароль."
				: err.message === "no-password-configured"
					? "На сервере не задан MYBOOK_PASSWORD."
					: err.message === "no-blob-store"
						? "К проекту не подключено хранилище Vercel Blob."
						: "Нет связи с сервером.";
	}
});

/* ======================= Library ======================= */

function sortBooks() {
	books.sort((a, b) => (b.t || b.createdAt) - (a.t || a.createdAt));
}

const coverObjUrls = new Map();
const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
function coverSrc(b) {
	if (!b.cover?.url) return placeholderCover(b.title);
	if (coverObjUrls.has(b.cover.url)) return coverObjUrls.get(b.cover.url);
	if (localFiles.has(b.cover.url)) {
		getLocal(b.cover.url).then((blob) => {
			if (!blob) return;
			coverObjUrls.set(b.cover.url, URL.createObjectURL(blob));
			document.querySelectorAll(`img[data-cover="${CSS.escape(b.cover.url)}"]`).forEach((img) => (img.src = coverObjUrls.get(b.cover.url)));
		});
		return BLANK_IMG; // обложка уже на устройстве — подставится через мгновение
	}
	if (!b.cover.src) return placeholderCover(b.title);
	return b.cover.src || b.cover.url;
}

function setCover(img, b) {
	img.src = coverSrc(b);
	img.dataset.cover = b.cover?.url || "";
	img.onerror = () => {
		img.onerror = null;
		img.src = placeholderCover(b.title);
	};
}

function renderLibrary() {
	sortBooks();
	const list = $("book-list");
	list.innerHTML = "";
	$("empty").hidden = books.length > 0;
	$("add-hint").hidden = books.length > 0;
	for (const b of books) {
		const total = totalDuration(b);
		const pos = globalPos(b);
		const pct = b.finished ? 100 : total ? Math.min(100, (pos / total) * 100) : 0;
		let status;
		if (b.finished) status = "Прослушано";
		else if (pos > 1) status = `Осталось ${fmtLong(total - pos)}`;
		else status = total ? fmtLong(total) : "";
		const dl = downloads.get(b.id);
		const offline = dl
			? `<span class="badge">${ICON_DL} ${Math.floor((dl.loaded / (dl.total || 1)) * 100)}%</span>`
			: isDownloaded(b)
				? `<span class="badge">${ICON_DONE} на устройстве</span>`
				: "";
		const li = document.createElement("li");
		li.innerHTML = `
			<button class="book${current?.id === b.id ? " active" : ""}${isPlayable(b) ? "" : " unavailable"}">
				<img alt="" />
				<span class="book-info">
					<div class="book-title">${esc(b.title)}</div>
					<div class="book-sub">${esc([b.author, b.chapters.length > 1 ? pluralChapters(b.chapters.length) : "", status].filter(Boolean).join(" · "))}</div>
					<div class="book-sub">${offline}</div>
					<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
				</span>
			</button>`;
		setCover(li.querySelector("img"), b);
		li.querySelector("button").onclick = () => openBook(b);
		list.appendChild(li);
	}
	updateStorageInfo();
}

async function updateStorageInfo() {
	if (!navigator.storage?.estimate) return;
	const { usage = 0 } = await navigator.storage.estimate();
	const n = books.filter(isDownloaded).length;
	$("storage").textContent = n ? `Скачано книг: ${n} · занято на устройстве ${fmtMb(usage)}` : "";
}

/* ======================= Загрузка книги на сервер ======================= */

async function importFiles(fileList) {
	const files = [...fileList].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name));
	if (!files.length) return;
	if (!navigator.onLine) return alert("Для загрузки книги нужен интернет.");
	files.sort((a, b) => collator.compare(a.name, b.name));
	navigator.storage?.persist?.().catch(() => {});

	const status = $("import-status");
	status.hidden = false;
	const id = uid();
	const totalBytes = files.reduce((s, f) => s + f.size, 0);
	let doneBytes = 0;
	const show = (text, loaded = 0) => {
		const pct = Math.min(100, ((doneBytes + loaded) / totalBytes) * 100);
		status.innerHTML = `${esc(text)}<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>`;
	};
	const meta = { id, title: "", author: "", cover: null, chapters: [], createdAt: Date.now() };
	let firstTags = null;
	let coverBlob = null;
	const localCopies = [];
	window.addEventListener("beforeunload", warnUnload);
	try {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			show(`Загрузка ${i + 1} из ${files.length}: ${f.name}`);
			const tags = await readTags(f).catch(() => ({}));
			if (!firstTags) firstTags = tags;
			if (!coverBlob && tags.cover) coverBlob = tags.cover;
			if (!meta.author && tags.artist) meta.author = tags.artist;
			const duration = await probeDuration(f);
			const ext = extOf(f.name);
			const type = f.type || AUDIO_TYPES[ext] || "application/octet-stream";
			const url = await uploadFile(`b/${id}/${String(i + 1).padStart(3, "0")}.${ext}`, f, type, (loaded) =>
				show(`Загрузка ${i + 1} из ${files.length}: ${f.name}`, loaded),
			);
			doneBytes += f.size;
			localCopies.push([url, f]);
			meta.chapters.push({ name: files.length > 1 ? tags.title || baseName(f.name) : baseName(f.name), duration, url, size: f.size, type });
		}
		if (coverBlob) {
			const ext = coverBlob.type === "image/png" ? "png" : coverBlob.type === "image/webp" ? "webp" : "jpg";
			const url = await uploadFile(`b/${id}/cover.${ext}`, coverBlob, coverBlob.type || "image/jpeg");
			meta.cover = { url, type: coverBlob.type || "image/jpeg" };
			localCopies.push([url, coverBlob]);
		}
		const names = files.map((f) => baseName(f.name));
		meta.title = firstTags?.album || (files.length === 1 ? firstTags?.title || names[0] : commonPrefix(names) || names[0]) || "Без названия";
		const { url: metaUrl } = await api("POST", { action: "meta", id, meta });
		// на этом устройстве книга сразу доступна офлайн — повторно скачивать не нужно
		for (const [url, blob] of localCopies) await putLocal(url, blob).catch(() => {});
		const book = hydrate({ ...meta, metaUrl, progressUrl: null });
		books.push(book);
		cacheLibrary();
		status.hidden = true;
		renderLibrary();
		if (!current) await loadBook(book, false);
	} catch (err) {
		console.error(err);
		if (err instanceof AuthError) return logout();
		api("POST", { action: "delete", id }).catch(() => {});
		status.textContent = "Не удалось загрузить книгу: " + (err?.message || err);
	} finally {
		window.removeEventListener("beforeunload", warnUnload);
	}
}

function warnUnload(e) {
	e.preventDefault();
	e.returnValue = "";
}

/* ======================= Скачивание для офлайна ======================= */

async function downloadBook(b) {
	if (downloads.has(b.id)) return;
	if (!navigator.onLine) return alert("Для скачивания нужен интернет.");
	navigator.storage?.persist?.().catch(() => {});
	const ctrl = new AbortController();
	const items = [...b.chapters.map((c) => ({ url: c.url, src: c.src || c.url, size: c.size || 0 })), ...(b.cover?.url ? [{ url: b.cover.url, src: b.cover.src || b.cover.url, size: 0 }] : [])].filter(
		(x) => !localFiles.has(x.url),
	);
	const state = { loaded: 0, total: items.reduce((s, x) => s + x.size, 0) || 1, abort: () => ctrl.abort() };
	downloads.set(b.id, state);
	updateDownloadUi();
	let lastUi = 0;
	try {
		for (const item of items) {
			const res = await fetch(item.src, { signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const reader = res.body.getReader();
			const chunks = [];
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				state.loaded += value.length;
				if (Date.now() - lastUi > 400) {
					lastUi = Date.now();
					updateDownloadUi();
				}
			}
			const blob = new Blob(chunks, { type: res.headers.get("content-type") || "" });
			await putLocal(item.url, blob);
		}
	} catch (e) {
		if (e.name !== "AbortError") {
			console.error(e);
			alert(e?.name === "QuotaExceededError" ? "Недостаточно места на устройстве." : "Не удалось скачать книгу. Проверьте интернет и попробуйте ещё раз.");
		}
	} finally {
		downloads.delete(b.id);
		updateDownloadUi();
		renderLibrary();
	}
	if (current === b && isDownloaded(b)) switchToLocal();
}

// Переключить текущую главу с сетевого потока на скачанный файл (без потери позиции)
async function switchToLocal() {
	if (!current || currentUrl?.startsWith("blob:") || !localFiles.has(current.chapters[current.chapterIndex].url)) return;
	const wasPlaying = !audio.paused;
	saveProgress(true);
	await setChapter(current.chapterIndex, current.position);
	if (wasPlaying) play();
}

async function removeDownload(b) {
	for (const c of b.chapters) if (localFiles.has(c.url)) await delLocal(c.url).catch(() => {});
	if (b.cover?.url && localFiles.has(b.cover.url)) await delLocal(b.cover.url).catch(() => {});
	updateDownloadUi();
	renderLibrary();
}

function updateDownloadUi() {
	if (current) {
		const dl = downloads.get(current.id);
		const btn = $("dl-btn");
		if (dl) {
			$("dl-val").textContent = `${Math.floor((dl.loaded / dl.total) * 100)}%`;
			btn.querySelector("svg").outerHTML = ICON_DL;
			btn.classList.add("on");
		} else if (isDownloaded(current)) {
			$("dl-val").textContent = "Скачано";
			btn.querySelector("svg").outerHTML = ICON_DONE;
			btn.classList.add("on");
		} else {
			$("dl-val").textContent = "Скачать";
			btn.querySelector("svg").outerHTML = ICON_DL;
			btn.classList.remove("on");
		}
	}
	if (!$("library").hidden) {
		// обновим только процент в списке, без полной перерисовки
		const now = Date.now();
		if (!updateDownloadUi.t || now - updateDownloadUi.t > 1000) {
			updateDownloadUi.t = now;
			renderLibrary();
		}
	}
}

function onDownloadButton() {
	if (!current) return;
	const b = current;
	const dl = downloads.get(b.id);
	if (dl) {
		if (confirm("Остановить скачивание?")) dl.abort();
		return;
	}
	if (isDownloaded(b)) {
		const list = el('<div class="opt-list"></div>');
		const info = el(`<p class="hint">Книга сохранена на этом устройстве (${fmtMb(bookSize(b))}) и доступна без интернета.</p>`);
		const rm = el('<button class="opt"><span>Удалить с устройства (останется в облаке)</span></button>');
		rm.onclick = () => {
			closeSheet();
			removeDownload(b);
		};
		list.append(info, rm);
		openSheet("Скачано", list);
		return;
	}
	downloadBook(b);
}

/* ======================= Playback ======================= */

function saveProgress(force = false) {
	if (!current) return;
	const now = Date.now();
	if (pendingSeek == null && audio.src && Number.isFinite(audio.currentTime) && audio.readyState > 0) {
		current.position = audio.currentTime;
	}
	if (force || now - lastLsSave > 1000) {
		lastLsSave = now;
		current.t = now;
		writeLocalPos(current, false);
		lsSet(LS_LAST, current.id);
	}
}

async function setChapter(index, position = 0) {
	const b = current;
	if (!b) return;
	index = Math.max(0, Math.min(b.chapters.length - 1, index));
	const ch = b.chapters[index];
	let src = ch.src || ch.url;
	if (localFiles.has(ch.url)) {
		const blob = await getLocal(ch.url).catch(() => null);
		if (blob) src = URL.createObjectURL(blob);
	}
	if (current !== b) return;
	if (currentUrl?.startsWith("blob:")) URL.revokeObjectURL(currentUrl);
	currentUrl = src;
	b.chapterIndex = index;
	b.position = position;
	pendingSeek = position;
	audio.src = src;
	audio.defaultPlaybackRate = b.speed || 1;
	audio.playbackRate = b.speed || 1;
	audio.load();
	updateChapterUi();
	updateMediaSession();
}

async function loadBook(book, autoplay) {
	if (current && current.id !== book.id) {
		saveProgress(true);
		schedulePush(current, 0);
		audio.pause();
	}
	current = book;
	lsSet(LS_LAST, book.id);
	await setChapter(book.chapterIndex || 0, book.position || 0);
	renderPlayerMeta();
	updateMini();
	if (autoplay) play();
}

function unloadCurrent() {
	audio.pause();
	audio.removeAttribute("src");
	audio.load();
	if (currentUrl?.startsWith("blob:")) URL.revokeObjectURL(currentUrl);
	currentUrl = null;
	current = null;
	lsSet(LS_LAST, null);
	if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
	updateMini();
}

async function openBook(book) {
	if (!isPlayable(book)) return alert("Эта книга не скачана на устройство, а интернета сейчас нет.");
	if (current?.id !== book.id) await loadBook(book, true);
	else if (audio.paused && !book.t) play();
	openPlayer();
}

function play() {
	if (!current) return;
	if (!isPlayable(current)) return alert("Книга не скачана на устройство, а интернета сейчас нет.");
	if (current.finished) {
		current.finished = false;
		if (current.chapterIndex === current.chapters.length - 1 && audio.duration && audio.currentTime >= audio.duration - 1) {
			setChapter(0, 0).then(play);
			return;
		}
	}
	audio.play().catch((e) => console.warn("play()", e));
}

const pause = () => audio.pause();
const toggle = () => (audio.paused ? play() : pause());

async function seekGlobal(t) {
	const b = current;
	if (!b) return;
	const total = totalDuration(b);
	t = Math.max(0, total ? Math.min(t, total - 0.5) : t);
	let i = 0;
	let start = 0;
	while (i < b.chapters.length - 1 && t >= start + (b.chapters[i].duration || 0)) {
		start += b.chapters[i].duration || 0;
		i++;
	}
	const offset = t - start;
	if (i === b.chapterIndex) audio.currentTime = offset;
	else {
		const wasPlaying = !audio.paused;
		await setChapter(i, offset);
		if (wasPlaying) play();
	}
	saveProgress(true);
}

function skip(delta) {
	if (!current) return;
	if (!totalDuration(current)) {
		audio.currentTime = Math.max(0, audio.currentTime + delta);
		return;
	}
	seekGlobal(chapterStart(current, current.chapterIndex) + audio.currentTime + delta);
}

async function gotoChapter(i) {
	if (!current) return;
	const wasPlaying = !audio.paused;
	await setChapter(i, 0);
	if (wasPlaying) play();
	saveProgress(true);
	schedulePush(current, 0);
}

function prevChapter() {
	if (!current) return;
	if (audio.currentTime > 5 || current.chapterIndex === 0) {
		audio.currentTime = 0;
		saveProgress(true);
	} else gotoChapter(current.chapterIndex - 1);
}

function nextChapter() {
	if (current && current.chapterIndex < current.chapters.length - 1) gotoChapter(current.chapterIndex + 1);
}

function setSpeed(s) {
	if (!current) return;
	current.speed = s;
	audio.defaultPlaybackRate = s;
	audio.playbackRate = s;
	updateSpeedUi();
	saveProgress(true);
	schedulePush(current, 0);
}

function stop() {
	pause();
	setSleep(0);
	saveProgress(true);
	closePlayer();
}

/* ======================= Audio events ======================= */

audio.addEventListener("loadedmetadata", () => {
	retriedLinks = false;
	if (!current) return;
	if (pendingSeek != null) {
		const t = Math.min(pendingSeek, Math.max(0, (audio.duration || Infinity) - 1));
		pendingSeek = null;
		if (t > 0) audio.currentTime = t;
	}
	audio.playbackRate = current.speed || 1;
	updateTimeUi();
});

audio.addEventListener("timeupdate", () => {
	if (pendingSeek != null || !current) return;
	updateTimeUi();
	saveProgress();
	if (!audio.paused && Date.now() - (lastPush.get(current.id) || 0) > PUSH_WHILE_PLAYING_MS && !pushTimers.has(current.id)) schedulePush(current, 0);
	if (sleep.mode && sleep.mode !== "chapter" && Date.now() >= sleep.endsAt) {
		pause();
		setSleep(0);
	}
});

audio.addEventListener("play", () => {
	updatePlayUi();
	if (current && !lastPush.has(current.id)) lastPush.set(current.id, Date.now());
	if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
	updatePlayUi();
	saveProgress(true);
	if (current) schedulePush(current, 0);
	if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
audio.addEventListener("seeked", () => saveProgress(true));
audio.addEventListener("ratechange", () => {
	if (current && audio.playbackRate !== current.speed && !audio.paused && audio.readyState > 0) audio.playbackRate = current.speed;
});

audio.addEventListener("ended", async () => {
	const b = current;
	if (!b) return;
	if (sleep.mode === "chapter") {
		setSleep(0);
		if (b.chapterIndex < b.chapters.length - 1) await setChapter(b.chapterIndex + 1, 0);
		saveProgress(true);
		return;
	}
	if (b.chapterIndex < b.chapters.length - 1) {
		await setChapter(b.chapterIndex + 1, 0);
		play();
	} else {
		b.finished = true;
		saveProgress(true);
		schedulePush(b, 0);
		renderLibrary();
	}
});

audio.addEventListener("error", () => {
	if (!audio.src || !current) return;
	if (!currentUrl?.startsWith("blob:") && localFiles.has(current.chapters[current.chapterIndex].url)) return switchToLocal();
	// подписанная ссылка могла истечь — обновим список и попробуем ещё раз
	if (navigator.onLine && !currentUrl?.startsWith("blob:") && !retriedLinks) {
		retriedLinks = true;
		const b = current;
		const pos = b.position;
		refreshLibrary(true).then(() => current === b && setChapter(b.chapterIndex, pos));
		return;
	}
	console.error("audio error", audio.error);
	$("p-chapter").textContent = navigator.onLine ? "Не удалось воспроизвести файл" : "Нет интернета — скачайте книгу для офлайна";
});

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		saveProgress(true);
		flushPushes(true);
	} else if (password) refreshLibrary();
});
window.addEventListener("pagehide", () => {
	saveProgress(true);
	flushPushes(true);
});
window.addEventListener("online", () => {
	updateNetStatus();
	renderLibrary();
	flushPushes(false);
	refreshLibrary(true);
});
window.addEventListener("offline", () => {
	updateNetStatus();
	renderLibrary();
});

/* ======================= Player UI ======================= */

function openPlayer() {
	if (!current) return;
	$("player").hidden = false;
	$("library").hidden = true;
	$("mini").hidden = true;
	window.scrollTo(0, 0);
	if (history.state?.view !== "player") history.pushState({ view: "player" }, "");
	renderPlayerMeta();
	updateTimeUi();
}

function closePlayer(fromHistory = false) {
	closeSheet();
	$("player").hidden = true;
	$("library").hidden = false;
	renderLibrary();
	updateMini();
	if (!fromHistory && history.state?.view === "player") history.back();
}

window.addEventListener("popstate", () => {
	if (!$("sheet").hidden) closeSheet();
	if (!$("player").hidden) closePlayer(true);
});

function renderPlayerMeta() {
	if (!current) {
		if (!$("player").hidden) closePlayer();
		return;
	}
	setCover($("p-cover"), current);
	$("p-title").textContent = current.title;
	$("p-author").textContent = current.author || "";
	updateChapterUi();
	updatePlayUi();
	updateSpeedUi();
	updateSleepUi();
	updateDownloadUi();
	updateTimeUi();
}

function updateChapterUi() {
	if (!current) return;
	const b = current;
	const many = b.chapters.length > 1;
	$("p-chapter").textContent = many ? `${b.chapterIndex + 1}/${b.chapters.length} · ${b.chapters[b.chapterIndex].name}` : b.chapters[0].name;
	$("next").disabled = b.chapterIndex >= b.chapters.length - 1;
	$("next").style.opacity = $("next").disabled ? 0.35 : 1;
	$("chapters-btn").hidden = !many;
	$("player").querySelector(".tools").style.gridTemplateColumns = `repeat(${many ? 5 : 4}, 1fr)`;
	updateMini();
}

function updatePlayUi() {
	const playing = !audio.paused;
	$("play").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
	$("play").setAttribute("aria-label", playing ? "Пауза" : "Играть");
	$("mini-toggle").innerHTML = playing ? ICON_PAUSE_SM : ICON_PLAY_SM;
	$("mini-toggle").setAttribute("aria-label", playing ? "Пауза" : "Играть");
}

function updateTimeUi() {
	if (!current) return;
	const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current.chapters[current.chapterIndex].duration || 0;
	const cur = pendingSeek ?? audio.currentTime ?? 0;
	if (!seeking) {
		const v = dur ? Math.round((cur / dur) * 1000) : 0;
		$("seek").value = v;
		$("seek").style.setProperty("--p", v / 10 + "%");
		$("t-cur").textContent = fmt(cur);
		$("t-left").textContent = "-" + fmt(dur - cur);
	}
	const total = totalDuration(current);
	const g = chapterStart(current, current.chapterIndex) + cur;
	const speed = current.speed || 1;
	$("book-left").textContent = total ? `Книга: ${Math.floor((g / total) * 100)}% · осталось ${fmtLong((total - g) / speed)}${speed !== 1 ? ` при ${speed}×` : ""}` : "";
	$("mini-bar").style.width = total ? ((g / total) * 100).toFixed(2) + "%" : "0";
	updatePositionState();
}

function updateSpeedUi() {
	const s = current?.speed || 1;
	$("speed-val").textContent = `${s}×`;
	$("speed-btn").classList.toggle("on", s !== 1);
}

function updateMini() {
	const show = !!current && $("player").hidden && $("login").hidden;
	$("mini").hidden = !show;
	if (!current) return;
	setCover($("mini-cover"), current);
	$("mini-title").textContent = current.title;
	$("mini-sub").textContent = current.chapters.length > 1 ? current.chapters[current.chapterIndex].name : current.author || "";
}

const seekEl = $("seek");
seekEl.addEventListener("input", () => {
	seeking = true;
	const dur = audio.duration || 0;
	const t = (seekEl.value / 1000) * dur;
	seekEl.style.setProperty("--p", seekEl.value / 10 + "%");
	$("t-cur").textContent = fmt(t);
	$("t-left").textContent = "-" + fmt(dur - t);
});
seekEl.addEventListener("change", () => {
	const dur = audio.duration || 0;
	if (dur) audio.currentTime = (seekEl.value / 1000) * dur;
	seeking = false;
	saveProgress(true);
});

/* ======================= Sleep timer ======================= */

function setSleep(mode) {
	sleep = { mode, endsAt: typeof mode === "number" && mode > 0 ? Date.now() + mode * 60000 : 0 };
	clearInterval(sleepTick);
	if (typeof mode === "number" && mode > 0) {
		sleepTick = setInterval(() => {
			if (sleep.mode && Date.now() >= sleep.endsAt) {
				pause();
				setSleep(0);
			}
			updateSleepUi();
		}, 1000);
	}
	updateSleepUi();
}

function updateSleepUi() {
	const e = $("sleep-val");
	$("sleep-btn").classList.toggle("on", !!sleep.mode);
	if (!sleep.mode) e.textContent = "Таймер";
	else if (sleep.mode === "chapter") e.textContent = "Глава";
	else e.textContent = fmt((sleep.endsAt - Date.now()) / 1000);
}

/* ======================= Bottom sheet ======================= */

function openSheet(title, body) {
	$("sheet-title").textContent = title;
	const c = $("sheet-body");
	c.innerHTML = "";
	c.append(body);
	$("sheet").hidden = false;
	$("sheet-backdrop").hidden = false;
}

function closeSheet() {
	$("sheet").hidden = true;
	$("sheet-backdrop").hidden = true;
}
$("sheet-backdrop").onclick = closeSheet;

function el(html) {
	const t = document.createElement("template");
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}

function showSpeedSheet() {
	const grid = el('<div class="speed-grid"></div>');
	for (const s of SPEEDS) {
		const b = el(`<button class="opt${s === (current?.speed || 1) ? " sel" : ""}">${s}×</button>`);
		b.onclick = () => {
			setSpeed(s);
			closeSheet();
		};
		grid.append(b);
	}
	openSheet("Скорость воспроизведения", grid);
}

function showSleepSheet() {
	const list = el('<div class="opt-list"></div>');
	for (const o of SLEEP_OPTIONS) {
		const b = el(`<button class="opt${sleep.mode === o.value ? " sel" : ""}"><span>${o.label}</span></button>`);
		b.onclick = () => {
			setSleep(o.value);
			closeSheet();
		};
		list.append(b);
	}
	openSheet("Таймер сна", list);
}

function showChaptersSheet() {
	if (!current) return;
	const list = el('<div class="opt-list"></div>');
	current.chapters.forEach((c, i) => {
		const b = el(`<button class="opt${i === current.chapterIndex ? " sel" : ""}"><span>${i + 1}. ${esc(c.name)}</span><small>${c.duration ? fmt(c.duration) : ""}</small></button>`);
		b.onclick = () => {
			closeSheet();
			gotoChapter(i);
		};
		list.append(b);
	});
	openSheet("Главы", list);
	list.querySelector(".sel")?.scrollIntoView({ block: "center" });
}

function showEditSheet() {
	if (!current) return;
	const b = current;
	let newCover = null;
	const form = el(`
		<div>
			<div class="edit-cover">
				<img alt="" />
				<label class="btn btn-ghost">Сменить обложку<input type="file" accept="image/*" hidden /></label>
			</div>
			<label class="field"><span>Название</span><input type="text" name="title" /></label>
			<label class="field"><span>Автор</span><input type="text" name="author" /></label>
			<p class="hint" data-msg></p>
			<div class="row">
				<button class="btn btn-primary" data-act="save">Сохранить</button>
			</div>
			<div class="row">
				<button class="btn btn-ghost" data-act="restart">Слушать с начала</button>
				<button class="btn btn-danger" data-act="delete">Удалить книгу</button>
			</div>
		</div>`);
	setCover(form.querySelector(".edit-cover img"), b);
	form.querySelector('[name="title"]').value = b.title;
	form.querySelector('[name="author"]').value = b.author || "";
	form.querySelector('input[type="file"]').onchange = (e) => {
		const f = e.target.files[0];
		if (!f) return;
		newCover = f;
		form.querySelector(".edit-cover img").src = URL.createObjectURL(f);
	};
	const msg = form.querySelector("[data-msg]");
	form.querySelector('[data-act="save"]').onclick = async (e) => {
		if (!navigator.onLine) return (msg.textContent = "Для изменения нужен интернет.");
		e.target.disabled = true;
		msg.textContent = "Сохранение…";
		try {
			const meta = {
				id: b.id,
				title: form.querySelector('[name="title"]').value.trim() || b.title,
				author: form.querySelector('[name="author"]').value.trim(),
				cover: b.cover,
				chapters: b.chapters,
				createdAt: b.createdAt,
			};
			if (newCover) {
				const ext = extOf(newCover.name || "cover.jpg");
				const url = await uploadFile(`b/${b.id}/cover.${ext}`, newCover, newCover.type || "image/jpeg");
				await putLocal(url, newCover).catch(() => {});
				meta.cover = { url, type: newCover.type || "image/jpeg" };
			}
			const { url } = await api("POST", { action: "meta", id: b.id, meta, oldUrl: b.metaUrl });
			Object.assign(b, meta, { metaUrl: url });
			cacheLibrary();
			closeSheet();
			renderPlayerMeta();
			updateMediaSession();
		} catch (err) {
			if (err instanceof AuthError) return logout();
			msg.textContent = "Не удалось сохранить: " + err.message;
			e.target.disabled = false;
		}
	};
	form.querySelector('[data-act="restart"]').onclick = async () => {
		b.finished = false;
		closeSheet();
		await gotoChapter(0);
	};
	form.querySelector('[data-act="delete"]').onclick = async () => {
		if (!navigator.onLine) return (msg.textContent = "Для удаления нужен интернет.");
		if (!confirm(`Удалить «${b.title}» со всех устройств?`)) return;
		closeSheet();
		try {
			await api("POST", { action: "delete", id: b.id });
		} catch (err) {
			if (err instanceof AuthError) return logout();
			return alert("Не удалось удалить: " + err.message);
		}
		await removeDownload(b);
		lsSet(lsPosKey(b.id), null);
		books = books.filter((x) => x.id !== b.id);
		cacheLibrary();
		if (current?.id === b.id) unloadCurrent();
		closePlayer();
	};
	openSheet("Книга", form);
}

/* ======================= Media Session ======================= */

function updateMediaSession() {
	if (!("mediaSession" in navigator) || !current) return;
	const b = current;
	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: b.chapters.length > 1 ? b.chapters[b.chapterIndex].name : b.title,
			artist: b.author || "",
			album: b.title,
			artwork: [{ src: coverSrc(b), sizes: "512x512", type: b.cover?.type || "image/svg+xml" }],
		});
	} catch {}
}

function updatePositionState() {
	if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
	const d = audio.duration;
	if (!Number.isFinite(d) || d <= 0) return;
	try {
		navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate || 1 });
	} catch {}
}

if ("mediaSession" in navigator) {
	const handlers = {
		play: () => play(),
		pause: () => pause(),
		stop: () => stop(),
		seekbackward: (d) => skip(-(d.seekOffset || SKIP_BACK)),
		seekforward: (d) => skip(d.seekOffset || SKIP_FWD),
		seekto: (d) => {
			audio.currentTime = d.seekTime;
			saveProgress(true);
		},
		previoustrack: () => prevChapter(),
		nexttrack: () => nextChapter(),
	};
	for (const [k, fn] of Object.entries(handlers)) {
		try {
			navigator.mediaSession.setActionHandler(k, fn);
		} catch {}
	}
}

/* ======================= Wiring ======================= */

$("file-input").addEventListener("change", async (e) => {
	await importFiles(e.target.files);
	e.target.value = "";
});
$("play").onclick = toggle;
$("back").onclick = () => skip(-SKIP_BACK);
$("fwd").onclick = () => skip(SKIP_FWD);
$("prev").onclick = prevChapter;
$("next").onclick = nextChapter;
$("stop").onclick = stop;
$("speed-btn").onclick = showSpeedSheet;
$("sleep-btn").onclick = showSleepSheet;
$("chapters-btn").onclick = showChaptersSheet;
$("dl-btn").onclick = onDownloadButton;
$("p-chapter").onclick = () => current?.chapters.length > 1 && showChaptersSheet();
$("edit-book").onclick = showEditSheet;
$("close-player").onclick = () => closePlayer();
$("sync-btn").onclick = () => refreshLibrary(true);
$("mini").onclick = openPlayer;
$("mini").onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openPlayer());
$("mini-toggle").onclick = (e) => {
	e.stopPropagation();
	toggle();
};
$("back-label").textContent = SKIP_BACK;
$("fwd-label").textContent = SKIP_FWD;

document.addEventListener("keydown", (e) => {
	if (e.target.closest?.("input, textarea") || !current) return;
	if (e.code === "Space") {
		e.preventDefault();
		toggle();
	} else if (e.code === "ArrowLeft") skip(-SKIP_BACK);
	else if (e.code === "ArrowRight") skip(SKIP_FWD);
	else if (e.key === "Escape") closeSheet();
});

function restoreLast() {
	if (current) return;
	// на новом устройстве берём книгу, которую слушали последней на любом устройстве
	const last = books.find((b) => b.id === lsGet(LS_LAST)) || [...books].filter((b) => b.t && !b.finished).sort((a, b) => b.t - a.t)[0];
	if (last && isPlayable(last)) loadBook(last, false).catch(console.error);
}

async function init() {
	updatePlayUi();
	updateNetStatus();
	await loadLocalIndex();
	try {
		books = JSON.parse(lsGet(LS_LIB) || "[]").map(hydrate);
	} catch {
		books = [];
	}
	if (!password) {
		showLogin();
	} else {
		renderLibrary();
		restoreLast();
		refreshLibrary(true);
	}
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
