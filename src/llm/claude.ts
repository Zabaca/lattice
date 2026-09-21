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

import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { Completion, TextProvider } from "./provider.js";

export const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
/**
 * The same token under a name the Claude Code harness does not scrub.
 * A Bash tool inside a Claude Code session never sees
 * `CLAUDE_CODE_OAUTH_TOKEN`, so a skill running `lattice run` needs the
 * token under another name; this one is forwarded as the real one.
 */
export const OAUTH_ALIAS_VAR = "LATTICE_OAUTH_TOKEN";
export const API_KEY_VAR = "ANTHROPIC_API_KEY";
export const LLM_MODEL_VAR = "LATTICE_LLM_MODEL";
export const CLAUDE_PATH_VAR = "LATTICE_CLAUDE_PATH";
export const DEFAULT_LLM_MODEL = "claude-haiku-4-5";

export class ClaudeProvider implements TextProvider {
	readonly name = "claude";
	readonly model: string;
	private readonly env: Record<string, string>;
	private readonly executable?: string;
	private readonly maxBudgetUsd?: number;

	constructor(options: {
		model: string;
		env: Record<string, string>;
		executable?: string;
		/** Stop the call once it has spent this much; a completion has no business running up a bill. */
		maxBudgetUsd?: number;
	}) {
		this.model = options.model;
		this.env = options.env;
		this.executable = options.executable;
		this.maxBudgetUsd = options.maxBudgetUsd;
	}

	async complete(prompt: string): Promise<Completion> {
		const texts: string[] = [];
		let costUsd = 0;
		const turn = query({
			prompt,
			options: {
				...minimalOptions(this.model, this.env, this.executable),
				...(this.maxBudgetUsd === undefined
					? {}
					: { maxBudgetUsd: this.maxBudgetUsd }),
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

/**
 * The minimal option set: no tools, no settings, no memory, no connectors,
 * thinking off. The `claude` web searcher adds its one tool to this.
 */
export function minimalOptions(
	model: string,
	env: Record<string, string>,
	executable?: string,
): Options {
	return {
		model,
		tools: [],
		settingSources: [],
		thinking: { type: "disabled" },
		mcpServers: {},
		strictMcpConfig: true,
		settings: { autoMemoryEnabled: false, disableClaudeAiConnectors: true },
		env,
		pathToClaudeCodeExecutable: executable,
	};
}

/** What a Claude call is built from: the forwarded environment, the model and the executable. */
export interface ClaudeEnvironment {
	model: string;
	env: Record<string, string>;
	executable?: string;
}

/**
 * The environment a Claude call runs in: the credential checked and
 * forwarded under the name the SDK reads, the rest passed through. No
 * credential is an error naming every accepted variable; `what` says which
 * user of Claude is complaining.
 */
export function claudeEnvironment(
	env: Record<string, string | undefined>,
	what = "The claude text provider",
): ClaudeEnvironment {
	const token = env[OAUTH_TOKEN_VAR]?.trim() || env[OAUTH_ALIAS_VAR]?.trim();
	const apiKey = env[API_KEY_VAR]?.trim();
	if (!token && !apiKey) {
		throw new Error(
			`${what} needs ${OAUTH_TOKEN_VAR} (or ${OAUTH_ALIAS_VAR}, or ${API_KEY_VAR}) set.`,
		);
	}
	const forwarded: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) {
			forwarded[key] = value;
		}
	}
	if (token) {
		forwarded[OAUTH_TOKEN_VAR] = token;
	}
	// No attribution header and no telemetry: this is a completion, not a session.
	forwarded.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
	forwarded.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	return {
		model: env[LLM_MODEL_VAR]?.trim() || DEFAULT_LLM_MODEL,
		env: forwarded,
		executable: env[CLAUDE_PATH_VAR]?.trim() || undefined,
	};
}

/** Claude as the environment configures it; no credential is an error naming the accepted ones. */
export function claudeProviderFromEnv(
	env: Record<string, string | undefined>,
): ClaudeProvider {
	return new ClaudeProvider(claudeEnvironment(env));
}
