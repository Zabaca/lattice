/**
 * A copy of the store's snapshot on another machine.
 *
 * The daily snapshots sit on the same disk as the store, so they guard against
 * a bad day, not against losing the Mac. When `LATTICE_BACKUP_REMOTE` names a
 * place (`user@host:folder`, reached over ssh), the server copies the day's
 * snapshot there in the background after the day's first write, and `lattice
 * backup --remote` copies a fresh one on demand.
 *
 * Nothing here may ever cost a write. A copy runs after the snapshot and is
 * never awaited by a tool; if ssh is missing, the host is down or the disk is
 * full, the failure is written to a small marker beside the snapshots (so
 * `stats` can say so) and the next write after a pause tries again. The file
 * is streamed over ssh's stdin and renamed into place there, so the other side
 * only ever holds whole snapshots, each one a SQLite file that opens as it is.
 *
 * Nothing is scheduled: no LaunchAgent, no cron. The copy rides on the writes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP } from "./backup.js";

/** The environment variable that names the place. Unset, nothing is copied. */
export const REMOTE_ENV = "LATTICE_BACKUP_REMOTE";
/** The ssh program, for a machine where it is not on the PATH under that name. */
export const SSH_ENV = "LATTICE_SSH";

const MARKER = ".remote-copy.json";
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

export function readRemoteCopy(backups: string): RemoteCopyRecord | null {
	try {
		const record = JSON.parse(readFileSync(join(backups, MARKER), "utf8"));
		return typeof record?.attempted_at === "string" ? record : null;
	} catch {
		return null;
	}
}

function writeRemoteCopy(backups: string, record: RemoteCopyRecord): void {
	mkdirSync(backups, { recursive: true });
	const path = join(backups, MARKER);
	const partial = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(partial, `${JSON.stringify(record)}\n`);
	renameSync(partial, path);
}

/**
 * Whether a write should start a copy of `file` now: not when this snapshot has
 * already arrived, and not within a pause of the last attempt, successful or not
 * (so a host that is down is asked once a quarter hour, not once a write).
 */
export function copyDue(
	backups: string,
	file: string,
	target: RemoteTarget,
	now: number = Date.now(),
): boolean {
	const last = readRemoteCopy(backups);
	if (last === null) {
		return true;
	}
	if (last.target === describeRemote(target) && last.last_ok_file === file) {
		return false;
	}
	const attempted = Date.parse(last.attempted_at);
	return Number.isNaN(attempted) || now - attempted >= RETRY_AFTER_MS;
}

export interface CopyResult {
	ok: boolean;
	error?: string;
}

/** A word for a shell: single-quoted, so nothing in it is special. */
function quote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * What the other side runs, as a script for `sh -c` so it does not matter what
 * the login shell is: make the folder, write the stream to a hidden name,
 * rename it into place, then drop all but the newest `KEEP` of each kind (the
 * daily ones and the ones taken by hand). Pruning is best effort and never
 * fails the copy. It uses only what both GNU and BSD tools do.
 */
function remoteCommand(dir: string, name: string): string {
	const folder = quote(dir);
	const partial = quote(`${dir}/.incoming-${name}`);
	const final = quote(`${dir}/${name}`);
	const prune = (glob: string): string =>
		`(cd ${folder} && ls -1 ${glob} 2>/dev/null | sort -r | tail -n +${KEEP + 1} | xargs rm -f --) || true`;
	const script =
		`mkdir -p ${folder} && cat > ${partial} && mv ${partial} ${final} && ` +
		`{ ${prune("store-????-??-??.db")}; ${prune("store-*T*.db")}; true; }`;
	return `sh -c ${quote(script)}`;
}

/**
 * Copy one snapshot to the place and record how it went. Never throws: the
 * outcome is the return value and the marker.
 */
export async function copySnapshot(
	backups: string,
	file: string,
	target: RemoteTarget,
	env: Record<string, string | undefined>,
): Promise<CopyResult> {
	const name = file.split("/").at(-1) ?? file;
	const attemptedAt = new Date().toISOString();
	const result = await send(file, name, target, env);

	// What arrived before only counts if it went to the same place.
	const found = readRemoteCopy(backups);
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
		writeRemoteCopy(backups, record);
	} catch {
		// The marker only feeds `stats`; the copy's outcome stands without it.
	}
	return result;
}

async function send(
	file: string,
	name: string,
	target: RemoteTarget,
	env: Record<string, string | undefined>,
): Promise<CopyResult> {
	const ssh = env[SSH_ENV]?.trim() || "ssh";
	try {
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
				remoteCommand(target.dir, name),
			],
			{
				stdin: Bun.file(file),
				stdout: "ignore",
				stderr: "pipe",
				timeout: TIMEOUT_MS,
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
