// breinhap#31: the parser thread. One document per thread; the thread ends after its one answer. It is
// started by sandbox.mjs with a capped heap, an empty environment (no database URL, no secrets) and a
// time limit, and it has no network: fetch and friends are removed before any parser is loaded.
import { parentPort, workerData } from "node:worker_threads";

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Request"]) {
	try {
		Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
	} catch {
		globalThis[name] = undefined;
	}
}
// parsers may print warnings that quote the document; nothing of it may reach the logs
for (const method of ["log", "info", "warn", "error", "debug", "trace"]) console[method] = () => {};

const { ExtractFailed } = await import("./limits.mjs");

const { kind, bytes } = workerData;
let last = 0;
const onProgress = (done, total) => {
	const now = Date.now();
	if (now - last < 200 && done < total) return;
	last = now;
	parentPort.postMessage({ type: "progress", done, total });
};

try {
	const data = Buffer.from(bytes);
	const result =
		kind === "pdf"
			? await (await import("./pdf.mjs")).extractPdf(data, { onProgress })
			: kind === "docx"
				? (await import("./docx.mjs")).extractDocx(data, { onProgress })
				: (() => {
						throw new ExtractFailed("unsupported");
					})();
	parentPort.postMessage({ type: "result", result });
} catch (error) {
	parentPort.postMessage({ type: "error", code: error instanceof ExtractFailed ? error.code : "corrupt" });
}
