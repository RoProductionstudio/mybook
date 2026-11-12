// Библиотека: список книг, сохранение метаданных и места прослушивания, удаление.
//
// Всё хранится в Vercel Blob под префиксом b/<bookId>/:
//   b/<id>/meta-<rand>.json                 — название, автор, обложка, главы
//   b/<id>/p_<t>_<c>_<pos>_<speed>_<f>-<rand>.json — место прослушивания (данные прямо в имени файла,
//                                              чтобы список книг строился одним запросом list)
//   b/<id>/NN-<rand>.<ext>, b/<id>/cover-<rand>.<ext> — аудио и обложка
// Каждое сохранение создаёт новый файл со случайным суффиксом, старый удаляется (удаление бесплатно),
// поэтому кэш CDN никогда не отдаёт устаревшие данные.
//
// Хранилище приватное: браузер получает доступ к аудио и обложкам только через подписанные
// временные ссылки (src), которые выдаются вместе со списком книг после проверки пароля.

import { del, get, issueSignedToken, list, presignUrl, put } from "@vercel/blob";
import { checkAuth, isId, json } from "./_auth.js";

const PROGRESS_RE = /^b\/([^/]+)\/p_(\d+)_(\d+)_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)_([01])(?:-[^/]*)?\.json$/;
const META_RE = /^b\/([^/]+)\/meta(?:-[^/]*)?\.json$/;

const ACCESS = "private";
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;

const pathOf = (url) => decodeURIComponent(new URL(url).pathname.slice(1));

async function signer() {
	let token;
	try {
		token = await issueSignedToken({ pathname: "*", operations: ["get"], validUntil: Date.now() + LINK_TTL_MS });
	} catch {
		token = await issueSignedToken({ pathname: "*", operations: ["get"] }); // по умолчанию 1 час
	}
	return async (url) => {
		if (!url) return url;
		const { presignedUrl } = await presignUrl(token, { operation: "get", pathname: pathOf(url), access: ACCESS });
		return presignedUrl;
	};
}

async function readJson(url) {
	const res = await get(url, { access: ACCESS, useCache: false });
	if (!res || res.statusCode !== 200) return null;
	return new Response(res.stream).json();
}

async function listAll(prefix) {
	const blobs = [];
	let cursor;
	do {
		const res = await list({ prefix, cursor, limit: 1000 });
		blobs.push(...res.blobs);
		cursor = res.hasMore ? res.cursor : undefined;
	} while (cursor);
	return blobs;
}

export async function GET(request) {
	const denied = checkAuth(request);
	if (denied) return denied;

	const blobs = await listAll("b/");
	const byId = new Map();
	const entry = (id) => {
		if (!byId.has(id)) byId.set(id, { metas: [], progress: [] });
		return byId.get(id);
	};
	for (const b of blobs) {
		let m;
		if ((m = b.pathname.match(META_RE))) entry(m[1]).metas.push(b);
		else if ((m = b.pathname.match(PROGRESS_RE)))
			entry(m[1]).progress.push({ url: b.url, t: +m[2], c: +m[3], p: +m[4], s: +m[5], f: m[6] === "1" });
	}

	const stale = [];
	const sign = byId.size ? await signer() : null;
	const books = await Promise.all(
		[...byId.entries()].map(async ([id, e]) => {
			if (!e.metas.length) return null; // незаконченная загрузка
			e.metas.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
			e.progress.sort((a, b) => b.t - a.t);
			stale.push(...e.metas.slice(1).map((b) => b.url), ...e.progress.slice(1).map((p) => p.url));
			try {
				const meta = await readJson(e.metas[0].url);
				if (!meta) return null;
				meta.chapters = await Promise.all((meta.chapters || []).map(async (c) => ({ ...c, src: await sign(c.url) })));
				if (meta.cover?.url) meta.cover = { ...meta.cover, src: await sign(meta.cover.url) };
				return { ...meta, id, metaUrl: e.metas[0].url, progress: e.progress[0] || null };
			} catch {
				return null;
			}
		}),
	);
	if (stale.length) await del(stale).catch(() => {});
	return json({ books: books.filter(Boolean), linksValidUntil: Date.now() + LINK_TTL_MS });
}

export async function POST(request) {
	const denied = checkAuth(request);
	if (denied) return denied;
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "bad-json" }, 400);
	}
	const { action, id } = body || {};
	if (!isId(id)) return json({ error: "bad-id" }, 400);
	const own = (url) => typeof url === "string" && url.includes(`/b/${id}/`);

	if (action === "meta") {
		const { meta, oldUrl } = body;
		if (!meta || typeof meta !== "object") return json({ error: "bad-meta" }, 400);
		const clean = {
			...meta,
			id,
			chapters: (meta.chapters || []).map(({ src, ...c }) => c),
			cover: meta.cover ? { url: meta.cover.url, type: meta.cover.type } : null,
		};
		const blob = await put(`b/${id}/meta.json`, JSON.stringify(clean), {
			access: ACCESS,
			addRandomSuffix: true,
			contentType: "application/json",
			cacheControlMaxAge: 60,
		});
		if (own(oldUrl)) await del(oldUrl).catch(() => {});
		return json({ url: blob.url });
	}

	if (action === "progress") {
		const t = Math.floor(Number(body.t) || Date.now());
		const c = Math.max(0, Math.floor(Number(body.c) || 0));
		const p = Math.max(0, Math.round((Number(body.p) || 0) * 10) / 10);
		const s = Math.min(4, Math.max(0.25, Number(body.s) || 1));
		const f = body.f ? 1 : 0;
		const blob = await put(`b/${id}/p_${t}_${c}_${p}_${s}_${f}.json`, "{}", {
			access: ACCESS,
			addRandomSuffix: true,
			contentType: "application/json",
			cacheControlMaxAge: 60,
		});
		if (own(body.oldUrl)) await del(body.oldUrl).catch(() => {});
		return json({ url: blob.url, t });
	}

	if (action === "delete") {
		const blobs = await listAll(`b/${id}/`);
		if (blobs.length) await del(blobs.map((b) => b.url));
		return json({ ok: true, deleted: blobs.length });
	}

	return json({ error: "bad-action" }, 400);
}
