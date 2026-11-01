import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { storeHome } from "../store/testing.js";
import { runCli } from "./run.js";

const MAIN = join(import.meta.dir, "..", "main.ts");

/**
 * `lattice mcp` as Claude Code runs it: a process speaking the protocol on its
 * stdin and stdout, started in the session's folder.
 */
test("lattice mcp serves the tools over stdio and records the folder it was started in", async () => {
	const home = await storeHome();
	const project = realpathSync(mkdtempSync(join(tmpdir(), "lattice-project-")));
	const client = new Client({ name: "claude-code", version: "9.9.9" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MAIN, "mcp"],
		cwd: project,
		env: { LATTICE_HOME: home, LATTICE_EMBED_PROVIDER: "hash" },
		stderr: "pipe",
	});

	try {
		await client.connect(transport);
		const tools = await client.listTools();
		const asked = await client.callTool({
			name: "recall",
			arguments: { question: "reciprocal rank fusion" },
		});
		const stats = await client.callTool({ name: "stats", arguments: {} });

		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"history",
			"links",
			"list_notes",
			"read_note",
			"recall",
			"stats",
		]);
		const answer = JSON.parse(
			(asked.content as Array<{ text: string }>)[0].text,
		);
		expect(answer.passages[0].note).toBe("research/jev-reranker");
		const counted = JSON.parse(
			(stats.content as Array<{ text: string }>)[0].text,
		);
		expect(counted.questions).toMatchObject({ last_7_days: 1, projects: 1 });
	} finally {
		await client.close();
	}

	const recorded = await runCli({
		argv: ["sql", "--store", "SELECT project, client FROM recall_log"],
		env: { LATTICE_HOME: home },
	});
	expect(JSON.parse(recorded.stdout)).toEqual([
		{ project, client: "claude-code 9.9.9" },
	]);
});
