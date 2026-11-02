import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyName } from "../store/backup.js";
import { copySnapshot, parseRemote } from "../store/remote.js";
import { type Connected, cli, connect, storeHome } from "../store/testing.js";
import { remoteLockPath, resolvePaths } from "../utils/paths.js";

/**
 * The copy of the day's snapshot to another machine. The other machine is a
 * stand-in `ssh` that runs the remote command here, in a folder of the test's,
 * and logs each call: the real one is the same command over a real connection.
 */

const open: Connected[] = [];
afterEach(async () => {
	for (const session of open.splice(0)) {
		await session.close();
	}
});

interface Remote {
	/** The folder the "other machine" writes into. */
	dir: string;
	/** `LATTICE_SSH` and `LATTICE_BACKUP_REMOTE` for a session. */
	env: Record<string, string>;
	/** How many times ssh was run. */
	calls(): number;
	/** How the connection behaves from now on. */
	behave(mode: Mode): void;
}

type Mode =
	| "works"
	/** A host that refuses the connection. */
	| "unreachable"
	/** A link that drops after 4,096 bytes and says so (ssh exits 255). */
	| "drops"
	/** The same, but ssh passes on the far side's own exit status. */
	| "ends-early"
	/** One byte of the stream changed on the way, the length the same. */
	| "corrupts"
	/** Takes a second to connect, then works. */
	| "slow"
	/** Never answers. */
	| "hangs";

const SCRIPTS: Record<Mode, string[]> = {
	works: ["for last; do :; done", 'exec sh -c "$last"'],
	unreachable: [
		"cat > /dev/null",
		'echo "ssh: connect to host ryzen-9 port 22: Connection refused" >&2',
		"exit 255",
	],
	drops: [
		"for last; do :; done",
		'head -c 4096 | sh -c "$last"',
		'echo "Connection to ryzen-9 closed by remote host." >&2',
		"exit 255",
	],
	"ends-early": ["for last; do :; done", 'head -c 4096 | sh -c "$last"'],
	corrupts: [
		"for last; do :; done",
		`python3 -c "import sys;d=bytearray(sys.stdin.buffer.read());d[100]^=1;sys.stdout.buffer.write(d)" | sh -c "$last"`,
	],
	slow: ["for last; do :; done", "sleep 1", 'exec sh -c "$last"'],
	hangs: ["sleep 4"],
};

function remote(folder?: string): Remote {
	const root = mkdtempSync(join(tmpdir(), "lattice-remote-"));
	const dir = folder ?? join(root, "far", "lattice-backups");
	const log = join(root, "ssh.log");
	const script = join(root, "ssh");
	const behave = (mode: Mode): void => {
		writeFileSync(
			script,
			["#!/bin/sh", `echo called >> '${log}'`, ...SCRIPTS[mode], ""].join("\n"),
		);
		chmodSync(script, 0o755);
	};
	behave("works");
	return {
		dir,
		env: {
			LATTICE_SSH: script,
			LATTICE_BACKUP_REMOTE: `uptown@ryzen-9:${dir}`,
		},
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8").split("\n").filter(Boolean).length
				: 0,
		behave,
	};
}

async function session(
	home: string,
	env: Record<string, string>,
): Promise<Connected> {
	const connected = await connect(home, { env });
	open.push(connected);
	return connected;
}

/** Wait until `check` holds; the copy runs in the background after the write returns. */
async function eventually(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for the background copy.");
		}
		await Bun.sleep(25);
	}
}

const today = dailyName();

