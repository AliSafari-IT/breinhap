import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { createClient } from "redis";

export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 12 * 3600_000;
export const digest = (value) =>
	createHash("sha256").update(value).digest("base64url");
const prefix = "breinhap:{identity}:";

// Lua keeps expiry, refresh ownership, and logout races atomic across replicas.
const READ = `
local raw = redis.call('GET', KEYS[1]); if not raw then return nil end
local r = cjson.decode(raw)
local now = tonumber(ARGV[1])
local sub = tonumber(redis.call('GET', r.subKey) or '-1')
local sid = tonumber(redis.call('GET', r.sidKey) or '-1')
if r.expires <= now or sub >= r.issuedAt or sid >= r.issuedAt then redis.call('DEL', KEYS[1]); return nil end
if ARGV[2] == '1' then redis.call('PEXPIRE', KEYS[1], math.min(tonumber(ARGV[3]), r.expires - now)) end
return raw`;
const SAVE = `
local r = cjson.decode(ARGV[1]); local now = tonumber(ARGV[2])
if r.expires <= now then return 0 end
if tonumber(redis.call('GET', r.subKey) or '-1') >= r.issuedAt or tonumber(redis.call('GET', r.sidKey) or '-1') >= r.issuedAt then return 0 end
if ARGV[4] == 'update' then
  if redis.call('GET', KEYS[2]) ~= ARGV[5] then return 0 end
  local ttl = redis.call('PTTL', KEYS[1]); if ttl <= 0 then return 0 end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', math.min(ttl, r.expires - now)); return 1
end
local ok=redis.call('SET', KEYS[1], ARGV[1], 'PX', math.min(tonumber(ARGV[3]), r.expires - now), 'NX'); if ok then return 1 end return 0`;
const LOGOUT = `
if not redis.call('SET', KEYS[1], '1', 'EX', 300, 'NX') then return 0 end
for i=2,#KEYS do
 local previous = tonumber(redis.call('GET', KEYS[i]) or '-1')
 if previous < tonumber(ARGV[1]) then redis.call('SET', KEYS[i], ARGV[1], 'PX', ARGV[2]) end
end
return 1`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const BUDGET = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return n`;
const ACCEPT = `
local raw=redis.call('GET',KEYS[1]); if not raw or raw ~= ARGV[1] then return 0 end
if redis.call('GET',KEYS[2]) ~= ARGV[2] then return 0 end
if redis.call('EXISTS',KEYS[3])==1 then return 0 end
redis.call('SET',KEYS[3],ARGV[3]); redis.call('DEL',KEYS[1]); return 1`;

// Role requests use only plain keys and the commands the deployed Redis ACL already allows (no hashes):
// one encrypted key per request and one index key holding the open request ids, kept in step by Lua.
const DROP = `local function drop(id)
  local list = cjson.decode(redis.call('GET',KEYS[1]) or '[]'); local kept = {}
  for _, v in ipairs(list) do if v ~= id then table.insert(kept, v) end end
  if #kept == 0 then redis.call('DEL',KEYS[1]) else redis.call('SET',KEYS[1],cjson.encode(kept)) end
