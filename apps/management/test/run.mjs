import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const containers = [];
const env = { ...process.env };
let child;
const cleanup = () => {
	for (const container of containers.splice(0))
		spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
};
/** Starts a throwaway container bound to a random localhost port; returns "127.0.0.1:<port>". */
function startContainer(kind, port, args) {
	const container = `breinhap-${kind}-test-${randomBytes(6).toString("hex")}`;
	const started = spawnSync(
		"docker",
		["run", "--rm", "-d", "--name", container, "-p", `127.0.0.1::${port}`, ...args],
		{ encoding: "utf8" },
	);
	if (started.status !== 0) return null;
	containers.push(container);
	const endpoint = spawnSync("docker", ["port", container, `${port}/tcp`], {
		encoding: "utf8",
	}).stdout.trim();
	if (!/^127\.0\.0\.1:\d+$/.test(endpoint))
		throw new Error(`Unexpected test ${kind} binding`);
	return { container, endpoint };
}
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
])
	process.once(signal, () => {
		child?.kill(signal);
		cleanup();
		process.exit(code);
	});
try {
	if (!env.REDIS_TEST_URL) {
		const redis = startContainer("redis", 6379, [
			"--memory",
			"64m",
			"--cpus",
			"0.25",
			"redis:7-alpine",
			"redis-server",
			"--save",
			"",
			"--appendonly",
			"no",
		]);
		if (!redis)
			throw new Error(
				"Tests need Docker or an isolated Redis supplied through REDIS_TEST_URL",
			);
		env.REDIS_TEST_URL = `redis://${redis.endpoint}`;
	}
	// breinhap#25: the directory tests create (and drop) their own databases on this server
	if (!env.POSTGRES_TEST_URL) {
		const password = randomBytes(12).toString("hex");
		const postgres = startContainer("postgres", 5432, [
			"--memory",
			"256m",
			"-e",
			`POSTGRES_PASSWORD=${password}`,
			"postgres:17-alpine",
			"-c",
			"fsync=off",
		]);
		if (!postgres)
			throw new Error(
				"Tests need Docker or a disposable Postgres supplied through POSTGRES_TEST_URL",
			);
		for (let attempt = 0; ; attempt++) {
			const ready = spawnSync("docker", [
				"exec",
				postgres.container,
				"pg_isready",
				"-U",
				"postgres",
				"-h",
				"127.0.0.1",
			]);
			if (ready.status === 0) break;
			if (attempt > 60) throw new Error("Test Postgres did not start");
			spawnSync("sleep", ["0.5"]);
		}
		env.POSTGRES_TEST_URL = `postgres://postgres:${password}@${postgres.endpoint}/postgres`;
	}
	child = spawn(process.execPath, ["--test", "test/*.test.mjs"], {
		env,
		stdio: "inherit",
	});
	process.exitCode = await new Promise((resolve) =>
		child.on("exit", (code) => resolve(code ?? 1)),
	);
} finally {
	cleanup();
}
