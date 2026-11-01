import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import {
	backupNow,
	dailyBackup,
	dailyIn,
	KEEP,
	manualIn,
	snapshotsIn,
} from "../store/backup.js";
import { EXPORT_MANIFEST, EXPORT_MARK } from "../store/export.js";
import { openStore } from "../store/open.js";
import {
	BUNDLE,
	type Connected,
	cli,
	connect,
	freshHome,
	storeHome,
} from "../store/testing.js";
import { normalizeDates, parseConcept } from "../sync/okf.js";

/**
 * The commands that go with the writing tools, through the CLI's one entry
 * point: `history`, `revert`, `export` and `backup`. The changes they work on
 * are made through the server, because that is how an agent makes them.
 */

const open: Connected[] = [];
afterEach(async () => {
	for (const session of open.splice(0)) {
		await session.close();
	}
});

async function session(home: string): Promise<Connected> {
	const connected = await connect(home);
	open.push(connected);
	return connected;
}

describe("lattice history", () => {
	test("lists the changes to a note, newest first, and one change in full", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const made = await call("edit", {
			note: "research/exa-limits",
			edits: [{ old: "cannot match", new: "cannot reliably match" }],
			reason: "softer",
		});

		const list = await cli(home, ["history", "research/exa-limits"]);
		const one = await cli(home, [
			"history",
			"--change",
			String(made.body.change),
		]);

		expect(list.code).toBe(0);
		const changes = JSON.parse(list.stdout).changes;
		expect(changes.map((c: { kind: string }) => c.kind)).toEqual([
			"edit",
			"import",
		]);
		expect(changes[0].reason).toBe("softer");
		expect(JSON.parse(one.stdout)).toMatchObject({
			change: made.body.change,
			sections: [{ id: "s1", op: "update" }],
		});
	});

	test("a note that is not there is an error with what to do", async () => {
		const home = await storeHome();

		const result = await cli(home, ["history", "research/nope"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("There is no note named research/nope.");
	});

	test("with no store it says to import", async () => {
		const result = await cli(freshHome(), ["history"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Run `lattice import` first.");
	});
});

describe("lattice revert", () => {
	test("undoes one change as a new change, with a reason, and the server sees it", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const made = await call("append", {
			note: "research/exa-limits",
			text: "A wrong claim.",
		});

		const result = await cli(home, [
			"revert",
			String(made.body.change),
			"--reason",
			"it was wrong",
			"--by",
			"james",
		]);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			note: "research/exa-limits",
			version: 3,
		});
		const note = await call("read_note", { name: "research/exa-limits" });
		expect(JSON.stringify(note.body.text)).not.toContain("A wrong claim.");
		const log = await call("history", {
			note: "research/exa-limits",
			limit: 1,
		});
		expect(log.body).toMatchObject({
			changes: [
				{
					kind: "revert",
					reason: "it was wrong",
					who: { client: "lattice cli", by: "james" },
					undoes: made.body.change,
				},
			],
		});
	});

	test("puts a note back as at a version", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		await call("append", { note: "research/exa-limits", text: "One." });
		await call("append", { note: "research/exa-limits", text: "Two." });

		const result = await cli(home, [
			"revert",
			"research/exa-limits",
			"--version",
			"1",
			"--current",
			"3",
		]);

		expect(result.code).toBe(0);
		const note = await call("read_note", { name: "research/exa-limits" });
		expect(note.body.version).toBe(4);
		expect(JSON.stringify(note.body.text)).not.toContain("Two.");
	});

	test("a refused undo exits 1 and names the later change", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const a = await call("append", {
			note: "research/exa-limits",
			text: "One.",
		});
		const b = await call("append", {
			note: "research/exa-limits",
			text: "Two.",
		});

		const result = await cli(home, ["revert", String(a.body.change)]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Change ${b.body.change} (append`);
		expect(result.stderr).toContain(`Undo change ${b.body.change} first`);
	});

	test("without a change or a note it says what to give", async () => {
		const home = await storeHome();

		const result = await cli(home, ["revert"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("lattice history lists them");
	});
});

describe("lattice backup", () => {
	test("takes a snapshot now, every time it is asked, and stats reports the latest", async () => {
		const home = await storeHome();

		const first = await cli(home, ["backup"]);
		const second = await cli(home, ["backup"]);

		expect(first.code).toBe(0);
		expect(first.stdout).toContain(join(home, "backups", "store-"));
		expect(second.code).toBe(0);
		expect(readdirSync(join(home, "backups"))).toHaveLength(2);
		const status = await cli(home, ["status", "--store"]);
		expect(status.stdout).toMatch(/Backup: +last at \d{4}-/);
		const none = await cli(await storeHome(), ["status", "--store"]);
		expect(none.stdout).toContain("none yet");
	});

	test("a snapshot is a whole store that opens and holds the notes", async () => {
		const home = await storeHome();
		await cli(home, ["backup"]);

		const [name] = readdirSync(join(home, "backups"));
		const db = openStore(join(home, "backups", name));
		try {
			expect(
				db.query<{ n: number }, []>("SELECT count(*) AS n FROM concepts").get()
					?.n,
			).toBe(4);
			expect(
				db.query<{ n: number }, []>("SELECT count(*) AS n FROM sections").get()
					?.n,
			).toBeGreaterThan(4);
		} finally {
			db.close();
		}
	});

	test("snapshots asked for by hand never push the daily ones out, and the day's first write still takes its own", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		try {
			const dir = join(home, "backups");
			for (let day = 1; day <= KEEP; day++) {
				dailyBackup(db, dir, new Date(2026, 0, day, 9, 0, 0));
			}
			// Forty manual snapshots in one afternoon.
			for (let n = 0; n < 40; n++) {
				backupNow(db, dir, new Date(2026, 0, KEEP, 15, 0, n));
			}

			expect(dailyIn(dir)).toHaveLength(KEEP);
			expect(dailyIn(dir)[0]).toBe("store-2026-01-01.db");
			expect(manualIn(dir)).toHaveLength(KEEP);
			// A manual snapshot does not stand in for the day's own.
			expect(
				dailyBackup(db, dir, new Date(2026, 0, KEEP, 16, 0, 0)),
			).toBeNull();
			expect(
				dailyBackup(db, dir, new Date(2026, 0, KEEP + 1, 9, 0, 0)),
			).not.toBeNull();
			expect(dailyIn(dir)).toHaveLength(KEEP);
			expect(dailyIn(dir)[0]).toBe("store-2026-01-02.db");
		} finally {
			db.close();
		}
	});

	test("keeps the last 30 and drops the older ones", async () => {
		const home = await storeHome();
		const db = openStore(join(home, "store.db"));
		try {
			const dir = join(home, "backups");
			for (let day = 1; day <= KEEP + 5; day++) {
				backupNow(db, dir, new Date(2026, 0, day, 12, 0, 0));
			}

			const kept = snapshotsIn(dir);
			expect(kept).toHaveLength(KEEP);
			expect(kept[0]).toBe("store-2026-01-06T120000.db");
			expect(kept.at(-1)).toBe("store-2026-02-04T120000.db");
		} finally {
			db.close();
		}
	});
});

describe("lattice export", () => {
	test("writes one file per note under its type's folder, marked as a copy, with the note's own text", async () => {
		const home = await storeHome();
		const out = join(freshHome(), "copy");

		const result = await cli(home, ["export", out]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Exported 4 notes");
		expect(result.stdout).toContain("never reads it back");
		expect(
			[
				"research/exa-limits.md",
				"research/jev-reranker.md",
				"research/long-note.md",
				"topic/jev.md",
			].every((file) => existsSync(join(out, file))),
		).toBe(true);

		const raw = readFileSync(join(out, "research/jev-reranker.md"), "utf8");
		expect(raw.split("\n").slice(0, 2)).toEqual(["---", EXPORT_MARK]);
		const parsed = matter(raw);
		expect(parsed.data).toMatchObject({
			type: "Research",
			title: "Jev as a reranker",
			version: 1,
			checked: "0 of 3 sections",
		});
		expect(typeof parsed.data.exported_at).toBe("string");
	});

	test("a note exports to the same body and the same fields it was imported from", async () => {
		const home = await storeHome();
		const out = join(freshHome(), "copy");
		await cli(home, ["export", out]);

		for (const [path, original] of Object.entries(BUNDLE)) {
			const was = parseConcept(original);
			const exported = readFileSync(join(out, path), "utf8");
			const now = parseConcept(exported);
			expect(now.body).toBe(was.body);
			const { version, exported_at, checked, ...fields } =
				matter(exported).data;
			expect(version).toBe(1);
			expect(typeof exported_at).toBe("string");
			expect(checked).toMatch(/^0 of \d+ sections$/);
			// Dates are compared as the text an author writes (the YAML reader makes Dates).
			expect(normalizeDates(fields)).toEqual(
				normalizeDates(matter(original).data),
			);
		}
	});

	test("changes are in the export, and a link to a renamed note is written with its new name", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		await call("append", {
			note: "research/jev-reranker",
			text: "An exported finding.",
		});
		await call("confirm", {
			note: "research/jev-reranker",
			sections: [{ id: "s2", version: 2 }],
			james_said: "yes",
		});
		await call("rename_note", {
			note: "research/jev-reranker",
			title: "Jev as a Lattice reranker",
		});
		const out = join(freshHome(), "copy");

		await cli(home, ["export", out]);

		const renamed = readFileSync(
			join(out, "research/jev-as-a-lattice-reranker.md"),
			"utf8",
		);
		expect(existsSync(join(out, "research/jev-reranker.md"))).toBe(false);
		expect(matter(renamed).data).toMatchObject({
			title: "Jev as a Lattice reranker",
			version: 4,
			// The append touched s2 (Key findings, now at version 2), which James
			// then confirmed as read, so exactly one section is checked.
			checked: "1 of 3 sections",
		});
		expect(renamed).toContain("An exported finding.");
		// The hub linked to the old name; its copy links to the new one.
		const hub = readFileSync(join(out, "topic/jev.md"), "utf8");
		expect(hub).toContain("(../research/jev-as-a-lattice-reranker.md)");
		expect(hub).not.toContain("jev-reranker.md");
	});

	test("an export cannot be imported back", async () => {
		const home = await storeHome();
		const out = join(freshHome(), "copy");
		await cli(home, ["export", out]);
		const target = freshHome();

		const result = await cli(target, ["import", "--docs", out]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("is an export of the note store");
		expect(existsSync(join(target, "store.db"))).toBe(false);
	});

	test("a folder that holds anything but an earlier export is refused, and left as it was", async () => {
		const home = await storeHome();
		const out = freshHome();
		writeFileSync(join(out, "mine.txt"), "keep me");

		const result = await cli(home, ["export", out]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not a previous export");
		expect(readdirSync(out)).toEqual(["mine.txt"]);
	});

	test("the live bundle is never an export folder, nor a folder that holds it", async () => {
		const home = await storeHome();

		const into = await cli(home, ["export", join(home, "docs")]);
		const inside = await cli(home, ["export", join(home, "docs", "sub")]);
		const above = await cli(home, ["export", home]);

		for (const result of [into, inside, above]) {
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("live bundle");
		}
		expect(existsSync(join(home, "docs", "sub"))).toBe(false);
	});

	test("a re-export refreshes its own folder and removes the files of notes renamed or archived since", async () => {
		const home = await storeHome();
		const { call } = await session(home);
		const out = join(freshHome(), "copy");
		await cli(home, ["export", out]);
		expect(existsSync(join(out, "research/exa-limits.md"))).toBe(true);
		expect(existsSync(join(out, EXPORT_MANIFEST))).toBe(true);

		await call("rename_note", {
			note: "research/jev-reranker",
			title: "Jev, renamed",
		});
		await call("archive_note", { note: "research/exa-limits" });
		const again = await cli(home, ["export", out]);

		expect(again.code).toBe(0);
		expect(again.stdout).toContain("Exported 3 notes");
		expect(existsSync(join(out, "research/jev-reranker.md"))).toBe(false);
		expect(existsSync(join(out, "research/exa-limits.md"))).toBe(false);
		expect(existsSync(join(out, "research/jev-renamed.md"))).toBe(true);
		expect(existsSync(join(out, "topic/jev.md"))).toBe(true);
	});

	test("the default folder is export under the home", async () => {
		const home = await storeHome();

		const result = await cli(home, ["export"]);

		expect(result.stdout).toContain(join(home, "export"));
		expect(existsSync(join(home, "export", "topic", "jev.md"))).toBe(true);
		// Writing a file beside the store never makes it a source.
		writeFileSync(join(home, "export", "topic", "extra.md"), "x");
		expect((await cli(home, ["status", "--store"])).code).toBe(0);
	});
});