end
`;
const REQUEST = `
if redis.call('EXISTS',KEYS[2])==1 then return 2 end
local list = cjson.decode(redis.call('GET',KEYS[1]) or '[]')
if #list >= tonumber(ARGV[3]) then return 0 end
table.insert(list, ARGV[1]); redis.call('SET',KEYS[1],cjson.encode(list)); redis.call('SET',KEYS[2],ARGV[2]); return 1`;
const REMOVE = `${DROP}
local n = redis.call('DEL',KEYS[2]); drop(ARGV[1]); return n`;
// Approve only while the approver's membership is unchanged and the requester has none yet.
const APPROVE = `${DROP}
if redis.call('GET',KEYS[2]) ~= ARGV[2] then return 0 end
if redis.call('GET',KEYS[3]) ~= ARGV[3] then return 0 end
if redis.call('EXISTS',KEYS[4])==1 then redis.call('DEL',KEYS[2]); drop(ARGV[1]); return 0 end
redis.call('SET',KEYS[4],ARGV[4]); redis.call('DEL',KEYS[2]); drop(ARGV[1]); return 1`;
// The member index (breinhap#signup), with only the commands the deployed Redis ACL allows (no hashes):
// KEYS[1] the JSON list of ids, KEYS[2] the encrypted entry; ARGV id, value, replace ('1'), max.
const INDEX = `
if ARGV[3] ~= '1' and redis.call('EXISTS',KEYS[2])==1 then return 0 end
local list = cjson.decode(redis.call('GET',KEYS[1]) or '[]'); local found = false
for _, v in ipairs(list) do if v == ARGV[1] then found = true end end
if not found then
  if #list >= tonumber(ARGV[4]) then return 0 end
  table.insert(list, ARGV[1]); redis.call('SET',KEYS[1],cjson.encode(list))
