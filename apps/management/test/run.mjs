import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

let container;
const env = { ...process.env };
try {
	if (!env.REDIS_TEST_URL) {
		container = `breinhap-auth-test-${randomBytes(6).toString("hex")}`;
		const started = spawnSync(
			"docker",
			[
				"run",
				"--rm",
				"-d",
				"--name",
				container,
				"--memory",
				"64m",
				"--cpus",
				"0.25",
				"-p",
				"127.0.0.1::6379",
				"redis:7-alpine",
				"redis-server",
				"--save",
				"",
				"--appendonly",
				"no",
			],
			{ encoding: "utf8" },
		);
		if (started.status !== 0)
			throw new Error(
				"Tests need Docker or an isolated Redis supplied through REDIS_TEST_URL",
			);
		const endpoint = spawnSync("docker", ["port", container, "6379/tcp"], {
			encoding: "utf8",
		}).stdout.trim();
		if (!/^127\.0\.0\.1:\d+$/.test(endpoint))
			throw new Error("Unexpected test Redis binding");
		env.REDIS_TEST_URL = `redis://${endpoint}`;
	}
	const child = spawn(process.execPath, ["--test", "test/*.test.mjs"], {
		env,
		stdio: "inherit",
	});
	process.exitCode = await new Promise((resolve) =>
		child.on("exit", (code) => resolve(code ?? 1)),
	);
} finally {
	if (container)
		spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}
