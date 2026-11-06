// VENDORED from asafarim-os packages/app-sdk/src/headless.ts (@asafarim/app-sdk 0.2.0, compiled).
// Do not edit here: change it in asafarim-os, rebuild, and copy dist/headless.js over this file.
/**
 * Headless sign-in (`@asafarim/app-sdk/headless`): for a trusted first-party app that shows its own
 * sign-in and registration pages, in its own style and language, while the account stays in
 * core/identity (one account per person across ASafariM apps).
 *
 * Server-side only: it sends the app's client secret. Never import it in browser code.
 *
 *   const auth = createHeadlessAuth({ issuer, clientId, clientSecret });
 *   const { challenge } = await auth.startEmail({ email, locale: "nl", intent: "register", clientIp });
 *   // identity e-mails a 6-digit code naming the app; the person types it on the app's own page
 *   const result = await auth.verifyEmail({ challenge, email, code, clientIp });
 *   if (result.ok) startAppSession(result.sub, result.email);
 *   // later, on each request (cache it briefly): is this account still allowed in this app?
 *   const { active } = await auth.principal(result.sub);
 *
 * No dependencies; works on Node 18+ (global fetch). The identity side is core/identity/src/headless.ts.
 */
export class HeadlessUnavailable extends Error {
    status;
    constructor(status) {
        super(`identity answered ${status}`);
        this.status = status;
        this.name = "HeadlessUnavailable";
    }
}
export function createHeadlessAuth(options) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(issuer.hostname) &&
        !issuer.hostname.endsWith(".localhost"))
        throw new Error("The identity issuer must use https");
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(options.clientId))
        throw new Error("Invalid client id");
    if (!options.clientSecret || options.clientSecret.length < 32)
        throw new Error("The client secret must have at least 32 characters");
    const doFetch = options.fetch ?? fetch;
    const authorization = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString("base64")}`;
    async function post(path, body) {
        const res = await doFetch(new URL(path, issuer), {
            method: "POST",
            headers: { authorization, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        });
        let data = {};
        try {
            data = (await res.json());
        }
        catch {
            /* not JSON: treated as unavailable below */
        }
        if (res.status === 401 || res.status >= 500 || typeof data !== "object" || data === null) {
            if (res.status === 503 && data?.error === "send_failed")
                return { status: res.status, data };
            throw new HeadlessUnavailable(res.status);
        }
        return { status: res.status, data };
    }
    const retry = (data) => typeof data.retry_after === "number" ? { retryAfter: data.retry_after } : {};
    const ip = (clientIp) => (clientIp ? { client_ip: clientIp } : {});
    return {
        async startEmail({ email, locale, intent, clientIp }) {
            try {
                const { status, data } = await post("/headless/v1/email/start", { email, locale, intent, ...ip(clientIp) });
                if (status === 202 && typeof data.challenge === "string")
                    return { ok: true, challenge: data.challenge, expiresIn: Number(data.expires_in ?? 300) };
                return { ok: false, error: data.error ?? "unavailable", ...retry(data) };
            }
            catch {
                return { ok: false, error: "unavailable" };
            }
        },
        async verifyEmail({ challenge, email, code, clientIp }) {
            try {
                const { status, data } = await post("/headless/v1/email/verify", { challenge, email, code, ...ip(clientIp) });
                if (status === 200 && typeof data.sub === "string" && typeof data.email === "string")
                    return { ok: true, sub: data.sub, email: data.email, connected: data.connected === true };
                return { ok: false, error: data.error ?? "unavailable", ...retry(data) };
            }
            catch {
                return { ok: false, error: "unavailable" };
            }
        },
        async principal(sub) {
            const { status, data } = await post("/headless/v1/principal", { sub });
            if (status !== 200)
                throw new HeadlessUnavailable(status);
            return { active: data.active === true, ...(typeof data.email === "string" ? { email: data.email } : {}) };
        },
    };
}