end
redis.call('SET',KEYS[2],ARGV[2]); return 1`;
export const MAX_MEMBERS = 5000;
export const SELF_SERVICE_ROLES = Object.freeze([
	"breinhap.parent",
	"breinhap.tutor",
	"breinhap.teacher",
]);
export const MAX_PENDING_REQUESTS = 500;

/** What a registering adult tells about themselves: short plain text only. */
export const PROFILE_FIELDS = { firstName: 60, lastName: 80, email: 254, organisation: 120, note: 500 };
export function cleanProfile(profile = {}) {
	const out = {};
	for (const [field, max] of Object.entries(PROFILE_FIELDS)) {
		const value = typeof profile?.[field] === "string" ? profile[field].replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
		if (value) out[field] = value;
	}
	return out;
}
/** How a person is shown to an administrator: their name, else their e-mail, else "(onbekend)". */
export function labelOf(person) {
	const p = person?.profile ?? {};
	return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || "(onbekend)";
}

export class IdentityStore {
	constructor({ client, secret, workspace = "pilot", now = Date.now }) {
		const key = Buffer.from(secret ?? "", "base64url");
		if (key.length !== 32 || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? ""))
			throw new Error(
				"Session encryption key must be 32 random bytes encoded as base64url",
			);
		if (!/^[a-z][a-z0-9-]{0,40}$/.test(workspace))
			throw new Error("Invalid pilot workspace");
		this.client = client;
		this.key = key;
		this.now = now;
		this.workspace = workspace;
		this.refreshLeaseMs = 30_000;
	}
	keyFor(kind, value) {
		return `${prefix}${this.workspace}:${kind}:${digest(value)}`;
	}
	encode(key, value) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		cipher.setAAD(Buffer.from(key));
		const data = Buffer.concat([
			cipher.update(JSON.stringify(value)),
			cipher.final(),
		]);
		return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
	}
	decode(key, value) {
		if (!value) return null;
		const bytes = Buffer.from(value, "base64url");
		const cipher = createDecipheriv(
			"aes-256-gcm",
			this.key,
			bytes.subarray(0, 12),
		);
		cipher.setAAD(Buffer.from(key));
		cipher.setAuthTag(bytes.subarray(12, 28));
		return JSON.parse(
			Buffer.concat([
				cipher.update(bytes.subarray(28)),
				cipher.final(),
			]).toString(),
		);
	}
	async ready() {
		return this.client.ping();
	}
	async budget(kind, limit = 30, seconds = 60, requester = "workspace") {
		const key = this.keyFor(
			"budget",
			`${kind}:${requester}:${Math.floor(this.now() / (seconds * 1000))}`,
		);
		return (
			Number(
				await this.client.eval(BUDGET, {
					keys: [key],
					arguments: [String(seconds)],
				}),
			) <= limit
		);
	}
	async putFlow(id, value) {
		const key = this.keyFor("flow", id);
		await this.client.set(key, this.encode(key, value), { EX: 600, NX: true });
	}
	async readFlow(id) {
		const key = this.keyFor("flow", id);
		return this.decode(key, await this.client.get(key));
	}
	/** Replaces a flow that still exists, keeping its expiry. */
	async replaceFlow(id, value) {
		const key = this.keyFor("flow", id);
		await this.client.set(key, this.encode(key, value), { XX: true, KEEPTTL: true });
	}
	async takeFlow(id) {
		const key = this.keyFor("flow", id);
		return this.decode(key, await this.client.getDel(key));
	}
	async getSession(id, touch = true) {
		const key = this.keyFor("session", id);
		const raw = await this.client.eval(READ, {
			keys: [key],
			arguments: [String(this.now()), touch ? "1" : "0", String(IDLE_MS)],
		});
		if (!raw) return null;
		const record = JSON.parse(raw);
		const value = this.decode(key, record.payload);
		if (
			record.expires !== value.expires ||
			record.issuedAt !== value.issuedAt ||
			record.subKey !== this.keyFor("revoked-sub", value.sub) ||
			record.sidKey !== this.keyFor("revoked-sid", value.sid) ||
			value.expires <= this.now()
		)
			throw new Error("Corrupt session metadata");
		return value;
	}
	async saveSession(id, value, lock) {
		const key = this.keyFor("session", id);
		const record = {
			payload: this.encode(key, value),
			expires: value.expires,
			issuedAt: value.issuedAt,
			subKey: this.keyFor("revoked-sub", value.sub),
			sidKey: this.keyFor("revoked-sid", value.sid),
		};
		return (
			Number(
				await this.client.eval(SAVE, {
					keys: [key, this.keyFor("refresh", id)],
					arguments: [
						JSON.stringify(record),
						String(this.now()),
						String(IDLE_MS),
						lock ? "update" : "create",
						lock ?? "",
					],
				}),
			) === 1
		);
	}
	async destroySession(id) {
		await this.client.del(this.keyFor("session", id));
	}
	async acquireRefresh(id) {
		const token = randomBytes(24).toString("base64url");
		return (await this.client.set(this.keyFor("refresh", id), token, {
			NX: true,
			PX: this.refreshLeaseMs,
		}))
			? token
			: null;
	}
	async renewRefresh(id, token) {
		return (
			Number(
				await this.client.eval(
					"if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return redis.call('PEXPIRE',KEYS[1],ARGV[2])",
					{
						keys: [this.keyFor("refresh", id)],
						arguments: [token, String(this.refreshLeaseMs)],
					},
				),
			) === 1
		);
	}
	async releaseRefresh(id, token) {
		await this.client.eval(UNLOCK, {
			keys: [this.keyFor("refresh", id)],
			arguments: [token],
		});
	}
	async logout(claims) {
		// A sid targets one browser's OIDC session. A sub-only logout targets all of that subject's sessions.
		const marker = claims.sid
			? this.keyFor("revoked-sid", claims.sid)
			: this.keyFor("revoked-sub", claims.sub);
		return (
			Number(
				await this.client.eval(LOGOUT, {
					keys: [this.keyFor("logout-jti", claims.jti), marker],
					arguments: [String(claims.iat), String(ABSOLUTE_MS + 300_000)],
				}),
			) === 1
		);
	}
	async audit(event, actor = "anonymous", target = "none") {
		const key = `${prefix}${this.workspace}:audit`;
		await this.client.eval(
			"redis.call('XADD',KEYS[1],'MAXLEN','~',10000,'*','event',ARGV[1],'actor',ARGV[2],'target',ARGV[3]); redis.call('XTRIM',KEYS[1],'MINID',ARGV[4]); redis.call('EXPIRE',KEYS[1],604800); return 1",
			{
				keys: [key],
				arguments: [
					event,
					digest(actor),
					digest(target),
					`${Math.max(0, this.now() - 7 * 86400_000)}-0`,
				],
			},
		);
	}
	async membership(sub) {
		const key = this.keyFor("member", sub);
		return this.decode(key, await this.client.get(key));
	}
	async bootstrap(sub) {
		const key = this.keyFor("member", sub);
		await this.indexMember(sub);
		return this.client.set(
			key,
			this.encode(key, {
				role: "breinhap.admin",
				active: true,
				version: randomBytes(16).toString("hex"),
			}),
			{ NX: true },
		);
	}
	async revokeMember(sub) {
		await this.client.del(this.keyFor("member", sub));
		await this.client.eval(REMOVE, { keys: this.memberKeys(digest(sub)), arguments: [digest(sub)] });
		await this.rejectRequest(digest(sub));
	}
	// The administrator's list of people (breinhap#signup): who each member is, so nobody has to type an
	// account code. A JSON list of member digests and one encrypted { subject, profile } entry each, kept
	// like the role requests (plain GET/SET in scripts: the deployed Redis ACL allows no hash commands).
	// Kept up to date when someone becomes or stops being a member, and filled in on a member's next
	// visit for members from before it.
	memberKeys(id) {
		const base = `${prefix}${this.workspace}:`;
		return [`${base}member-ids`, `${base}member-entry:${id}`];
	}
	async indexMember(subject, profile = {}, { replace = false } = {}) {
		const id = digest(subject);
		const keys = this.memberKeys(id);
		// the common case (every request of a member already listed) is one EXISTS, no script
		if (!replace && (await this.client.exists(keys[1]))) return;
		await this.client.eval(INDEX, {
			keys,
			arguments: [id, this.encode(keys[1], { subject, profile: cleanProfile(profile) }), replace ? "1" : "0", String(MAX_MEMBERS)],
		});
	}
	/** Current members with their role and profile, by name. Entries whose membership ended are dropped. */
	async members() {
		const ids = JSON.parse((await this.client.get(this.memberKeys("")[0])) ?? "[]");
		const people = [];
		for (const id of Array.isArray(ids) ? ids : []) {
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) continue;
			const keys = this.memberKeys(id);
			let entry;
			try {
				entry = this.decode(keys[1], await this.client.get(keys[1]));
			} catch {
				continue;
			}
			const membership = entry ? await this.membership(entry.subject) : null;
			if (membership?.active !== true) {
				await this.client.eval(REMOVE, { keys, arguments: [id] });
				continue;
			}
			people.push({ subject: entry.subject, role: membership.role, profile: entry.profile ?? {} });
		}
		return people.sort((a, b) => labelOf(a).localeCompare(labelOf(b), "nl"));
	}
	requestKeys(id) {
		const base = `${prefix}${this.workspace}:`;
		return [`${base}requests`, `${base}request:${id}`];
	}
	// A signed-in adult asks for one self-service role. Returns "created", "exists" or "full".
	async requestRole(subject, role, profile = {}) {
		if (!SELF_SERVICE_ROLES.includes(role)) throw new Error("Invalid role");
		const id = digest(subject);
		const keys = this.requestKeys(id);
		const result = Number(
			await this.client.eval(REQUEST, {
				keys,
				arguments: [
					id,
					this.encode(keys[1], { subject, role, profile: cleanProfile(profile), at: this.now() }),
					String(MAX_PENDING_REQUESTS),
				],
			}),
		);
		return result === 1 ? "created" : result === 2 ? "exists" : "full";
	}
	async roleRequest(subject) {
		const key = this.requestKeys(digest(subject))[1];
		return this.decode(key, await this.client.get(key));
	}
	async roleRequests() {
		const ids = JSON.parse(
			(await this.client.get(this.requestKeys("")[0])) ?? "[]",
		);
		const requests = [];
		for (const id of Array.isArray(ids) ? ids : []) {
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) continue;
			const key = this.requestKeys(id)[1];
			const value = this.decode(key, await this.client.get(key));
			if (value) requests.push({ id, ...value });
		}
		return requests.sort((a, b) => a.at - b.at);
	}
	async rejectRequest(id) {
		return (
			Number(
				await this.client.eval(REMOVE, {
					keys: this.requestKeys(id),
					arguments: [id],
				}),
			) === 1
		);
	}
	async approveRequest(id, approver, approverVersion) {
		const keys = this.requestKeys(id);
		const raw = await this.client.get(keys[1]);
		if (!raw) return false;
		const request = this.decode(keys[1], raw);
		if (!SELF_SERVICE_ROLES.includes(request.role)) return false;
		const approverKey = this.keyFor("member", approver);
		const current = await this.client.get(approverKey);
		if (
			!current ||
			this.decode(approverKey, current).version !== approverVersion
		)
			return false;
		const recipient = this.keyFor("member", request.subject);
		const approved =
			Number(
				await this.client.eval(APPROVE, {
					keys: [...keys, approverKey, recipient],
					arguments: [
						id,
						raw,
						current,
						this.encode(recipient, {
							role: request.role,
							active: true,
							version: randomBytes(16).toString("hex"),
						}),
					],
				}),
			) === 1;
		if (approved) await this.indexMember(request.subject, request.profile, { replace: true });
		return approved;
	}
	async invite(token, data) {
		const memberKey = this.keyFor("member", data.inviter);
		const current = await this.client.get(memberKey);
		if (
			!current ||
			this.decode(memberKey, current).version !== data.inviterVersion
		)
			return false;
		const key = this.keyFor("invite", token);
		return (
			Number(
				await this.client.eval(
					"if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end local ok=redis.call('SET',KEYS[2],ARGV[2],'EX',86400,'NX'); if ok then return 1 end return 0",
					{
						keys: [memberKey, key],
						arguments: [current, this.encode(key, data)],
					},
				),
			) === 1
		);
	}
	async invitation(token) {
		const key = this.keyFor("invite", token);
		const raw = await this.client.get(key);
		return { data: this.decode(key, raw), raw };
	}
	async accept(token, invitation, inviter, subject) {
		const memberKey = this.keyFor("member", invitation.data.inviter);
		const current = await this.client.get(memberKey);
		if (!current || this.decode(memberKey, current).version !== inviter.version)
			return false;
		const recipient = this.keyFor("member", subject);
		const value = {
			role: invitation.data.role,
			active: true,
			version: randomBytes(16).toString("hex"),
		};
		return (
			Number(
				await this.client.eval(ACCEPT, {
					keys: [this.keyFor("invite", token), memberKey, recipient],
					arguments: [invitation.raw, current, this.encode(recipient, value)],
				}),
			) === 1
		);
	}
}

/**
 * `socketTimeout` is the client's idle timeout: it destroys a socket that received nothing for that long, even
 * with nothing in flight. With the offline queue off, a request that arrived while the socket was reconnecting
 * then failed ("session store unavailable"), which at pilot traffic is every few seconds of quiet. A PING well
 * inside the timeout keeps a healthy connection busy, so only a connection that really stopped answering is dropped
 * (`ping` is in the deployed Redis user's command list).
 */
export async function connectStore({ url, secret, workspace, socketTimeout = 5000, pingInterval = 2000 }) {
	const client = createClient({
		url,
		disableOfflineQueue: true,
		commandsQueueMaxLength: 1000,
		pingInterval,
		socket: {
			connectTimeout: 5000,
			socketTimeout,
			reconnectStrategy: (retries) =>
				Math.min(100 * 2 ** Math.min(retries, 5), 2000),
		},
	});
	client.on("error", () =>
		console.error("Management session store unavailable"),
	);
	await client.connect();
	return new IdentityStore({ client, secret, workspace });
}
