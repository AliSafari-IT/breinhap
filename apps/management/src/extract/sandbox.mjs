import { Worker } from "node:worker_threads";

import { ExtractFailed, LIMITS } from "./limits.mjs";

/**
 * breinhap#31: runs one parse in its own thread (thread.mjs): a separate V8 isolate with a capped
 * heap and stack, an empty environment, no network APIs and a wall-clock limit. Past the limit, out of
 * memory, or cancelled (`signal`), the thread is terminated; nothing it allocated survives it.
 *
 * The heap cap does not cover buffers (ArrayBuffers live outside the V8 heap), so decoded PDF streams
 * are measured before parsing (pdf-budget.mjs) and DOCX parts are inflated with an output cap; as a last
 * guard, a watchdog stops the thread when the process grows by more than `rssGrowthMb` during a parse.
 *
 * This bounds what a hostile or broken document can cost. It is not an OS sandbox: the thread runs in
 * the management process. The parsers it runs only read bytes (see pdf.mjs and docx.mjs).
 *
 * Resolves `{ blocks, warnings, units }`; rejects with ExtractFailed (`timeout`, `too_complex`,
 * `cancelled`, or the parser's own code).
 */
export function runParser({ kind, bytes, signal, onProgress = () => {}, limits = LIMITS }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new ExtractFailed("cancelled"));
		const copy = new Uint8Array(bytes).slice().buffer;
		const thread = new Worker(new URL("./thread.mjs", import.meta.url), {
			workerData: { kind, bytes: copy },
			transferList: [copy],
			env: {},
			argv: [],
			execArgv: [],
			stdout: true,
			stderr: true,
			resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: limits.youngMb, stackSizeMb: limits.stackMb },
		});
		// whatever the parser prints is dropped, never logged
		thread.stdout.resume();
		thread.stderr.resume();
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(watchdog);
			signal?.removeEventListener("abort", abort);
			thread.terminate().catch(() => {});
			fn(value);
		};
		const timer = setTimeout(() => finish(reject, new ExtractFailed("timeout")), limits.timeoutMs);
		// a last guard for memory the heap cap does not see (buffers): stop the thread if the process grows
		const base = process.memoryUsage.rss();
		const watchdog = setInterval(() => {
			if (process.memoryUsage.rss() - base > limits.rssGrowthMb * 1024 * 1024) finish(reject, new ExtractFailed("too_complex"));
		}, 50);
		const abort = () => finish(reject, new ExtractFailed("cancelled"));
		signal?.addEventListener("abort", abort, { once: true });
		thread.on("message", (message) => {
			if (message?.type === "progress") {
				const done = Number(message.done);
				const total = Number(message.total);
				if (Number.isFinite(done) && Number.isFinite(total) && total > 0) onProgress(Math.min(done, total), total);
			} else if (message?.type === "result") finish(resolve, message.result);
			else if (message?.type === "error") finish(reject, new ExtractFailed(String(message.code)));
		});
		thread.on("error", (error) =>
			finish(reject, new ExtractFailed(error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_complex" : "internal")),
		);
		thread.on("exit", () => finish(reject, new ExtractFailed("internal")));
	});
}
