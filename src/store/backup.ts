/**
 * Snapshots of the store.
 *
 * The database is the only copy of the notes, so the server keeps a snapshot
 * of it: one on the first write of each day, the last 30 kept, and `lattice
 * backup` takes one on demand. A snapshot is `VACUUM INTO`, which reads the
 * database in one consistent transaction and writes a whole new file, so it is
 * sound whatever the other sessions are doing meanwhile. It guards against a
 * bad day or a damaged file, not against losing the machine: the snapshots sit
 * on the same disk.
 *
 * Nothing here schedules anything. The server calls `dailyBackup` before it
 * writes, and a scheduler, if one is ever wanted, only has to run the command.
 */

import type { Database } from "bun:sqlite";
import {
	linkSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * How many snapshots are kept of each kind: the daily ones (one per day, taken
 * by the server) and the ones asked for with `lattice backup`. They are pruned
 * apart, so a run of manual backups never pushes the daily window out.
 */
export const KEEP = 30;

const DAILY = /^store-\d{4}-\d{2}-\d{2}\.db$/;

const PREFIX = "store-";
const SUFFIX = ".db";

export interface Snapshot {
	file: string;
	path: string;
}

/** A date as the day a person on this Mac would call it: 2026-11-01. */
export function localDay(now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localClock(now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** The name of the day's snapshot: `store-2026-11-01.db`. */
export function dailyName(now: Date = new Date()): string {
	return `${PREFIX}${localDay(now)}${SUFFIX}`;
}

/** The snapshots in a folder, oldest first. */
export function snapshotsIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
			.sort();
	} catch {
		return [];
	}
}

/** The daily snapshots in a folder, oldest first. */
export function dailyIn(dir: string): string[] {
	return snapshotsIn(dir).filter((name) => DAILY.test(name));
}

/** The snapshots asked for by hand, oldest first. */
export function manualIn(dir: string): string[] {
	return snapshotsIn(dir).filter((name) => !DAILY.test(name));
}

/** When the newest snapshot was made, or null when there is none. */
export function lastBackup(dir: string): string | null {
	const newest = snapshotsIn(dir).at(-1);
	if (newest === undefined) {
		return null;
	}
	try {
		return statSync(join(dir, newest)).mtime.toISOString();
	} catch {
		return null;
	}
}

/**
 * Write a snapshot of `db` as `name` in `dir`, unless one by that name is
 * already there. The file appears whole or not at all, so a second server
 * racing for the same day's snapshot neither corrupts nor duplicates it.
 */
function snapshot(db: Database, dir: string, name: string): Snapshot | null {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	const partial = join(
		dir,
		`.partial-${process.pid}-${Math.random().toString(36).slice(2, 8)}${SUFFIX}`,
	);
	try {
		db.query("VACUUM INTO ?").run(partial);
		try {
			linkSync(partial, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return null;
			}
			throw error;
		}
		return { file: name, path };
	} finally {
		rmSync(partial, { force: true });
	}
}

/** Drop all but the newest `KEEP` snapshots of each kind. */
function prune(dir: string): void {
	for (const names of [dailyIn(dir), manualIn(dir)]) {
		for (const name of names.slice(0, Math.max(0, names.length - KEEP))) {
			try {
				unlinkSync(join(dir, name));
			} catch {
				// Someone else pruned it first.
			}
		}
	}
}

/**
 * The day's snapshot, if no server has taken one today. Returns what it made,
 * or null when today already has one. A snapshot asked for by hand does not
 * count: the day's first write still takes its own.
 */
export function dailyBackup(
	db: Database,
	dir: string,
	now: Date = new Date(),
): Snapshot | null {
	if (dailyIn(dir).includes(dailyName(now))) {
		return null;
	}
	const made = snapshot(db, dir, dailyName(now));
	prune(dir);
	return made;
}

/** A snapshot now, whatever today already has. */
export function backupNow(
	db: Database,
	dir: string,
	now: Date = new Date(),
): Snapshot {
	const stem = `${PREFIX}${localDay(now)}T${localClock(now)}`;
	for (let n = 0; n < 100; n++) {
		const made = snapshot(db, dir, `${stem}${n === 0 ? "" : `-${n}`}${SUFFIX}`);
		if (made !== null) {
			prune(dir);
			return made;
		}
	}
	throw new Error(`Could not find a free name for a snapshot in ${dir}.`);
}
