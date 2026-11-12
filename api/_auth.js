import { timingSafeEqual } from "node:crypto";

export function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

// Возвращает Response с ошибкой, если пароль неверный, иначе null.
export function checkAuth(request) {
	const expected = process.env.MYBOOK_PASSWORD;
	if (!expected) return json({ error: "no-password-configured" }, 500);
	if (!process.env.BLOB_READ_WRITE_TOKEN) return json({ error: "no-blob-store" }, 500);
	const given = request.headers.get("x-mybook-password") || "";
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: "unauthorized" }, 401);
	return null;
}

export const isId = (id) => typeof id === "string" && /^[a-z0-9-]{8,64}$/i.test(id);
