/**
 * A copy of the store's snapshot on another machine.
 *
 * The daily snapshots sit on the same disk as the store, so they guard against
 * a bad day, not against losing the Mac. When `LATTICE_BACKUP_REMOTE` names a
 * place (`user@host:folder`, reached over ssh), the server copies the day's
 * snapshot there in the background after the day's first write, and `lattice
 * backup` copies a fresh one on demand.
 *
 * Nothing here may ever cost a write. A copy runs after the snapshot and is
 * never awaited by a tool; if ssh is missing, the host is down or the disk is
 * full, the failure is written to a small marker beside the snapshots (so
 * `stats` can say so) and the next write after a pause tries again. The file
 * is streamed over ssh's stdin to a name of its own on the other side, checked
 * there against the size and SHA-256 sent with it, and only then renamed into
 * place, so the other side only ever holds whole snapshots, each one a SQLite
 * file that opens as it is. A stream that ends early, or a connection that
 * drops, leaves nothing behind.
 *
 * Several sessions' servers share one home, so a copy of a snapshot first takes
 * a lock file for it (created exclusively, ignored once its holder is gone or
 * it is older than a copy may run); the others see it and wait rather than
 * send the same file twice.
 *
 * Nothing is scheduled: no LaunchAgent, no cron. The copy rides on the writes.
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { type LatticePaths, remoteLockPath } from "../utils/paths.js";
import { KEEP } from "./backup.js";

/** The environment variable that names the place. Unset, nothing is copied. */
export const REMOTE_ENV = "LATTICE_BACKUP_REMOTE";
/** The ssh program, for a machine where it is not on the PATH under that name. */
export const SSH_ENV = "LATTICE_SSH";

/** After a failure (or any attempt), how long before a write tries again. */
export const RETRY_AFTER_MS = 15 * 60 * 1000;
/** A copy that has not finished by then is given up on. */
const TIMEOUT_MS = 10 * 60 * 1000;

export interface RemoteTarget {
	/** What ssh is given: `host` or `user@host`. */
	host: string;
	/** A folder on that machine: absolute, or relative to the login folder. */
	dir: string;
}

/** `user@host:folder` as a place, or why it is not one. */
export function parseRemote(spec: string): RemoteTarget {
	const colon = spec.indexOf(":");
	const host = colon === -1 ? "" : spec.slice(0, colon).trim();
	const dir = colon === -1 ? "" : spec.slice(colon + 1).trim();
	const example = "for example uptown@ryzen-9:lattice-backups";
	if (host === "" || dir === "") {
		throw new Error(
			`${REMOTE_ENV} must look like host:folder (${example}), got: ${spec}`,
		);
	}
	if (host.startsWith("-") || /\s/.test(host)) {
		throw new Error(`${REMOTE_ENV} has a host ssh would not take: ${host}`);
	}
	if (dir.startsWith("~") || /[\n\r\0]/.test(dir)) {
		throw new Error(
			`${REMOTE_ENV}'s folder must be absolute or relative to the login folder, not start with ~ (${example}), got: ${dir}`,
		);
	}
	return { host, dir: dir.length > 1 ? dir.replace(/\/+$/, "") : dir };
}

/** The place the environment names, or undefined when none is set. Throws if it is malformed. */
export function remoteFrom(
	env: Record<string, string | undefined>,
	spec?: string,
): RemoteTarget | undefined {
	const given = spec ?? env[REMOTE_ENV]?.trim();
	return given === undefined || given === "" ? undefined : parseRemote(given);
}

export function describeRemote(target: RemoteTarget): string {
	return `${target.host}:${target.dir}`;
}

/**
 * What the environment says about the copy: the place, its label for display,
 * and what is wrong with the setting if something is.
 */
