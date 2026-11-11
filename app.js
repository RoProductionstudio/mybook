// My Book — личная библиотека аудиокниг.
// Всё хранится локально в браузере (IndexedDB): аудиофайлы, обложки и место прослушивания.

import { readTags } from "./tags.js";

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
const LS_LAST = "mybook:last";
const lsPosKey = (id) => `mybook:pos:${id}`;

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>';
const ICON_PLAY_SM = '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const ICON_PAUSE_SM = '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>';

const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* ======================= IndexedDB ======================= */

let dbPromise;
function db() {
	dbPromise ??= new Promise((resolve, reject) => {
		const req = indexedDB.open("mybook", 1);
		req.onupgradeneeded = () => {
			const d = req.result;
			d.createObjectStore("books", { keyPath: "id" });
			d.createObjectStore("files", { keyPath: "id" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

async function idb(store, mode, fn) {
	const d = await db();
	return new Promise((resolve, reject) => {
		const tx = d.transaction(store, mode);
		const req = fn(tx.objectStore(store));
		tx.oncomplete = () => resolve(req?.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const getAllBooks = () => idb("books", "readonly", (s) => s.getAll());
const putBook = (b) => idb("books", "readwrite", (s) => s.put(b));
const getFile = (id) => idb("files", "readonly", (s) => s.get(id));
const putFile = (f) => idb("files", "readwrite", (s) => s.put(f));
const deleteFile = (id) => idb("files", "readwrite", (s) => s.delete(id));
const deleteBookRow = (id) => idb("books", "readwrite", (s) => s.delete(id));

/* ======================= Helpers ======================= */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const baseName = (name) => name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

const coverUrls = new Map();
function coverUrl(book) {
	if (!book.cover) return placeholderCover(book.title);
	const cached = coverUrls.get(book.id);
	if (cached && cached.blob === book.cover) return cached.url;
	if (cached) URL.revokeObjectURL(cached.url);
	const url = URL.createObjectURL(book.cover);
	coverUrls.set(book.id, { blob: book.cover, url });
	return url;
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

const totalDuration = (b) => b.chapters.reduce((s, c) => s + (c.duration || 0), 0);
const chapterStart = (b, i) => b.chapters.slice(0, i).reduce((s, c) => s + (c.duration || 0), 0);
const globalPos = (b) => chapterStart(b, b.chapterIndex) + (b.position || 0);

/* ======================= State ======================= */

let books = [];
let current = null; // текущая книга
let currentUrl = null; // objectURL текущей главы
let pendingSeek = null;
let lastIdbSave = 0;
let lastLsSave = 0;
let sleep = { mode: 0, endsAt: 0 };
let sleepTick = null;
let seeking = false;

/* ======================= Library ======================= */

function sortBooks() {
	books.sort((a, b) => (b.lastPlayedAt || b.createdAt) - (a.lastPlayedAt || a.createdAt));
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
		const li = document.createElement("li");
		li.innerHTML = `
			<button class="book${current?.id === b.id ? " active" : ""}">
				<img src="${coverUrl(b)}" alt="" />
				<span class="book-info">
					<div class="book-title">${esc(b.title)}</div>
					<div class="book-sub">${esc([b.author, b.chapters.length > 1 ? pluralChapters(b.chapters.length) : "", status].filter(Boolean).join(" · "))}</div>
					<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
				</span>
			</button>`;
		li.querySelector("button").onclick = () => openBook(b);
		list.appendChild(li);
	}
	updateStorageInfo();
}

async function updateStorageInfo() {
	if (!navigator.storage?.estimate) return;
	const { usage = 0, quota = 0 } = await navigator.storage.estimate();
	const mb = (n) => (n / 1048576 >= 1024 ? (n / 1073741824).toFixed(1) + " ГБ" : Math.round(n / 1048576) + " МБ");
	$("storage").textContent = quota ? `Занято ${mb(usage)} из доступных ${mb(quota)} на этом устройстве` : "";
}

async function importFiles(fileList) {
	const files = [...fileList].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name));
	if (!files.length) return;
	files.sort((a, b) => collator.compare(a.name, b.name));

	navigator.storage?.persist?.().catch(() => {});

	const status = $("import-status");
	status.hidden = false;
	const book = {
		id: uid(),
		title: "",
		author: "",
		cover: null,
		chapters: [],
		chapterIndex: 0,
		position: 0,
		speed: 1,
		createdAt: Date.now(),
		lastPlayedAt: 0,
		finished: false,
	};
	let firstTags = null;
	try {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			status.textContent = `Загрузка ${i + 1} из ${files.length}: ${f.name}`;
			const tags = await readTags(f).catch(() => ({}));
			if (!firstTags) firstTags = tags;
			if (!book.cover && tags.cover) book.cover = tags.cover;
			if (!book.author && tags.artist) book.author = tags.artist;
			const duration = await probeDuration(f);
			const fileId = uid();
			await putFile({ id: fileId, blob: f, name: f.name });
			book.chapters.push({
				fileId,
				name: files.length > 1 ? tags.title || baseName(f.name) : baseName(f.name),
				duration,
			});
		}
		const names = files.map((f) => baseName(f.name));
		book.title =
			firstTags?.album ||
			(files.length === 1 ? firstTags?.title || names[0] : commonPrefix(names) || names[0]) ||
			"Без названия";
		await putBook(book);
		books.push(book);
		status.hidden = true;
		renderLibrary();
		if (!current) await loadBook(book, false);
	} catch (err) {
		console.error(err);
		for (const c of book.chapters) await deleteFile(c.fileId).catch(() => {});
		status.textContent =
			err?.name === "QuotaExceededError"
				? "Недостаточно места на устройстве для этой книги."
				: "Не удалось загрузить файлы: " + (err?.message || err);
	}
}

/* ======================= Playback ======================= */

function readLsPos(id) {
	try {
		return JSON.parse(localStorage.getItem(lsPosKey(id)) || "null");
	} catch {
		return null;
	}
}

function saveProgress(force = false) {
	if (!current) return;
	const now = Date.now();
	if (!pendingSeek && audio.src && Number.isFinite(audio.currentTime) && audio.readyState > 0) {
		current.position = audio.currentTime;
	}
	// localStorage — синхронно и надёжно при закрытии вкладки
	if (force || now - lastLsSave > 1000) {
		lastLsSave = now;
		try {
			localStorage.setItem(lsPosKey(current.id), JSON.stringify({ c: current.chapterIndex, p: current.position, t: now, s: current.speed }));
			localStorage.setItem(LS_LAST, current.id);
		} catch {}
	}
	if (force || now - lastIdbSave > 5000) {
		lastIdbSave = now;
		current.savedAt = now;
		putBook(current).catch(console.error);
	}
}

async function setChapter(index, position = 0) {
	const b = current;
	index = Math.max(0, Math.min(b.chapters.length - 1, index));
	const rec = await getFile(b.chapters[index].fileId);
	if (!rec) throw new Error("Файл главы не найден");
	if (current !== b) return;
	if (currentUrl) URL.revokeObjectURL(currentUrl);
	currentUrl = URL.createObjectURL(rec.blob);
	b.chapterIndex = index;
	b.position = position;
	pendingSeek = position;
	audio.src = currentUrl;
	audio.defaultPlaybackRate = b.speed || 1;
	audio.playbackRate = b.speed || 1;
	audio.load();
	updateChapterUi();
	updateMediaSession();
}

async function loadBook(book, autoplay) {
	if (current && current.id !== book.id) {
		saveProgress(true);
		audio.pause();
	}
	current = book;
	// берём самую свежую позицию из localStorage, если она новее IndexedDB
	const ls = readLsPos(book.id);
	if (ls && ls.t > (book.savedAt || 0) && ls.c < book.chapters.length) {
		book.chapterIndex = ls.c;
		book.position = ls.p;
		if (ls.s) book.speed = ls.s;
	}
	try {
		localStorage.setItem(LS_LAST, book.id);
	} catch {}
	await setChapter(book.chapterIndex || 0, book.position || 0);
	updateSpeedUi();
	renderPlayerMeta();
	updateMini();
	if (autoplay) play();
}

async function openBook(book) {
	if (current?.id !== book.id) await loadBook(book, true);
	else if (audio.paused && !book.lastPlayedAt) play();
	openPlayer();
}

function play() {
	if (!current) return;
	if (current.finished) {
		current.finished = false;
		if (current.chapterIndex === current.chapters.length - 1 && audio.duration && audio.currentTime >= audio.duration - 1) {
			setChapter(0, 0).then(play);
			return;
		}
	}
	current.lastPlayedAt = Date.now();
	audio.play().catch((e) => console.warn("play()", e));
}

function pause() {
	audio.pause();
}

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
	if (i === b.chapterIndex) {
		audio.currentTime = offset;
	} else {
		const wasPlaying = !audio.paused;
		await setChapter(i, offset);
		if (wasPlaying) play();
	}
	saveProgress(true);
}

function skip(delta) {
	if (!current) return;
	const b = current;
	// если длительности не известны — перематываем внутри главы
	if (!totalDuration(b)) {
		audio.currentTime = Math.max(0, audio.currentTime + delta);
		return;
	}
	seekGlobal(chapterStart(b, b.chapterIndex) + audio.currentTime + delta);
}

async function gotoChapter(i, { keepPlaying = true } = {}) {
	if (!current) return;
	const wasPlaying = !audio.paused;
	await setChapter(i, 0);
	if (keepPlaying && wasPlaying) play();
	saveProgress(true);
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
}

function stop() {
	pause();
	setSleep(0);
	saveProgress(true);
	closePlayer();
}

/* ======================= Audio events ======================= */

audio.addEventListener("loadedmetadata", () => {
	if (!current) return;
	const ch = current.chapters[current.chapterIndex];
	if (Number.isFinite(audio.duration) && audio.duration > 0 && Math.abs((ch.duration || 0) - audio.duration) > 1) {
		ch.duration = audio.duration;
		saveProgress(true);
	}
	if (pendingSeek != null) {
		const t = Math.min(pendingSeek, Math.max(0, (audio.duration || Infinity) - 1));
		pendingSeek = null;
		if (t > 0) audio.currentTime = t;
	}
	audio.playbackRate = current.speed || 1;
	updateTimeUi();
});

audio.addEventListener("timeupdate", () => {
	if (pendingSeek != null) return;
	updateTimeUi();
	saveProgress();
	if (sleep.mode && sleep.mode !== "chapter" && Date.now() >= sleep.endsAt) {
		pause();
		setSleep(0);
	}
});

audio.addEventListener("play", () => {
	updatePlayUi();
	if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
	updatePlayUi();
	saveProgress(true);
	if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
audio.addEventListener("seeked", () => saveProgress(true));
audio.addEventListener("ratechange", () => {
	// некоторые браузеры сбрасывают скорость при смене источника
	if (current && audio.playbackRate !== current.speed && !audio.paused && audio.readyState > 0) audio.playbackRate = current.speed;
});

audio.addEventListener("ended", async () => {
	const b = current;
	if (!b) return;
	if (sleep.mode === "chapter") {
		setSleep(0);
		if (b.chapterIndex < b.chapters.length - 1) {
			await setChapter(b.chapterIndex + 1, 0);
			saveProgress(true);
		}
		return;
	}
	if (b.chapterIndex < b.chapters.length - 1) {
		await setChapter(b.chapterIndex + 1, 0);
		play();
	} else {
		b.finished = true;
		saveProgress(true);
		renderLibrary();
	}
});

audio.addEventListener("error", () => {
	if (!audio.src) return;
	console.error("audio error", audio.error);
	$("p-chapter").textContent = "Этот формат не поддерживается браузером";
});

// Сохраняем позицию при сворачивании/закрытии приложения
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") saveProgress(true);
});
window.addEventListener("pagehide", () => saveProgress(true));

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
	if (!current) return;
	$("p-cover").src = coverUrl(current);
	$("p-title").textContent = current.title;
	$("p-author").textContent = current.author || "";
	updateChapterUi();
	updatePlayUi();
	updateSpeedUi();
	updateSleepUi();
}

function updateChapterUi() {
	if (!current) return;
	const b = current;
	const many = b.chapters.length > 1;
	$("p-chapter").textContent = many ? `${b.chapterIndex + 1}/${b.chapters.length} · ${b.chapters[b.chapterIndex].name}` : b.chapters[0].name;
	$("prev").disabled = false;
	$("next").disabled = b.chapterIndex >= b.chapters.length - 1;
	$("next").style.opacity = $("next").disabled ? 0.35 : 1;
	$("chapters-btn").hidden = !many;
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
	const dur = audio.duration || current.chapters[current.chapterIndex].duration || 0;
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
	$("book-left").textContent = total
		? `Книга: ${Math.floor((g / total) * 100)}% · осталось ${fmtLong((total - g) / speed)}${speed !== 1 ? ` при ${speed}×` : ""}`
		: "";
	$("mini-bar").style.width = total ? ((g / total) * 100).toFixed(2) + "%" : "0";
	updatePositionState();
}

function updateSpeedUi() {
	const s = current?.speed || 1;
	$("speed-val").textContent = `${s}×`;
	$("speed-btn").classList.toggle("on", s !== 1);
}

function updateMini() {
	const show = !!current && $("player").hidden;
	$("mini").hidden = !show;
	if (!current) return;
	$("mini-cover").src = coverUrl(current);
	$("mini-title").textContent = current.title;
	$("mini-sub").textContent =
		current.chapters.length > 1 ? current.chapters[current.chapterIndex].name : current.author || fmt(current.position);
}

// Перемотка ползунком
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
	const el = $("sleep-val");
	$("sleep-btn").classList.toggle("on", !!sleep.mode);
	if (!sleep.mode) el.textContent = "Таймер";
	else if (sleep.mode === "chapter") el.textContent = "Конец главы";
	else el.textContent = fmt((sleep.endsAt - Date.now()) / 1000);
}

/* ======================= Bottom sheet ======================= */

function openSheet(title, body) {
	$("sheet-title").textContent = title;
	const container = $("sheet-body");
	container.innerHTML = "";
	container.append(body);
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
	let newCover = undefined;
	const form = el(`
		<div>
			<div class="edit-cover">
				<img alt="" src="${coverUrl(b)}" />
				<label class="btn btn-ghost">Сменить обложку<input type="file" accept="image/*" hidden /></label>
			</div>
			<label class="field"><span>Название</span><input type="text" name="title" /></label>
			<label class="field"><span>Автор</span><input type="text" name="author" /></label>
			<div class="row">
				<button class="btn btn-primary" data-act="save">Сохранить</button>
			</div>
			<div class="row">
				<button class="btn btn-ghost" data-act="restart">Слушать с начала</button>
				<button class="btn btn-danger" data-act="delete">Удалить книгу</button>
			</div>
		</div>`);
	form.querySelector('[name="title"]').value = b.title;
	form.querySelector('[name="author"]').value = b.author || "";
	form.querySelector('input[type="file"]').onchange = (e) => {
		const f = e.target.files[0];
		if (!f) return;
		newCover = f;
		form.querySelector(".edit-cover img").src = URL.createObjectURL(f);
	};
	form.querySelector('[data-act="save"]').onclick = async () => {
		b.title = form.querySelector('[name="title"]').value.trim() || b.title;
		b.author = form.querySelector('[name="author"]').value.trim();
		if (newCover) b.cover = newCover;
		await putBook(b);
		closeSheet();
		renderPlayerMeta();
		updateMediaSession();
	};
	form.querySelector('[data-act="restart"]').onclick = async () => {
		b.finished = false;
		closeSheet();
		await gotoChapter(0, { keepPlaying: true });
	};
	form.querySelector('[data-act="delete"]').onclick = async () => {
		if (!confirm(`Удалить «${b.title}» с этого устройства?`)) return;
		closeSheet();
		await removeBook(b);
	};
	openSheet("Книга", form);
}

async function removeBook(b) {
	if (current?.id === b.id) {
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		if (currentUrl) URL.revokeObjectURL(currentUrl);
		currentUrl = null;
		current = null;
		try {
			localStorage.removeItem(LS_LAST);
		} catch {}
	}
	for (const c of b.chapters) await deleteFile(c.fileId).catch(() => {});
	await deleteBookRow(b.id);
	try {
		localStorage.removeItem(lsPosKey(b.id));
	} catch {}
	books = books.filter((x) => x.id !== b.id);
	closePlayer();
	if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
}

/* ======================= Media Session (экран блокировки) ======================= */

function updateMediaSession() {
	if (!("mediaSession" in navigator) || !current) return;
	const b = current;
	const art = coverUrl(b);
	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: b.chapters.length > 1 ? b.chapters[b.chapterIndex].name : b.title,
			artist: b.author || "",
			album: b.title,
			artwork: [{ src: art, sizes: "512x512", type: b.cover?.type || "image/svg+xml" }],
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
	const ms = navigator.mediaSession;
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
			ms.setActionHandler(k, fn);
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
$("p-chapter").onclick = () => current?.chapters.length > 1 && showChaptersSheet();
$("edit-book").onclick = showEditSheet;
$("close-player").onclick = () => closePlayer();
$("mini").onclick = openPlayer;
$("mini").onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openPlayer());
$("mini-toggle").onclick = (e) => {
	e.stopPropagation();
	toggle();
};
$("back-label").textContent = SKIP_BACK;
$("fwd-label").textContent = SKIP_FWD;

// Клавиатура (на компьютере)
document.addEventListener("keydown", (e) => {
	if (e.target.closest?.("input, textarea") || !current) return;
	if (e.code === "Space") {
		e.preventDefault();
		toggle();
	} else if (e.code === "ArrowLeft") skip(-SKIP_BACK);
	else if (e.code === "ArrowRight") skip(SKIP_FWD);
	else if (e.key === "Escape") closeSheet();
});

async function init() {
	updatePlayUi();
	try {
		books = await getAllBooks();
	} catch (err) {
		console.error(err);
		$("storage").textContent = "Хранилище браузера недоступно (возможно, включён приватный режим).";
	}
	renderLibrary();
	let lastId = null;
	try {
		lastId = localStorage.getItem(LS_LAST);
	} catch {}
	const last = books.find((b) => b.id === lastId);
	if (last) await loadBook(last, false).catch(console.error);
	renderLibrary();
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