describe("the daily copy off the Mac", () => {
	test("the first write of the day sends the day's snapshot, whole, and stats says when it arrived", async () => {
		const away = remote();
		const home = await storeHome();
		const { call } = await session(home, away.env);

		const written = await call("append", {
			note: "research/exa-limits",
			text: "First write.",
		});

		expect(written.isError).toBe(false);
		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);
		const copy = join(away.dir, today);
		expect(readFileSync(copy).subarray(0, 15).toString()).toBe(
			"SQLite format 3",
		);
		expect(statSync(copy).size).toBe(
			statSync(join(home, "backups", today)).size,
		);
		expect((await call("stats")).body.remote_copy).toMatchObject({
			target: `uptown@ryzen-9:${away.dir}`,
			error: null,
		});
		// Nothing half-sent is left beside it.
		expect(readdirSync(away.dir)).toEqual([today]);
	});

	test("later writes the same day send nothing more", async () => {
		const away = remote();
		const { call } = await session(await storeHome(), away.env);
		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);

		await call("append", { note: "research/exa-limits", text: "Two." });
		await call("append", { note: "research/exa-limits", text: "Three." });
		await Bun.sleep(300);

		expect(away.calls()).toBe(1);
	});

	test("a host that is down costs the write nothing, is reported, and is not asked again at once", async () => {
		const away = remote();
		away.behave("unreachable");
		const { call } = await session(await storeHome(), away.env);

		const written = await call("append", {
			note: "research/exa-limits",
			text: "Written while the host is down.",
		});
		await eventually(
			async () => (await call("stats")).body.remote_copy.error !== null,
		);
		await call("append", { note: "research/exa-limits", text: "Again." });
		await Bun.sleep(300);

		expect(written.isError).toBe(false);
		const { remote_copy } = (await call("stats")).body;
		expect(remote_copy.error).toContain("Connection refused");
		expect(remote_copy.last_ok).toBeNull();
		expect(away.calls()).toBe(1);
	});

	test("after a pause it tries again, and the copy then arrives", async () => {
		const away = remote();
		away.behave("unreachable");
		const home = await storeHome();
		const { call } = await session(home, away.env);
		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(
			async () => (await call("stats")).body.remote_copy.error !== null,
		);
		away.behave("works");

		// A quarter hour on, as the marker would show.
		const marker = resolvePaths({ LATTICE_HOME: home }).remoteCopy;
		const record = JSON.parse(readFileSync(marker, "utf8"));
		record.attempted_at = new Date(Date.now() - 16 * 60_000).toISOString();
		writeFileSync(marker, JSON.stringify(record));
		await call("append", { note: "research/exa-limits", text: "Two." });

		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);
		expect((await call("stats")).body.remote_copy.error).toBeNull();
		expect(existsSync(join(away.dir, today))).toBe(true);
		expect(away.calls()).toBe(2);
	});

	test("the other side keeps the newest 30 daily snapshots and the newest 30 taken by hand", async () => {
		const away = remote();
		mkdirSync(away.dir, { recursive: true });
		for (let day = 1; day <= 35; day++) {
			const d = String(day).padStart(2, "0");
			writeFileSync(join(away.dir, `store-2026-01-${d}.db`), "old");
			writeFileSync(join(away.dir, `store-2026-01-${d}T120000.db`), "old");
		}
		writeFileSync(join(away.dir, "notes.txt"), "not a snapshot");
		const { call } = await session(await storeHome(), away.env);

		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(() => existsSync(join(away.dir, today)));
		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);

		const kept = readdirSync(away.dir);
		const daily = kept.filter((name) =>
			/^store-\d{4}-\d\d-\d\d\.db$/.test(name),
		);
		const byHand = kept.filter((name) => name.includes("T"));
		expect(daily).toHaveLength(30);
		expect(daily).toContain(today);
		expect(daily).not.toContain("store-2026-01-01.db");
		expect(byHand).toHaveLength(30);
		expect(kept).toContain("notes.txt");
	});

	test("with no place named nothing is run, and stats says it is not set up", async () => {
		const away = remote();
		const { call } = await session(await storeHome(), {
			LATTICE_SSH: away.env.LATTICE_SSH,
		});

		await call("append", { note: "research/exa-limits", text: "One." });
		await Bun.sleep(200);

		expect(away.calls()).toBe(0);
		expect((await call("stats")).body.remote_copy).toEqual({
			target: null,
			last_ok: null,
			last_ok_age: null,
			last_attempt: null,
			error: null,
		});
	});

	test("a place that is not host:folder is reported, and the write still lands", async () => {
		const away = remote();
		const { call } = await session(await storeHome(), {
			LATTICE_SSH: away.env.LATTICE_SSH,
			LATTICE_BACKUP_REMOTE: "ryzen-9",
		});

		const written = await call("append", {
			note: "research/exa-limits",
			text: "One.",
		});

		expect(written.isError).toBe(false);
		expect(away.calls()).toBe(0);
		expect((await call("stats")).body.remote_copy.error).toContain(
			"must look like host:folder",
		);
	});
});

