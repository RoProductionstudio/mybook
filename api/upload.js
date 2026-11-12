// Выдаёт браузеру подписанную ссылку, чтобы он загрузил файл прямо в Vercel Blob
// (минуя лимит 4.5 МБ на тело запроса к функции). Работает с OIDC-подключением хранилища
// (BLOB_STORE_ID + BLOB_WEBHOOK_PUBLIC_KEY), которое Vercel создаёт при Connect Project.
import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import { checkAuth, json } from "./_auth.js";

const MAX_SIZE = 2 * 1024 * 1024 * 1024;

export async function POST(request) {
	const denied = checkAuth(request);
	if (denied) return denied;
	const body = await request.json();
	if (body?.type !== "blob.generate-presigned-url") return json({ error: "bad-request" }, 400);
	try {
		const result = await handleUploadPresigned({
			request,
			body,
			getSignedToken: async (pathname) => {
				if (!/^b\/[a-z0-9-]{8,64}\/[\w.-]+$/i.test(pathname)) throw new Error("bad pathname");
				const token = await issueSignedToken({
					pathname,
					operations: ["put"],
					validUntil: Date.now() + 3600 * 1000,
					maximumSizeInBytes: MAX_SIZE,
				});
				return { token, urlOptions: { addRandomSuffix: true, maximumSizeInBytes: MAX_SIZE } };
			},
		});
		return json(result);
	} catch (err) {
		console.error("upload token error", err);
		return json({ error: String(err?.message || err) }, 400);
	}
}