export function remoteSetting(env: Record<string, string | undefined>): {
	target?: RemoteTarget;
	label: string | null;
	problem?: string;
} {
	try {
		const target = remoteFrom(env);
		return {
			target,
			label: target === undefined ? null : describeRemote(target),
		};
	} catch (error) {
		return {
			label: null,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface RemoteCopyRecord {
	/** The place the last attempt went to. */
	target: string;
	/** The snapshot the last attempt sent. */
	file: string;
	attempted_at: string;
	ok: boolean;
	/** Why the last attempt failed. */
	error?: string;
	/** The last time a copy arrived, and which snapshot it was. */
	last_ok_at?: string;
	last_ok_file?: string;
}

type CopyPaths = Pick<LatticePaths, "backups" | "remoteCopy">;

export function readRemoteCopy(paths: CopyPaths): RemoteCopyRecord | null {
	try {
		const record = JSON.parse(readFileSync(paths.remoteCopy, "utf8"));
		return typeof record?.attempted_at === "string" ? record : null;
	} catch {
		return null;
	}
}

function writeRemoteCopy(paths: CopyPaths, record: RemoteCopyRecord): void {
	mkdirSync(paths.backups, { recursive: true });
	const partial = `${paths.remoteCopy}.${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(partial, `${JSON.stringify(record)}\n`);
	renameSync(partial, paths.remoteCopy);
}

/** A copy that has run this long is no longer running; its lock is ignored. */
const LOCK_STALE_MS = TIMEOUT_MS + 60_000;

/** Whether a lock file names a copy that may still be running. */
function lockHeld(lock: string, now: number): boolean {
	let holder: { pid?: number; at?: number };
	try {
		holder = JSON.parse(readFileSync(lock, "utf8"));
	} catch {
		// Gone, or being written this instant: not ours to wait on if it is gone.
		return readable(lock);
	}
	if (typeof holder.at !== "number" || now - holder.at >= LOCK_STALE_MS) {
		return false;
	}
	if (typeof holder.pid === "number") {
		try {
			process.kill(holder.pid, 0);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
	return true;
}

function readable(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Take the lock, or say it is held. Anything else that goes wrong lets the copy run unlocked. */
function claim(lock: string): boolean {
	mkdirSync(dirname(lock), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(
				lock,
				JSON.stringify({ pid: process.pid, at: Date.now() }),
				{
					flag: "wx",
				},
			);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return true;
			}
			if (lockHeld(lock, Date.now())) {
				return false;
			}
			rmSync(lock, { force: true });
		}
	}
	return false;
}

/**
 * Whether a write should start a copy of the snapshot `name` now: not when this
 * snapshot has already arrived, not while another copy of it is running, and
 * not within a pause of the last attempt, successful or not (so a host that is
 * down is asked once a quarter hour, not once a write).
 */
export function copyDue(
	paths: CopyPaths,
	name: string,
	target: RemoteTarget,
	now: number = Date.now(),
): boolean {
	if (lockHeld(remoteLockPath(paths.backups, name), now)) {
		return false;
	}
	const last = readRemoteCopy(paths);
	if (last === null) {
		return true;
	}
	if (last.target === describeRemote(target) && last.last_ok_file === name) {
		return false;
	}
	const attempted = Date.parse(last.attempted_at);
	return Number.isNaN(attempted) || now - attempted >= RETRY_AFTER_MS;
}

export interface CopyResult {
	ok: boolean;
	error?: string;
	/** True when another copy of this snapshot was already running and nothing was sent. */
	busy?: boolean;
}

/** A word for a shell: single-quoted, so nothing in it is special. */
function quote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * What the other side runs, as a script for `sh -c` so it does not matter what
 * the login shell is. It takes the stream into a hidden name of this attempt's
 * own, checks it is the size and SHA-256 that were sent, and only then renames
 * it into place; any other ending (a stream cut short, a dropped connection, a
 * mismatch) removes the partial. Then it drops all but the newest `KEEP` of each
 * kind (the daily snapshots and the ones taken by hand) and any partial a dead
 * connection left over two hours ago; that is best effort and never fails the
 * copy. A relative folder is read from the login folder whatever CDPATH says.
 * It uses only what both GNU and BSD tools do.
 */
function remoteCommand(
	dir: string,
	name: string,
	partialName: string,
	size: number,
	sha256: string,
): string {
	const folder = quote(dir.startsWith("/") ? dir : `./${dir}`);
	const prune = (glob: string): string =>
		`(cd -P -- "$d" && ls -1 ${glob} 2>/dev/null | sort -r | tail -n +${KEEP + 1} | xargs rm -f --) || true`;
	const script = [
		"unset CDPATH",
		`d=${folder}`,
		`p="$d"/${quote(partialName)}`,
		`f="$d"/${quote(name)}`,
		`trap 'rm -f -- "$p"' EXIT`,
		"trap 'exit 1' HUP INT TERM",
		'mkdir -p -- "$d" || exit 1',
		'cat > "$p" || exit 1',
		`got=$(wc -c < "$p" | tr -d ' ')`,
		`[ "$got" = ${size} ] || { echo "received $got of ${size} bytes" >&2; exit 1; }`,
		`sum=$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | cut -d' ' -f1 )`,
		`[ "$sum" = ${sha256} ] || { echo "checksum differs" >&2; exit 1; }`,
		'mv -f -- "$p" "$f" || exit 1',
		"trap - EXIT",
		`find "$d" -maxdepth 1 -name '.incoming-*' -mmin +120 -exec rm -f -- {} + 2>/dev/null || true`,
		prune("store-????-??-??.db"),
		prune("store-*T*.db"),
		"exit 0",
	].join("\n");
	return `sh -c ${quote(script)}`;
}

/**
 * Copy one snapshot to the place and record how it went. Never throws: the
 * outcome is the return value and the marker. If another copy of the same
 * snapshot is running, nothing is sent and the result says it was busy.
 * `signal` stops a copy in flight (the server going away); an abandoned copy
 * records nothing.
 */
export async function copySnapshot(
	paths: CopyPaths,
	file: string,
	target: RemoteTarget,
	env: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<CopyResult> {
	const name = basename(file);
	const lock = remoteLockPath(paths.backups, name);
	if (!claim(lock)) {
		return {
			ok: false,
			busy: true,
			error: `a copy of ${name} is already running`,
		};
	}
	try {
		const attemptedAt = new Date().toISOString();
		const result = await send(file, name, target, env, signal);
		if (signal?.aborted) {
			return result;
		}

		// What arrived before only counts if it went to the same place.
		const found = readRemoteCopy(paths);
		const before = found?.target === describeRemote(target) ? found : null;
		const record: RemoteCopyRecord = {
			target: describeRemote(target),
			file: name,
			attempted_at: attemptedAt,
			ok: result.ok,
			...(result.error === undefined ? {} : { error: result.error }),
			...(result.ok
				? { last_ok_at: attemptedAt, last_ok_file: name }
				: {
						...(before?.last_ok_at === undefined
							? {}
							: { last_ok_at: before.last_ok_at }),
						...(before?.last_ok_file === undefined
							? {}
							: { last_ok_file: before.last_ok_file }),
					}),
		};
		try {
			writeRemoteCopy(paths, record);
		} catch {
			// The marker only feeds `stats`; the copy's outcome stands without it.
		}
		return result;
	} finally {
		rmSync(lock, { force: true });
	}
}

async function send(
	file: string,
	name: string,
	target: RemoteTarget,
	env: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<CopyResult> {
	const ssh = env[SSH_ENV]?.trim() || "ssh";
	try {
		// The size and checksum go with the stream, so the other side can tell a
		// whole file from one that ended early.
		const hasher = new Bun.CryptoHasher("sha256");
		let size = 0;
		for await (const chunk of Bun.file(file).stream()) {
			hasher.update(chunk);
			size += chunk.byteLength;
		}
		const partialName = `.incoming-${name}.${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		const child = Bun.spawn(
			[
				ssh,
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=15",
				"-o",
				"ServerAliveInterval=15",
				"-o",
				"ServerAliveCountMax=4",
				target.host,
				remoteCommand(
					target.dir,
					name,
					partialName,
					size,
					hasher.digest("hex"),
				),
			],
			{
				stdin: Bun.file(file),
				stdout: "ignore",
				stderr: "pipe",
				timeout: TIMEOUT_MS,
				signal,
			},
		);
		const [code, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		if (code === 0) {
			return { ok: true };
		}
		const said = stderr.trim().split("\n").at(-1)?.trim() ?? "";
		return {
			ok: false,
			error: `${ssh} exited ${code}${said === "" ? "" : `: ${said.slice(0, 300)}`}`,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
