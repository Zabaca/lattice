/**
 * Claude through the Agent SDK, stripped to a completion.
 *
 * The SDK starts a Claude Code process, and by default that process loads
 * the user's settings, memory, MCP servers and tools — tens of thousands of
 * tokens of context for a prompt that wants two search queries back. The
 * option set below is the minimal profile from zbc's `@zabaca/agent`
 * (`minimalOptions`), copied rather than imported because that package
 * hard-depends on the sandbox runtime; it measured 553 input tokens on the
 * plan prompt against 26,716 for `claude -p`.
 *
 * `settingSources: []` also stops the process reading `~/.claude/settings.json`,
 * which on a machine logged in by OAuth is where the token lives. So the
 * credential is forwarded explicitly, from the environment the CLI was given.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Completion, TextProvider } from "./provider.js";

export const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
export const API_KEY_VAR = "ANTHROPIC_API_KEY";
export const LLM_MODEL_VAR = "LATTICE_LLM_MODEL";
export const CLAUDE_PATH_VAR = "LATTICE_CLAUDE_PATH";
export const DEFAULT_LLM_MODEL = "claude-haiku-4-5";

export class ClaudeProvider implements TextProvider {
	readonly name = "claude";
	readonly model: string;
	private readonly env: Record<string, string>;
	private readonly executable?: string;

	constructor(options: {
		model: string;
		env: Record<string, string>;
		executable?: string;
	}) {
		this.model = options.model;
		this.env = options.env;
		this.executable = options.executable;
	}

	async complete(prompt: string): Promise<Completion> {
		const texts: string[] = [];
		let costUsd = 0;
		const turn = query({
			prompt,
			options: {
				model: this.model,
				tools: [],
				settingSources: [],
				thinking: { type: "disabled" },
				mcpServers: {},
				strictMcpConfig: true,
				settings: { autoMemoryEnabled: false, disableClaudeAiConnectors: true },
				env: this.env,
				pathToClaudeCodeExecutable: this.executable,
			},
		});
		for await (const message of turn) {
			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "text") {
						texts.push(block.text);
					}
				}
			} else if (message.type === "result") {
				costUsd = message.total_cost_usd;
				if (message.subtype !== "success") {
					throw new Error(`Claude did not answer: ${message.subtype}`);
				}
				if (message.is_error) {
					throw new Error(`Claude did not answer: ${message.result}`);
				}
			}
		}
		return { text: texts.join("\n").trim(), costUsd };
	}
}

/** Claude as the environment configures it; no credential is an error naming both accepted ones. */
export function claudeProviderFromEnv(
	env: Record<string, string | undefined>,
): ClaudeProvider {
	const token = env[OAUTH_TOKEN_VAR]?.trim();
	const apiKey = env[API_KEY_VAR]?.trim();
	if (!token && !apiKey) {
		throw new Error(
			`The claude text provider needs ${OAUTH_TOKEN_VAR} (or ${API_KEY_VAR}) set.`,
		);
	}
	const forwarded: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			forwarded[key] = value;
		}
	}
	// No attribution header and no telemetry: this is a completion, not a session.
	forwarded.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
	forwarded.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	return new ClaudeProvider({
		model: env[LLM_MODEL_VAR]?.trim() || DEFAULT_LLM_MODEL,
		env: forwarded,
		executable: env[CLAUDE_PATH_VAR]?.trim() || undefined,
	});
}
