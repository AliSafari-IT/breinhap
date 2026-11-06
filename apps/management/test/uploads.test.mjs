// breinhap#29, without a database: the file checks (signatures, active content, polyglots, archive
// bombs), the S3 request signature (AWS's own test vector), the ClamAV protocol and the upload form.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { createClamav, ScannerUnavailable } from "../src/uploads/clamav.mjs";
import { boundaryOf, FormRefused, parseMultipart } from "../src/uploads/multipart.mjs";
import { signature } from "../src/uploads/s3.mjs";
import { cleanFileName, MAX_FILE_BYTES, UploadRefused, validateFile } from "../src/uploads/validate.mjs";
import { CONTENT_TYPES, docx, jpeg, multipart, pdf, png, webp, zip } from "./upload-fixtures.mjs";

const ok = (name, bytes, declaredType) => validateFile({ name, bytes, declaredType });
const refused = (name, bytes, code, declaredType) =>
	assert.throws(() => validateFile({ name, bytes, declaredType }), (e) => e instanceof UploadRefused && e.code === code, `${name}: expected ${code}`);

// ── validation ─────────────────────────────────────────────────────────────────────────────────────

test("accepted: a plain PDF, a DOCX, PNG, JPEG and WebP; the bytes decide the type", () => {
	assert.equal(ok("les.pdf", pdf(), "application/pdf").kind, "pdf");
	assert.equal(ok("Werkblad.DOCX", docx()).kind, "docx");
	assert.equal(ok("werkblad.docx", docx([], CONTENT_TYPES, { deflate: true })).kind, "docx");
	assert.equal(ok("schema.png", png(), "image/png").mediaType, "image/png");
	assert.equal(ok("foto.jpg", jpeg("JFIF"), "image/jpeg").kind, "jpeg");
	assert.equal(ok("foto.webp", webp()).kind, "webp");
	assert.equal(ok("les.pdf", pdf(), "application/octet-stream").kind, "pdf");
});

test("refused: programs, scripts, web/SVG files, archives and legacy Office, whatever they are named", () => {
	refused("les.pdf", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]), "refused_executable");
	refused("les.pdf", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]), "refused_executable");
	refused("schema.png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "refused_markup");
	refused("les.pdf", Buffer.from("#!/bin/sh\nrm -rf /\n"), "refused_script");
	refused("oud.docx", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]), "refused_legacy_office");
	refused("map.pdf", Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(30)]), "refused_archive");
	refused("archief.zip", zip([["a.txt", "hallo"]]), "type_not_allowed");
	refused("macro.docm", docx(), "type_not_allowed");
	refused("tekening.svg", png(), "type_not_allowed");
	refused("zonder-extensie", pdf(), "type_not_allowed");
});

test("refused: a name or media type that does not match the bytes", () => {
	refused("foto.jpg", png(), "type_mismatch");
	refused("les.docx", pdf(), "type_mismatch");
	refused("les.pdf", pdf(), "type_mismatch", "image/png");
	refused("doc.docx", zip([["word/document.xml", "<w:document/>"]]), "type_mismatch");
	refused("", pdf(), "name_missing");
	refused("leeg.pdf", Buffer.alloc(0), "empty");
	refused("groot.pdf", Buffer.alloc(MAX_FILE_BYTES + 1), "too_large");
});

