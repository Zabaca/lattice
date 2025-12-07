/**
 * Type-safe mock utilities for Bun test runner
 */
import type { Mock } from "bun:test";

/**
 * Typed spy for console methods (log, error, warn, info)
 * @example
 * let consoleLogSpy: ConsoleSpy;
 * consoleLogSpy = spyOn(console, "log");
 */
export type ConsoleSpy = Mock<(...args: unknown[]) => void>;

/**
 * Typed spy for process.exit
 * @example
 * let processExitSpy: ProcessExitSpy;
 * processExitSpy = spyOn(process, "exit");
 */
export type ProcessExitSpy = Mock<(code?: number) => never>;

/**
 * Generic mock call type for extracting call arguments
 * @example
 * type LogCall = MockCall<typeof console.log>;
 */
export type MockCall<T extends (...args: unknown[]) => unknown> = Parameters<T>;

/**
 * Extract first argument from mock calls
 * @example
 * const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
 */
export type FirstArg<T extends unknown[]> = T extends [infer F, ...unknown[]]
	? F
	: never;
