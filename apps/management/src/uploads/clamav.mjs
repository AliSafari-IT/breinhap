import { connect } from "node:net";

/**
 * breinhap#29: asks a ClamAV daemon (clamd) whether bytes are clean, over its INSTREAM protocol: the
 * command, the data in length-prefixed chunks, a zero-length chunk, then one reply line.
 *
 * Three outcomes, never more: `clean`, `infected` (with the signature name, which is never shown to the
 * uploader and holds no personal data), or an error. An error (the scanner is down, slow, or answers
 * something unexpected) means "not scanned": the caller keeps the file in quarantine and tries again
 * later. Nothing is ever treated as clean without the daemon saying "OK".
 */

export class ScannerUnavailable extends Error {
	constructor(reason) {
		super(`scanner unavailable: ${reason}`);
		this.reason = reason;
	}
}

const CHUNK = 64 * 1024;

export function createClamav({ host, port = 3310, timeoutMs = 30_000 }) {
	if (!host) throw new Error("ClamAV host missing");
	return {
		async scan(bytes) {
			return new Promise((resolve, reject) => {
				const socket = connect({ host, port });
				let reply = "";
				let settled = false;
				const finish = (fn, value) => {
					if (settled) return;
					settled = true;
					socket.destroy();
					fn(value);
				};
				socket.setTimeout(timeoutMs, () => finish(reject, new ScannerUnavailable("timeout")));
				socket.on("error", () => finish(reject, new ScannerUnavailable("connection")));
				socket.on("data", (data) => {
					reply += data.toString("latin1");
					if (reply.length > 4096) finish(reject, new ScannerUnavailable("reply"));
					if (reply.includes("\0")) settle();
				});
				socket.on("end", () => settle());
				// closed without a reply (clamd restarting, or the connection reset): not scanned
				socket.on("close", () => finish(reject, new ScannerUnavailable("closed")));
				const settle = () => {
					const line = reply.split("\0")[0].trim();
					if (line === "stream: OK") return finish(resolve, { result: "clean" });
					const found = /^stream: (.{1,200}) FOUND$/.exec(line);
					if (found) return finish(resolve, { result: "infected", signature: found[1] });
					finish(reject, new ScannerUnavailable(/size limit/i.test(line) ? "limit" : "reply"));
				};
				socket.on("connect", () => {
					socket.write("zINSTREAM\0");
					for (let at = 0; at < bytes.length; at += CHUNK) {
						const part = bytes.subarray(at, at + CHUNK);
						const size = Buffer.alloc(4);
						size.writeUInt32BE(part.length);
						socket.write(size);
						socket.write(part);
					}
					socket.write(Buffer.alloc(4));
				});
			});
		},
	};
}