test("PDF: scripts, launch actions and attachments are refused, also escaped or inside an object stream", () => {
	refused("a.pdf", pdf("1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\n"), "pdf_active_content");
	refused("a.pdf", pdf("1 0 obj<</S/J#61vaScript>>endobj\n"), "pdf_active_content");
	refused("a.pdf", pdf("1 0 obj<</S/Launch/F(cmd.exe)>>endobj\n"), "pdf_active_content");
	refused("a.pdf", pdf("1 0 obj<</Names<</EmbeddedFiles 2 0 R>>>>endobj\n"), "pdf_active_content");
	const hidden = deflateSync(Buffer.from("<</S/JavaScript/JS(app.alert(1))>>"));
	refused("a.pdf", pdf(`3 0 obj<</Type/ObjStm/N 1/First 0/Filter/FlateDecode/Length ${hidden.length}>>stream\n${hidden.toString("latin1")}\nendstream\nendobj\n`), "pdf_active_content");
	refused("a.pdf", pdf("1 0 obj<</Encrypt 5 0 R>>endobj\n"), "encrypted");
	refused("a.pdf", Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n"), "pdf_truncated");
	// page content is drawing, not dictionaries: random compressed bytes in it never trip the check
	const drawing = Buffer.from("/JS /JavaScript BT /F1 12 Tf (x) Tj ET");
	assert.equal(ok("a.pdf", pdf(`4 0 obj<</Length ${drawing.length}>>stream\n${drawing.toString("latin1")}\nendstream\nendobj\n`)).kind, "pdf");
});

test("DOCX: macros, ActiveX and embedded programs are refused; so are broken or exploding archives", () => {
	refused("m.docx", docx([["word/vbaProject.bin", "x"]]), "docx_active_content");
	refused("m.docx", docx([["word/activeX/activeX1.xml", "<x/>"]]), "docx_active_content");
	refused("m.docx", docx([["word/embeddings/oleObject1.bin", "x"]]), "docx_active_content");
	refused("m.docx", docx([], CONTENT_TYPES.replace("document.main+xml", "document.macroEnabled.main+xml")), "docx_active_content");
	refused("m.docx", zip([["[Content_Types].xml", CONTENT_TYPES], ["word/document.xml", "x"], ["../../evil.txt", "x"]]), "zip_invalid");
	refused("b.docx", docx([["word/media/big.bin", "\0".repeat(5_000_000)]], CONTENT_TYPES, { deflate: true }), "zip_bomb");
	refused("t.docx", docx().subarray(0, 200), "zip_invalid");
});

test("polyglots: data after an image's end, or a second format inside, is refused", () => {
	refused("p.png", png({ after: zip([["a.txt", "x"]]) }), "polyglot");
	refused("p.png", png({ extra: Buffer.from("%PDF-1.7 hidden") }), "polyglot");
	refused("p.png", png({ extra: Buffer.from("<script>alert(1)</script>") }), "polyglot");
	refused("p.jpg", Buffer.concat([jpeg(), Buffer.from("PK\u0003\u0004 trailing")]), "polyglot");
	refused("p.webp", webp(Buffer.from("extra")), "polyglot");
	refused("p.docx", Buffer.concat([docx(), Buffer.from("%PDF-1.7 trailing")]), "polyglot");
	refused("p.pdf", Buffer.concat([pdf(), zip([["a", "b"]]), Buffer.from("\n%%EOF\n")]), "polyglot");
});

test("file names are shown safely: no path, no control or direction characters, bounded", () => {
	assert.equal(cleanFileName("../../etc/passwd"), "passwd");
	assert.equal(cleanFileName("C:\\Users\\x\\les.pdf"), "les.pdf");
	assert.equal(cleanFileName("fact\u202Euur.pdf"), "factuur.pdf");
	assert.equal(cleanFileName('a"<b>.pdf'), "ab.pdf");
	assert.equal(cleanFileName(".verborgen.pdf"), "verborgen.pdf");
	const long = cleanFileName(`${"a".repeat(300)}.pdf`);
	assert.equal(long.length, 120);
	assert.ok(long.endsWith(".pdf"));
});

// ── S3 signature ───────────────────────────────────────────────────────────────────────────────────

test("S3 requests are signed exactly as AWS documents (Signature V4 GET Object example)", () => {
	const header = signature({
		method: "GET",
		path: "/test.txt",
		headers: {
			host: "examplebucket.s3.amazonaws.com",
			range: "bytes=0-9",
			"x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"x-amz-date": "20130524T000000Z",
		},
		payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		region: "us-east-1",
		date: new Date("2013-05-24T00:00:00Z"),
	});
	assert.equal(
		header,
		"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
	);
});

// ── ClamAV ─────────────────────────────────────────────────────────────────────────────────────────

async function fakeClamd(reply) {
	const received = [];
	const server = createServer((socket) => {
		const chunks = [];
		socket.on("data", (data) => {
			chunks.push(data);
			const all = Buffer.concat(chunks);
			if (all.length >= 14 && all.subarray(all.length - 4).equals(Buffer.alloc(4))) {
				received.push(all);
				if (reply === null) socket.destroy();
				else socket.end(reply);
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: server.address().port, received, close: () => new Promise((r) => server.close(r)) };
}

test("ClamAV: INSTREAM in length-prefixed chunks; OK is clean, FOUND is infected, anything else is not scanned", async () => {
	const clean = await fakeClamd("stream: OK\0");
	const bytes = Buffer.alloc(150_000, 7);
	assert.deepEqual(await createClamav({ host: "127.0.0.1", port: clean.port }).scan(bytes), { result: "clean" });
	const sent = clean.received[0];
	assert.equal(sent.subarray(0, 10).toString("latin1"), "zINSTREAM\0");
	assert.equal(sent.readUInt32BE(10), 65_536);
	assert.equal(sent.length, 10 + 150_000 + 4 * 3 + 4);
	await clean.close();

	const infected = await fakeClamd("stream: Eicar-Test-Signature FOUND\0");
	assert.deepEqual(await createClamav({ host: "127.0.0.1", port: infected.port }).scan(Buffer.from("x")), { result: "infected", signature: "Eicar-Test-Signature" });
	await infected.close();

	for (const reply of ["INSTREAM size limit exceeded. ERROR\0", "stream: OKAY\0", null]) {
		const odd = await fakeClamd(reply);
		await assert.rejects(createClamav({ host: "127.0.0.1", port: odd.port }).scan(Buffer.from("x")), ScannerUnavailable);
		await odd.close();
	}
	// nobody listening
	const gone = await fakeClamd("stream: OK\0");
	const port = gone.port;
	await gone.close();
	await assert.rejects(createClamav({ host: "127.0.0.1", port, timeoutMs: 2000 }).scan(Buffer.from("x")), ScannerUnavailable);
});

// ── the upload form ────────────────────────────────────────────────────────────────────────────────

test("the upload form: fields and one file; two files or a malformed body are refused", () => {
	const file = pdf();
	const form = multipart([
		{ name: "csrf", value: "token" },
		{ name: "bestand", filename: "les.pdf", type: "application/pdf", value: file },
		{ name: "bron", value: "own" },
	]);
	const parsed = parseMultipart(form.body, boundaryOf(form.contentType));
	assert.equal(parsed.fields.get("csrf"), "token");
	assert.equal(parsed.fields.get("bron"), "own");
	assert.equal(parsed.file.name, "les.pdf");
	assert.equal(parsed.file.type, "application/pdf");
	assert.ok(parsed.file.bytes.equals(file));
	const two = multipart([
		{ name: "bestand", filename: "a.pdf", value: file },
		{ name: "bestand", filename: "b.pdf", value: file },
	]);
	assert.throws(() => parseMultipart(two.body, "----breinhap"), (e) => e instanceof FormRefused && e.code === "one_file");
	assert.throws(() => parseMultipart(Buffer.from("garbage"), "----breinhap"), FormRefused);
	assert.equal(boundaryOf("application/x-www-form-urlencoded"), null);
	assert.equal(boundaryOf('multipart/form-data; boundary="abc"'), "abc");
});
