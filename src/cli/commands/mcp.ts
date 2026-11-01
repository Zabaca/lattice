import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLatticeServer } from "../../mcp/server.js";
import type { CommandContext, CommandOutput } from "../run.js";

/**
 * Serve the note store's tools over stdin and stdout until the client goes
 * away. Claude Code starts this once per session.
 *
 * Nothing but the protocol may reach stdout; whatever needs saying goes to
 * stderr through `report`.
 */
export async function runMcp(context: CommandContext): Promise<CommandOutput> {
	const { server, close } = createLatticeServer({
		env: context.env,
		project: context.cwd,
	});

	const finished = new Promise<void>((resolve) => {
		server.server.onclose = resolve;
		// The transport hears the client leave only as a closed stream.
		process.stdin.once("end", resolve);
		process.stdin.once("close", resolve);
	});

	await server.connect(new StdioServerTransport());
	context.report("Lattice is serving notes on stdio.");
	await finished;
	close();
	return { code: 0 };
}
