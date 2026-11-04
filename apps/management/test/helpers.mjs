import { randomBytes } from "node:crypto";
import { after } from "node:test";
import { connectStore } from "../src/store.mjs";

const stores = [];
after(async () => {
	await Promise.all(stores.map((store) => store.client.close()));
});
export async function makeStore(now = Date.now) {
	if (!process.env.REDIS_TEST_URL)
		throw new Error(
			"Use pnpm --filter @breinhap/management test, or set REDIS_TEST_URL for this suite",
		);
	const store = await connectStore({
		url: process.env.REDIS_TEST_URL,
		secret: randomBytes(32).toString("base64url"),
		workspace: `test-${randomBytes(8).toString("hex")}`,
	});
	store.now = now;
	stores.push(store);
	return store;
}
export async function member(store, subject, role = "breinhap.teacher") {
	const key = store.keyFor("member", subject);
	const data = { role, active: true, version: randomBytes(16).toString("hex") };
	await store.client.set(key, store.encode(key, data));
	return data;
}
