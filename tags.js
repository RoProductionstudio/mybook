// Чтение метаданных (название, автор, альбом, обложка) из MP3 (ID3v2) и M4A/M4B (MP4 atoms).

const MAX_TAG = 30 * 1024 * 1024;

export async function readTags(file) {
	const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
	if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return readId3(file, head);
	if (ascii(head, 4, 4) === "ftyp") return readMp4(file);
	return {};
}

/* ---------------- ID3v2 ---------------- */

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const be24 = (b, o) => (b[o] << 16) + (b[o + 1] << 8) + b[o + 2];
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function decodeText(enc, bytes) {
	let s;
	if (enc === 1) s = new TextDecoder("utf-16").decode(bytes);
	else if (enc === 2) s = new TextDecoder("utf-16be").decode(bytes);
	else if (enc === 3) s = new TextDecoder("utf-8").decode(bytes);
	else {
		// "latin1" в русских MP3 почти всегда означает windows-1251
		const hi = bytes.some((x) => x >= 0x80);
		s = new TextDecoder(hi ? "windows-1251" : "latin1").decode(bytes);
	}
	return s.replace(/\0+$/g, "").split("\0")[0].trim();
}

function textEnd(data, start, enc) {
	if (enc === 1 || enc === 2) {
		for (let i = start; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return i + 2;
	} else {
		for (let i = start; i < data.length; i++) if (data[i] === 0) return i + 1;
	}
	return data.length;
}

async function readId3(file, head) {
	const ver = head[3];
	const flags = head[5];
	const size = syncsafe(head, 6);
	if (size <= 0 || size > MAX_TAG) return {};
	const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
	let pos = 0;
	if (flags & 0x40 && ver >= 3) pos = ver === 4 ? syncsafe(buf, 0) : be32(buf, 0) + 4;

	const v22 = ver === 2;
	const idLen = v22 ? 3 : 4;
	const hdrLen = v22 ? 6 : 10;
	const out = {};
	let pictures = [];

	while (pos + hdrLen <= buf.length) {
		const id = ascii(buf, pos, idLen);
		if (!/^[A-Z0-9]+$/.test(id)) break;
		const fsize = v22 ? be24(buf, pos + 3) : ver === 4 ? syncsafe(buf, pos + 4) : be32(buf, pos + 4);
		const fflags = v22 ? 0 : (buf[pos + 8] << 8) | buf[pos + 9];
		let data = buf.subarray(pos + hdrLen, pos + hdrLen + fsize);
		pos += hdrLen + fsize;
		if (fsize <= 0) continue;
		if (ver === 4 && fflags & 0x0001) data = data.subarray(4); // data length indicator
		if (ver === 4 && fflags & 0x000c) continue; // сжатие/шифрование — пропускаем

		switch (id) {
			case "TIT2":
			case "TT2":
				out.title ||= decodeText(data[0], data.subarray(1));
				break;
			case "TPE1":
			case "TP1":
				out.artist ||= decodeText(data[0], data.subarray(1));
				break;
			case "TALB":
			case "TAL":
				out.album ||= decodeText(data[0], data.subarray(1));
				break;
			case "APIC": {
				const enc = data[0];
				const mimeEnd = textEnd(data, 1, 0);
				const mime = ascii(data, 1, mimeEnd - 2) || "image/jpeg";
				const type = data[mimeEnd];
				const dataStart = textEnd(data, mimeEnd + 1, enc);
				pictures.push({ type, mime: mime.includes("/") ? mime : "image/" + mime.toLowerCase(), bytes: data.slice(dataStart) });
				break;
			}
			case "PIC": {
				const enc = data[0];
				const fmt = ascii(data, 1, 3).toLowerCase();
				const type = data[4];
				const dataStart = textEnd(data, 5, enc);
				pictures.push({ type, mime: fmt === "png" ? "image/png" : "image/jpeg", bytes: data.slice(dataStart) });
				break;
			}
		}
	}
	const pic = pictures.find((p) => p.type === 3) || pictures[0];
	if (pic?.bytes.length > 100) out.cover = new Blob([pic.bytes], { type: sniffImage(pic.bytes) || pic.mime });
	return out;
}

/* ---------------- MP4 / M4B ---------------- */

async function readMp4(file) {
	let pos = 0;
	while (pos + 8 <= file.size) {
		const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
		let size = be32(h, 0);
		const type = ascii(h, 4, 4);
		if (size === 1) size = be32(h, 8) * 2 ** 32 + be32(h, 12);
		else if (size === 0) size = file.size - pos;
		if (size < 8) break;
		if (type === "moov") {
			if (size > MAX_TAG) return {};
			const buf = new Uint8Array(await file.slice(pos, pos + size).arrayBuffer());
			return parseMoov(buf);
		}
		pos += size;
	}
	return {};
}

function* boxes(buf, start, end) {
	let p = start;
	while (p + 8 <= end) {
		let size = be32(buf, p);
		const type = ascii(buf, p + 4, 4);
		let hdr = 8;
		if (size === 1) {
			size = be32(buf, p + 8) * 2 ** 32 + be32(buf, p + 12);
			hdr = 16;
		} else if (size === 0) size = end - p;
		if (size < hdr || p + size > end) return;
		yield { type, start: p + hdr, end: p + size };
		p += size;
	}
}

const child = (buf, parent, type, skip = 0) => {
	for (const b of boxes(buf, parent.start + skip, parent.end)) if (b.type === type) return b;
	return null;
};

function parseMoov(buf) {
	const out = {};
	const moov = { start: 8, end: buf.length };
	const udta = child(buf, moov, "udta");
	const meta = udta && child(buf, udta, "meta");
	const ilst = meta && child(buf, meta, "ilst", 4); // meta — full box: 4 байта version/flags
	if (!ilst) return out;
	for (const item of boxes(buf, ilst.start, ilst.end)) {
		const data = child(buf, item, "data");
		if (!data) continue;
		const kind = be32(buf, data.start) & 0xffffff;
		const payload = buf.subarray(data.start + 8, data.end);
		switch (item.type) {
			case "\xa9nam":
				out.title ||= new TextDecoder().decode(payload).trim();
				break;
			case "\xa9ART":
			case "aART":
				out.artist ||= new TextDecoder().decode(payload).trim();
				break;
			case "\xa9alb":
				out.album ||= new TextDecoder().decode(payload).trim();
				break;
			case "covr":
				if (!out.cover && payload.length > 100)
					out.cover = new Blob([payload.slice()], { type: kind === 14 ? "image/png" : sniffImage(payload) || "image/jpeg" });
				break;
		}
	}
	return out;
}

function sniffImage(b) {
	if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
	if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
	return "";
}
