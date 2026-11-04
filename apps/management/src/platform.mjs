import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export const manifest = JSON.parse(
	await readFile(new URL("../platform.app.json", import.meta.url), "utf8"),
);
export const roleLabels = Object.freeze({
	"breinhap.admin": "Beheerder",
	"breinhap.parent": "Ouder",
	"breinhap.tutor": "Begeleider",
	"breinhap.teacher": "Leerkracht",
	"breinhap.student": "Leerling",
});

// Interoperable with ASafariM OS packages/registry-protocol (ed25519-v1).
// The external app's SDK packages are not published yet; keep this small wire adapter contract-tested.
export function signRequest(credential, path, body = "", method = "GET") {
	const match = /^osk1\.(breinhap\.[0-9a-f]{12})\.([A-Za-z0-9_-]+)$/.exec(
		credential,
	);
	if (!match) throw new Error("Invalid Breinhap registry credential");
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = randomBytes(18).toString("base64url");
	const hash = createHash("sha256").update(body).digest("hex");
	const message = `v1\n${timestamp}\n${nonce}\n${method}\n${path}\n${hash}`;
	const key = createPrivateKey({
		key: Buffer.from(match[2], "base64url"),
		format: "der",
		type: "pkcs8",
	});
	return {
		"x-asafarim-timestamp": timestamp,
		"x-asafarim-nonce": nonce,
		"x-asafarim-key-id": match[1],
		"x-asafarim-signature": `v1=${sign(null, Buffer.from(message), key).toString("base64url")}`,
	};
}

export function managementAccess(grants, subject) {
	if (
		grants?.appId !== "breinhap" ||
		grants.subject !== subject ||
		!["installed", "active", "inactive", "removed"].includes(grants.state) ||
		!Array.isArray(grants.roles) ||
		!Array.isArray(grants.permissions) ||
		!grants.roles.every((role) => typeof role === "string") ||
		!grants.permissions.every((permission) => typeof permission === "string")
	) {
		throw new Error("Invalid registry response");
	}
	const roles = grants.roles.filter((role) => Object.hasOwn(roleLabels, role));
	const adult = roles.some((role) => role !== "breinhap.student");
	return {
		access:
			grants.state === "active" &&
			adult &&
			grants.permissions.includes("breinhap.management.access")
				? "management"
				: "denied",
		roles: roles.map((role) => roleLabels[role]),
		roleKeys: roles,
		permissions: grants.permissions.filter((permission) =>
			permission.startsWith("breinhap."),
		),
	};
}

export function createPlatform({ url, credential, fetcher = fetch }) {
	const base = new URL(url);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.pathname !== "/" ||
		base.search ||
		base.hash
	)
		throw new Error("Invalid core API URL");
	async function request(path, body, method = "GET") {
		const res = await fetcher(new URL(path, base), {
			method,
			headers: {
				...signRequest(credential, path, body, method),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body } : {}),
			signal: AbortSignal.timeout(5000),
			redirect: "error",
			cache: "no-store",
		});
		if (!res.ok) throw new Error("Registry unavailable");
		return res.json();
	}
	return {
		register: () =>
			request("/registry/v1/apps/breinhap", JSON.stringify(manifest), "POST"),
		grants: (subject) =>
			request(
				`/registry/v1/apps/breinhap/subjects/${encodeURIComponent(subject)}`,
			),
	};
}