describe("lattice backup and the copy off the Mac", () => {
	test("takes a snapshot and copies it to the place named", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(home, ["backup", "--remote"], away.env);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Snapshot written:");
		expect(result.stdout).toContain(
			`Copied to uptown@ryzen-9:${away.dir}/store-`,
		);
		const [local] = readdirSync(join(home, "backups")).filter((n) =>
			n.startsWith("store-"),
		);
		expect(readdirSync(away.dir)).toEqual([local]);
		const status = await cli(home, ["status"], away.env);
		expect(status.stdout).toContain(`to uptown@ryzen-9:${away.dir}`);
	});

	test("takes the place from the command line when the environment names none", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(
			home,
			["backup", "--remote", `me@elsewhere:${away.dir}`],
			{ LATTICE_SSH: away.env.LATTICE_SSH },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Copied to me@elsewhere:${away.dir}/store-`,
		);
		expect(readdirSync(away.dir)).toHaveLength(1);
	});

	test("keeps the snapshot and exits 1 with the reason when the copy fails", async () => {
		const away = remote();
		away.behave("unreachable");
		const home = await storeHome();

		const result = await cli(home, ["backup", "--remote"], away.env);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Snapshot written:");
		expect(result.stderr).toContain("The snapshot is kept here");
		expect(result.stderr).toContain("Connection refused");
		expect(
			readdirSync(join(home, "backups")).filter((n) => n.startsWith("store-")),
		).toHaveLength(1);
		expect((await cli(home, ["status"], away.env)).stdout).toContain(
			"Connection refused",
		);
	});

	test("says what to set when no place is named", async () => {
		const home = await storeHome();

		const result = await cli(home, ["backup", "--remote"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("LATTICE_BACKUP_REMOTE");
		expect(existsSync(join(home, "backups"))).toBe(false);
	});

	test("a plain backup copies too when a place is set, as the server does", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(home, ["backup"], away.env);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Copied to uptown@ryzen-9:${away.dir}/store-`,
		);
		expect(away.calls()).toBe(1);
	});

	test("a plain backup with no place set only takes the snapshot", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(home, ["backup"], {
			LATTICE_SSH: away.env.LATTICE_SSH,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("Copied");
		expect(away.calls()).toBe(0);
	});

	test("refuses a place ssh would read as an option", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(
			home,
			["backup", "--remote=-oProxyCommand=x:dir"],
			away.env,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("a host ssh would not take");
		expect(away.calls()).toBe(0);
	});
});

/** What is on the far side: whole snapshots and anything half-sent. */
function farFiles(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir) : [];
}

describe("a copy that does not arrive whole leaves nothing on the far side", () => {
	for (const mode of ["drops", "ends-early", "corrupts"] as const) {
		test(`when the link ${mode === "drops" ? "drops after 4,096 bytes" : mode === "ends-early" ? "ends early and ssh reports the far side's status" : "changes a byte"}`, async () => {
			const away = remote();
			away.behave(mode);
			const home = await storeHome();

			const result = await cli(home, ["backup"], away.env);

			expect(result.code).toBe(1);
			expect(result.stdout).toContain("Snapshot written:");
			expect(result.stderr).toContain("copying it to");
			if (mode === "ends-early") {
				expect(result.stderr).toMatch(/received 4096 of \d+ bytes/);
			}
			if (mode === "corrupts") {
				expect(result.stderr).toContain("checksum differs");
			}
			expect(farFiles(away.dir)).toEqual([]);
		});
	}

	test("and the next copy, over a good link, lands whole beside no leftovers", async () => {
		const away = remote();
		away.behave("drops");
		const home = await storeHome();
		await cli(home, ["backup"], away.env);

		away.behave("works");
		const again = await cli(home, ["backup"], away.env);

		expect(again.code).toBe(0);
		const kept = farFiles(away.dir);
		expect(kept).toHaveLength(1);
		const [local] = readdirSync(join(home, "backups")).filter((n) =>
			n.startsWith("store-"),
		);
		expect(statSync(join(away.dir, kept[0])).size).toBeGreaterThan(4096);
		expect(kept[0].startsWith("store-")).toBe(true);
		expect(local).toBeDefined();
	});
});

