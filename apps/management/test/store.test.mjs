import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ABSOLUTE_MS, connectStore, IDLE_MS, IdentityStore } from "../src/store.mjs";
import { makeStore, member } from "./helpers.mjs";

const session = (time, extra = {}) => ({
	sub: "person",
	sid: "browser-a",
	issuedAt: Math.floor(time / 1000),
	authTime: Math.floor(time / 1000),
	expires: time + ABSOLUTE_MS,
	accessToken: "secret-access",
	refreshToken: "secret-refresh",
	csrf: "csrf",
	tokenExpires: time + 600_000,
	...extra,
});

test("Redis encrypts state, binds ciphertext to its key and rejects modified metadata", async () => {
	const store = await makeStore();
	const value = session(Date.now());
	await store.putFlow("flow", {
		verifier: "private-pkce",
		expires: Date.now() + 600_000,
	});
	assert.doesNotMatch(
		await store.client.get(store.keyFor("flow", "flow")),
		/private-pkce/,
	);
	assert.equal((await store.takeFlow("flow")).verifier, "private-pkce");
	assert.equal(await store.takeFlow("flow"), null);
	assert.equal(await store.saveSession("one", value), true);
	const raw = await store.client.get(store.keyFor("session", "one"));
	assert.doesNotMatch(raw, /secret-access|secret-refresh|csrf/);
	assert.equal((await store.getSession("one")).sub, "person");
	await store.client.set(store.keyFor("session", "two"), raw);
	await assert.rejects(store.getSession("two"));
	const envelope = JSON.parse(raw);
	envelope.expires += 1000;
	await store.client.set(
		store.keyFor("session", "one"),
		JSON.stringify(envelope),
	);
	await assert.rejects(store.getSession("one"), /metadata/);
});

test("replicas share sessions; idle polling cannot extend activity or absolute lifetime", async () => {
	let time = Date.now();
	const store = await makeStore(() => time);
	await store.saveSession("session", session(time));
	const second = new IdentityStore({
		client: store.client,
		secret: store.key.toString("base64url"),
		workspace: store.workspace,
		now: () => time,
	});
	assert.equal((await second.getSession("session")).sub, "person");
	await store.client.pExpire(store.keyFor("session", "session"), 1000);
	await second.getSession("session", false);
	assert.ok(
		(await store.client.pTTL(store.keyFor("session", "session"))) <= 1000,
	);
	await second.getSession("session", true);
	assert.ok(
		(await store.client.pTTL(store.keyFor("session", "session"))) >
			IDLE_MS - 1000,
	);
	time += ABSOLUTE_MS + 1;
	assert.equal(await second.getSession("session"), null);
});

test("idle expiry is enforced by Redis and session creation never overwrites", async () => {
	const store = await makeStore();
	const value = session(Date.now());
	assert.equal(await store.saveSession("session", value), true);
	assert.equal(await store.saveSession("session", value), false);
	await store.client.pExpire(store.keyFor("session", "session"), 1);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(await store.getSession("session"), null);
});

test("logout targets the right sid/sub and blocks replay and delayed callback resurrection", async () => {
	const time = Date.now();
	const store = await makeStore();
	const iat = Math.floor(time / 1000);
	await store.saveSession("a", session(time));
	await store.saveSession("b", session(time, { sid: "browser-b" }));
	assert.equal(
		await store.logout({
			jti: "event-one",
			sid: "browser-a",
			sub: "person",
			iat,
		}),
		true,
	);
	assert.equal(
		await store.logout({
			jti: "event-one",
			sid: "browser-a",
			sub: "person",
			iat,
		}),
		false,
	);
	assert.equal(await store.getSession("a"), null);
	assert.ok(await store.getSession("b"));
	assert.equal(await store.saveSession("late", session(time)), false);
	await store.logout({ jti: "event-two", sub: "person", iat });
	assert.equal(await store.getSession("b"), null);
	assert.equal(
		await store.saveSession(
			"new",
			session(time, { issuedAt: iat + 1, sid: "new-browser" }),
		),
		true,
	);
});

test("refresh lock is owner-bound and an in-flight refresh cannot restore a logged-out session", async () => {
	const store = await makeStore();
	const value = session(Date.now());
	await store.saveSession("session", value);
	const lock = await store.acquireRefresh("session");
	assert.ok(lock);
	assert.equal(await store.acquireRefresh("session"), null);
	await store.releaseRefresh("session", "forged");
	assert.equal(await store.acquireRefresh("session"), null);
	assert.equal(await store.saveSession("session", value, "forged"), false);
	await store.destroySession("session");
	assert.equal(await store.saveSession("session", value, lock), false);
	await store.releaseRefresh("session", lock);
	assert.ok(await store.acquireRefresh("session"));
});

