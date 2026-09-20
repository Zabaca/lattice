/**
 * The sync lock.
 *
 * Two syncs over one index would interleave their deletes and inserts, so the
 * second refuses. The lock carries the holder's process id, which is what
 * stops a crashed sync from blocking every later one: a lock naming a process
 * that is gone is taken over rather than honoured.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";

export class LockHeldError extends Error {
	constructor(readonly pid: number) {
		super(
			`Another sync is already running (process ${pid}). ` +
				"Wait for it to finish, or stop it and run `lattice sync` again.",
		);
		this.name = "LockHeldError";
	}
}

export interface Lock {
	release(): void;
}

/**
 * Take the lock at `path`, or throw `LockHeldError` when a live process holds
 * it. The returned handle releases it; callers must do so in a `finally`.
 */
export function acquireLock(path: string, pid: number = process.pid): Lock {
	const holder = readHolder(path);
	if (holder !== undefined && isAlive(holder)) {
		throw new LockHeldError(holder);
	}

	writeFileSync(path, `${pid}\n`, "utf8");

	let released = false;
	const release = () => {
		if (released) {
			return;
		}
		released = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		rmSync(path, { force: true });
	};

	// An interrupted sync must not leave its own lock behind. Listening for the
	// signal suppresses the default exit, so the exit has to be made here —
	// otherwise the sync would carry on with no lock at all.
	const onSignal = () => {
		release();
		process.exit(130);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	return { release };
}

function readHolder(path: string): number | undefined {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(contents.trim(), 10);
	// An unreadable lock tells us nothing, so it is not allowed to block a sync.
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid: number): boolean {
	try {
		// Signal 0 performs the permission and existence checks and nothing else.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