describe("several sessions copying at once", () => {
	test("while one server copies the day's snapshot, another sends nothing, and the file that lands is whole", async () => {
		const away = remote();
		away.behave("slow");
		const home = await storeHome();
		const a = await session(home, away.env);
		const b = await session(home, away.env);

		await a.call("append", { note: "research/exa-limits", text: "From A." });
		await b.call("append", { note: "research/exa-limits", text: "From B." });
		await eventually(
			async () => (await a.call("stats")).body.remote_copy.last_ok !== null,
		);
		await Bun.sleep(300);

		expect(away.calls()).toBe(1);
		expect(farFiles(away.dir)).toEqual([today]);
		expect(
			Buffer.compare(
				readFileSync(join(away.dir, today)),
				readFileSync(join(home, "backups", today)),
			),
		).toBe(0);
		expect(existsSync(remoteLockPath(join(home, "backups"), today))).toBe(
			false,
		);
	});

	test("two copies of one snapshot started together: one runs, the other says it was busy", async () => {
		const away = remote();
		away.behave("slow");
		const home = await storeHome();
		const paths = resolvePaths({ LATTICE_HOME: home });
		await cli(home, ["backup"]);
		const file = join(
			paths.backups,
			readdirSync(paths.backups).find((n) => n.startsWith("store-")) ?? "",
		);
		const target = parseRemote(away.env.LATTICE_BACKUP_REMOTE);

		const [first, second] = await Promise.all([
			copySnapshot(paths, file, target, away.env),
			copySnapshot(paths, file, target, away.env),
		]);

		expect([first.ok, second.ok].sort()).toEqual([false, true]);
		const busy = first.ok ? second : first;
		expect(busy.busy).toBe(true);
		expect(away.calls()).toBe(1);
		expect(farFiles(away.dir)).toHaveLength(1);
	});

	test("a lock left by a copy that is gone does not stop the next one", async () => {
		const away = remote();
		const home = await storeHome();
		const dir = join(home, "backups");
		mkdirSync(dir, { recursive: true });
		const dead = Bun.spawnSync(["true"]);
		writeFileSync(
			remoteLockPath(dir, today),
			JSON.stringify({ pid: dead.pid, at: Date.now() }),
		);
		const { call } = await session(home, away.env);

		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);

		expect(farFiles(away.dir)).toEqual([today]);
	});

	test("nor does a lock older than a copy may run", async () => {
		const away = remote();
		const home = await storeHome();
		const dir = join(home, "backups");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			remoteLockPath(dir, today),
			JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60_000 }),
		);
		const { call } = await session(home, away.env);

		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(
			async () => (await call("stats")).body.remote_copy.last_ok !== null,
		);

		expect(farFiles(away.dir)).toEqual([today]);
	});
});

describe("how old the last good copy is", () => {
	test("a failure after a good copy shows the error and the age of the good one", async () => {
		const away = remote();
		const home = await storeHome();
		await cli(home, ["backup"], away.env);
		const marker = resolvePaths({ LATTICE_HOME: home }).remoteCopy;
		const record = JSON.parse(readFileSync(marker, "utf8"));
		record.last_ok_at = new Date(Date.now() - 3 * 3_600_000).toISOString();
		writeFileSync(marker, JSON.stringify(record));
		away.behave("unreachable");

		const failed = await cli(home, ["backup"], away.env);
		const status = await cli(home, ["status"], away.env);
		const { call } = await session(home, away.env);
		const stats = (await call("stats")).body.remote_copy;

		expect(failed.code).toBe(1);
		expect(status.stdout).toContain("Connection refused");
		expect(status.stdout).toContain(
			`last good copy ${record.last_ok_at}, 3 h ago`,
		);
		expect(stats.error).toContain("Connection refused");
		expect(stats.last_ok).toBe(record.last_ok_at);
		expect(stats.last_ok_age).toBe("3 h");
	});

	test("a copy that just arrived says so", async () => {
		const away = remote();
		const home = await storeHome();
		await cli(home, ["backup"], away.env);

		const status = await cli(home, ["status"], away.env);

		expect(status.stdout).toMatch(/Off Mac: {3}last copy \S+ \(just now\)/);
	});
});

describe("a host that never answers", () => {
	test("does not slow a write, or the answers around it", async () => {
		const away = remote();
		away.behave("hangs");
		const { call } = await session(await storeHome(), away.env);

		const started = performance.now();
		const written = await call("append", {
			note: "research/exa-limits",
			text: "While the host hangs.",
		});
		const stats = await call("stats");
		const elapsed = performance.now() - started;

		expect(written.isError).toBe(false);
		expect(stats.isError).toBe(false);
		expect(elapsed).toBeLessThan(1500);
		await eventually(() => away.calls() === 1);
		expect(stats.body.remote_copy.last_ok).toBeNull();
	});
});

describe("a folder named relative to the login folder", () => {
	test("is read from there whatever CDPATH holds", async () => {
		const login = mkdtempSync(join(tmpdir(), "lattice-login-"));
		const decoy = mkdtempSync(join(tmpdir(), "lattice-decoy-"));
		mkdirSync(join(decoy, "lattice-backups"));
		const away = remote("lattice-backups");
		// Log in to the folder, with CDPATH pointing at a place that has a folder of that name.
		const script = away.env.LATTICE_SSH;
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				`cd '${login}'`,
				`export CDPATH='${decoy}'`,
				"for last; do :; done",
				'exec sh -c "$last"',
				"",
			].join("\n"),
		);
		const home = await storeHome();

		const result = await cli(home, ["backup"], away.env);

		expect(result.code).toBe(0);
		expect(readdirSync(join(login, "lattice-backups"))).toHaveLength(1);
		expect(readdirSync(join(decoy, "lattice-backups"))).toEqual([]);
	});
});