test("invitation acceptance is one-use and bound to inviter version and workspace", async () => {
	const store = await makeStore();
	const inviter = await member(store, "admin", "breinhap.admin");
	const token = randomBytes(32).toString("base64url");
	assert.equal(
		await store.invite(token, {
			subject: "recipient",
			role: "breinhap.parent",
			inviter: "admin",
			inviterVersion: inviter.version,
		}),
		true,
	);
	const invitation = await store.invitation(token);
	const results = await Promise.all([
		store.accept(token, invitation, inviter, "recipient"),
		store.accept(token, invitation, inviter, "recipient"),
	]);
	assert.equal(results.filter(Boolean).length, 1);
	assert.equal((await store.membership("recipient")).role, "breinhap.parent");
	const another = await makeStore();
	assert.equal(await another.membership("recipient"), null);
	const old = randomBytes(32).toString("base64url");
	await store.invite(old, {
		subject: "other",
		role: "breinhap.parent",
		inviter: "admin",
		inviterVersion: inviter.version,
	});
	const pending = await store.invitation(old);
	await member(store, "admin", "breinhap.admin");
	assert.equal(await store.accept(old, pending, inviter, "other"), false);
	await store.revokeMember("recipient");
	assert.equal(await store.membership("recipient"), null);
});

test("the audit stream retains bounded pseudonymous events rather than credentials", async () => {
	const store = await makeStore();
	await store.audit("management.denied", "person", "other");
	const keys = [];
	for await (const batch of store.client.scanIterator({
		MATCH: `breinhap:{identity}:${store.workspace}:audit`,
	}))
		keys.push(...batch);
	assert.equal(keys.length, 1);
	const rows = await store.client.xRange(keys[0], "-", "+");
	assert.equal(rows[0].message.event, "management.denied");
	assert.doesNotMatch(JSON.stringify(rows), /"person"|"other"/);
});

test("the deployed Redis ACL supports the store while denying other namespaces and administration", async () => {
	const root = await makeStore();
	const user = `pilot_${randomBytes(6).toString("hex")}`;
	const password = randomBytes(24).toString("base64url");
	const { createClient } = await import("redis");
	const commands = [
		"get",
		"set",
		"getdel",
		"del",
		"pexpire",
		"pttl",
		"expire",
		"exists",
		"incr",
		"eval",
		"xadd",
		"xtrim",
		"ping",
		"hello",
		"quit",
		"client|setinfo",
		"client|setname",
	];
	await root.client.sendCommand([
		"ACL",
		"SETUSER",
		user,
		"on",
		`>${password}`,
		`~breinhap:{identity}:${root.workspace}:*`,
		"-@all",
		...commands.map((command) => `+${command}`),
	]);
	const url = new URL(process.env.REDIS_TEST_URL);
	url.username = user;
	url.password = password;
	const client = createClient({
		url: url.href,
		disableOfflineQueue: true,
		socket: { reconnectStrategy: false },
	});
	client.on("error", () => {});
	try {
		await client.connect();
		const restricted = new IdentityStore({
			client,
			secret: root.key.toString("base64url"),
			workspace: root.workspace,
		});
		await restricted.ready();
		await restricted.putFlow("flow", { test: true });
		assert.equal((await restricted.takeFlow("flow")).test, true);
		await restricted.saveSession("session", session(Date.now()));
		// breinhap#signup: the member index works within the same ACL (no hash commands)
		await restricted.client.set(restricted.keyFor("member", "indexed"), restricted.encode(restricted.keyFor("member", "indexed"), { role: "breinhap.teacher", active: true }));
		await restricted.indexMember("indexed", { firstName: "Kim", email: "kim@example.test" });
		await restricted.indexMember("indexed");
		assert.deepEqual(await restricted.members(), [{ subject: "indexed", role: "breinhap.teacher", profile: { firstName: "Kim", email: "kim@example.test" } }]);
		await restricted.revokeMember("indexed");
		assert.deepEqual(await restricted.members(), []);
		assert.ok(await restricted.getSession("session"));
		assert.ok(await restricted.updateSession("session", await restricted.getSession("session", false)));
		await restricted.audit("management.denied", "actor");
		assert.equal(await restricted.budget("start"), true);
		await restricted.bootstrap("admin");
		assert.equal((await restricted.membership("admin")).role, "breinhap.admin");
		const inviter = await restricted.membership("admin");
		assert.ok(
			await restricted.invite("invitation", {
				subject: "recipient",
				role: "breinhap.parent",
				inviter: "admin",
				inviterVersion: inviter.version,
			}),
		);
		assert.ok(
			await restricted.accept(
				"invitation",
				await restricted.invitation("invitation"),
				inviter,
				"recipient",
			),
		);
		assert.equal(
			(await restricted.membership("recipient")).role,
			"breinhap.parent",
		);
		const lock = await restricted.acquireRefresh("session");
		assert.ok(await restricted.renewRefresh("session", lock));
		await restricted.releaseRefresh("session", lock);
		await restricted.logout({
			sid: "browser",
			iat: Math.floor(Date.now() / 1000),
			jti: "acl-logout",
		});
		assert.equal(
			await restricted.requestRole("newcomer", "breinhap.tutor"),
			"created",
		);
		await restricted.requestRole("other", "breinhap.parent");
		const [first, second] = await restricted.roleRequests();
		assert.ok(
			await restricted.approveRequest(first.id, "admin", inviter.version),
		);
		assert.ok(await restricted.rejectRequest(second.id));
		assert.equal(
			(await restricted.membership("newcomer")).role,
			"breinhap.tutor",
		);
		await restricted.revokeMember("newcomer");
		await restricted.revokeMember("recipient");
		await assert.rejects(client.get("another-app:secret"), /NOPERM/);
		await assert.rejects(client.sendCommand(["CONFIG", "GET", "*"]), /NOPERM/);
	} finally {
		if (client.isOpen) await client.close();
		await root.client.sendCommand(["ACL", "DELUSER", user]);
	}
});

