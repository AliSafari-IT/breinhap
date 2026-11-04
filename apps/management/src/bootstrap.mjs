// Operator-only, never reachable over HTTP. Subject comes from stdin, not command-line logs.

import { createPlatform, managementAccess } from "./platform.mjs";
import { connectStore } from "./store.mjs";

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 500) throw new Error("Invalid account code");
}
const subject = input.trim();
if (!/^[A-Za-z0-9:._@-]{1,400}$/.test(subject))
	throw new Error("Invalid account code");
const platform = createPlatform({
	url: process.env.CORE_API_URL,
	credential: process.env.ASAFARIM_REGISTRY_CREDENTIAL,
});
const grants = managementAccess(await platform.grants(subject), subject);
if (
	grants.access !== "management" ||
	!grants.roleKeys.includes("breinhap.admin") ||
	!grants.permissions.includes("breinhap.memberships.manage")
)
	throw new Error("Operator must assign the trusted administrator grant first");
const store = await connectStore({
	url: process.env.REDIS_URL,
	secret: process.env.SESSION_ENCRYPTION_KEY,
	workspace: process.env.BREINHAP_WORKSPACE_ID ?? "pilot",
});
try {
	await store.audit("membership.bootstrap", subject);
	if (!(await store.bootstrap(subject)))
		throw new Error("Membership already exists; no changes made");
	console.log("Pilot administrator membership created");
} finally {
	await store.client.close();
}
