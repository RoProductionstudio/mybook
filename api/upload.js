// Выдаёт браузеру одноразовый токен, чтобы он загрузил файл прямо в Vercel Blob
// (минуя лимит 4.5 МБ на тело запроса к функции).
import { handleUpload } from "@vercel/blob/client";
import { checkAuth, json } from "./_auth.js";

export async function POST(request) {
	const denied = checkAuth(request);
	if (denied) return denied;
	const body = await request.json();
	if (body?.type !== "blob.generate-client-token") return json({ error: "bad-request" }, 400);
	try {
		const result = await handleUpload({
			request,
			body,
			onBeforeGenerateToken: async (pathname) => {
				if (!/^b\/[a-z0-9-]{8,64}\/[\w.-]+$/i.test(pathname)) throw new Error("bad pathname");
				return {
					addRandomSuffix: true,
					maximumSizeInBytes: 2 * 1024 * 1024 * 1024,
				};
			},
		});
		return json(result);
	} catch (err) {
		return json({ error: String(err?.message || err) }, 400);
	}
}
