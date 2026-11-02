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
import { localDay } from "../store/backup.js";
import { type Connected, cli, connect, storeHome } from "../store/testing.js";

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
	/** Make the next runs fail the way an unreachable host does. */
	unreachable(): void;
	/** Make the next runs work again. */
	reachable(): void;
}

function remote(): Remote {
	const root = mkdtempSync(join(tmpdir(), "lattice-remote-"));
	const dir = join(root, "far", "lattice-backups");
	const log = join(root, "ssh.log");
	const script = join(root, "ssh");
	const works = [
		"#!/bin/sh",
		`echo "$@" >> '${log}'`,
		"for last; do :; done",
		'exec sh -c "$last"',
		"",
	].join("\n");
	const refuses = [
		"#!/bin/sh",
		`echo "$@" >> '${log}'`,
		"cat > /dev/null",
		'echo "ssh: connect to host ryzen-9 port 22: Connection refused" >&2',
		"exit 255",
		"",
	].join("\n");
	const install = (text: string): void => {
		writeFileSync(script, text);
		chmodSync(script, 0o755);
	};
	install(works);
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
		unreachable: () => install(refuses),
		reachable: () => install(works),
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

const today = `store-${localDay(new Date())}.db`;

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
		away.unreachable();
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
		away.unreachable();
		const home = await storeHome();
		const { call } = await session(home, away.env);
		await call("append", { note: "research/exa-limits", text: "One." });
		await eventually(
			async () => (await call("stats")).body.remote_copy.error !== null,
		);
		away.reachable();

		// A quarter hour on, as the marker would show.
		const marker = join(home, "backups", ".remote-copy.json");
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

describe("lattice backup --remote", () => {
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
		away.unreachable();
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

	test("without --remote it only takes the snapshot, even when a place is set", async () => {
		const away = remote();
		const home = await storeHome();

		const result = await cli(home, ["backup"], away.env);

		expect(result.code).toBe(0);
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