test("a quiet Redis connection stays up: the idle timeout no longer drops it, so a later request is not refused", async () => {
	// Same options as production, scaled down: a 500 ms idle timeout with nothing in flight.
	const connect = async (pingInterval) => {
		const errors = [];
		const store = await connectStore({ url: process.env.REDIS_TEST_URL, secret: randomBytes(32).toString("base64url"), workspace: `idle-${randomBytes(6).toString("hex")}`, socketTimeout: 500, pingInterval });
		store.client.on("error", (error) => errors.push(error.message));
		return { store, errors };
	};
	// without the keep-alive the client destroys the idle socket (the old behaviour)
	const idle = await connect(0);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.match(idle.errors[0] ?? "", /Socket timeout/, "control: an idle socket is destroyed without a keep-alive");
	await idle.store.client.close();
	// with it, a connection that is only quiet stays up and answers at once
	const kept = await connect(150);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.deepEqual(kept.errors, []);
	assert.equal(await kept.store.client.ping(), "PONG");
	await kept.store.client.close();
});


test("step-up atomically updates existing sessions with their TTL and rejects expiry and sid/sub revocation", async () => {
	let time = Date.now();
	const store = await makeStore(() => time);
	const value = session(time);
	assert.equal(await store.putFlow("collision", {}), true);
	assert.equal(await store.putFlow("collision", {}), false);
	assert.equal(await store.updateSession("missing", value), false);
	for (const kind of ["sid", "sub"]) {
		const value = session(time, { sid: `browser-${kind}`, sub: `person-${kind}` });
		const id = `session-${kind}`;
		await store.saveSession(id, value);
		const key = store.keyFor("session", id);
		await store.client.pExpire(key, 120_000);
		const ttl = await store.client.pTTL(key);
		const updated = { ...value, authTime: value.authTime + 301 };
		assert.equal(await store.updateSession(id, updated), true);
		assert.ok((await store.client.pTTL(key)) <= ttl);
		assert.ok((await store.client.pTTL(key)) > ttl - 1000);
		assert.deepEqual(await store.getSession(id, false), updated);
		await store.logout({ [kind]: value[kind], jti: `revoked-${kind}`, iat: value.issuedAt });
		assert.equal(await store.updateSession(id, updated), false);
	}
	await store.saveSession("expired", { ...value, sub: "other", sid: "other" });
	time += ABSOLUTE_MS + 1;
	assert.equal(await store.updateSession("expired", { ...value, sub: "other", sid: "other" }), false);
});
