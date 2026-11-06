// breinhap#29: files for the upload tests, built byte by byte (no test runs here).
import { crc32, deflateRawSync } from "node:zlib";

export const pdf = (body = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n") =>
	Buffer.from(`%PDF-1.7\n${body}trailer<</Root 1 0 R>>\n%%EOF\n`, "latin1");

/** A ZIP with the given entries (deflated when `deflate`), exactly as a writer would make it. */
export function zip(entries, { deflate = false } = {}) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, text] of entries) {
		const data = Buffer.from(text);
		const body = deflate ? deflateRawSync(data) : data;
		const nameBuf = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(deflate ? 8 : 0, 10);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBuf, body);
		centrals.push(central, nameBuf);
		offset += 30 + nameBuf.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
export const CONTENT_TYPES =
	'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
export const docx = (extra = [], types = CONTENT_TYPES, options) =>
	zip([["[Content_Types].xml", types], ["word/document.xml", "<w:document/>"], ...extra], options);

export function png({ after = Buffer.alloc(0), extra = Buffer.alloc(0) } = {}) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "latin1");
		return Buffer.concat([head, data, Buffer.alloc(4)]);
	};
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("IDAT", extra), chunk("IEND", Buffer.alloc(0)), after]);
}
export const jpeg = (middle = "") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(middle), Buffer.from([0xff, 0xd9])]);
export function webp(trailing = Buffer.alloc(0)) {
	const body = Buffer.concat([Buffer.from("WEBPVP8 "), Buffer.alloc(10)]);
	const head = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4)]);
	head.writeUInt32LE(body.length, 4);
	return Buffer.concat([head, body, trailing]);
}

export function multipart(parts, boundary = "----breinhap") {
	const chunks = [];
	for (const part of parts) {
		chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ""}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ""}\r\n`));
		chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
		chunks.push(Buffer.from("\r\n"));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

