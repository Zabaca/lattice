/**
 * The sync lock.
 *
 * Two syncs over one index would interleave their per-document transactions,
 * so the second one refuses. The lock carries the pid that took it: a lock
 * left behind by a process that has since died is stale and is taken over,
 * rather than needing a user to hunt for a file.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface Lock {
	/** Remove the lock. Safe to call when it has already been released. */
	release(): void;
}

export class LockHeldError extends Error {
	constructor(
		readonly path: string,
		readonly pid: number,
	) {
		super(
			`Another sync is already running (pid ${pid}). If that is wrong, remove ${path}.`,
		);
		this.name = "LockHeldError";
	}
}

/**
 * Take the lock at `path`, or throw {@link LockHeldError} when a live process
 * holds it.
 */
export function acquireLock(path: string, pid: number = process.pid): Lock {
	const holder = readHolder(path);
	if (holder !== null && isAlive(holder)) {
		throw new LockHeldError(path, holder);
	}

	writeFileSync(path, `${pid}\n`);

	let released = false;
	return {
		release(): void {
			if (released) {
				return;
			}
			released = true;
			rmSync(path, { force: true });
		},
	};
}

/** The pid in the lock file, or null when there is no usable lock. */
function readHolder(path: string): number | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		// A lock whose contents make no sense cannot name a live process, so
		// it is treated as stale rather than blocking every future sync.
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	if (pid === process.pid) {
		return true;
	}
	try {
		// Signal 0 checks for the process without touching it.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to somebody else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
