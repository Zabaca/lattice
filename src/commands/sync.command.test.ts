import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { Command } from 'commander';
import { NestFactory } from '@nestjs/core';
import { registerSyncCommand } from './sync.command.js';
import { SyncService, SyncOptions, SyncResult } from '../sync/sync.service.js';

// Mock the NestFactory
mock.module('@nestjs/core', () => ({
	NestFactory: {
		createApplicationContext: mock(),
	},
}));

describe('sync command', () => {
	let program: Command;
	let mockApp: any;
	let mockSyncService: any;
	let consoleLogSpy: any;
	let consoleErrorSpy: any;
	let processExitSpy: any;

	beforeEach(() => {
		program = new Command();
		mockSyncService = {
			sync: mock(async (options: SyncOptions) => ({
				added: 5,
				updated: 3,
				deleted: 1,
				unchanged: 10,
				errors: [],
				duration: 1500,
				changes: [
					{
						path: 'docs/test/doc.md',
						changeType: 'new' as const,
						reason: 'New document',
					},
					{
						path: 'docs/other/file.md',
						changeType: 'unchanged' as const,
						reason: 'No changes detected',
					},
				],
			})),
		};

		mockApp = {
			get: mock(() => mockSyncService),
			close: mock(async () => {}),
		};

		// Mock NestFactory.createApplicationContext
		const nestFactory = require('@nestjs/core').NestFactory;
		nestFactory.createApplicationContext = mock(async () => mockApp);

		consoleLogSpy = spyOn(console, 'log');
		consoleErrorSpy = spyOn(console, 'error');
		// Mock process.exit to prevent actual process termination
		processExitSpy = spyOn(process, 'exit');
		(processExitSpy as any).mockImplementation(() => {
			throw new Error('PROCESS_EXIT_CALLED');
		});

		// Register command
		registerSyncCommand(program);
	});

	it('should be registered with correct description', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();
		expect(syncCmd?.description()).toContain('Synchronize documents');
	});

	it('should have all expected options', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();

		const options = syncCmd?.options || [];
		const optionNames = options.map((opt) => opt.long);

		expect(optionNames).toContain('--force');
		expect(optionNames).toContain('--dry-run');
		expect(optionNames).toContain('--verbose');
		expect(optionNames).toContain('--diff');
		expect(optionNames).toContain('--no-embeddings');
	});

	it('should print results correctly when sync succeeds', async () => {
		// Catch the error thrown by mocked process.exit
		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		// Check that console.log was called with results
		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Graph Sync');
		expect(logs.join('\n')).toContain('Sync Results');
		expect(logs.join('\n')).toContain('Added: 5');
		expect(logs.join('\n')).toContain('Updated: 3');
		expect(logs.join('\n')).toContain('Deleted: 1');
	});

	it('should handle force mode with warning', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--force']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Force mode');
		expect(logs.join('\n')).toContain('cleared and rebuilt');
	});

	it('should handle dry-run mode with message', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--dry-run']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Dry run mode');
		expect(logs.join('\n')).toContain('No changes will be applied');
	});

	it('should handle diff option as alias for dry-run', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--diff']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Dry run mode');
	});

	it('should pass options correctly to SyncService', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--force', '--verbose']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		// Verify sync was called with correct options
		expect(mockSyncService.sync.mock.calls.length).toBe(1);
		const callOptions = mockSyncService.sync.mock.calls[0][0];
		expect(callOptions.force).toBe(true);
		expect(callOptions.verbose).toBe(true);
	});

	it('should handle specific paths', async () => {
		try {
			await program.parseAsync([
				'node',
				'graph',
				'sync',
				'docs/topic/file.md',
				'docs/other/',
			]);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		expect(mockSyncService.sync.mock.calls.length).toBe(1);
		const callOptions = mockSyncService.sync.mock.calls[0][0];
		expect(callOptions.paths).toEqual([
			'docs/topic/file.md',
			'docs/other/',
		]);
	});

	it('should show changes in verbose mode', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--verbose']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Changes');
		expect(logs.join('\n')).toContain('doc.md');
	});

	it('should handle sync errors', async () => {
		mockSyncService.sync = mock(async () => ({
			added: 0,
			updated: 0,
			deleted: 0,
			unchanged: 0,
			errors: [
				{
					path: 'docs/broken/file.md',
					error: 'Parse error: Invalid YAML',
				},
			],
			duration: 500,
			changes: [],
		}));

		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Errors');
		expect(logs.join('\n')).toContain('Parse error');
	});

	it('should show suggestion to run without --dry-run', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--dry-run']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call) => call[0]);
		expect(logs.join('\n')).toContain('Run without --dry-run');
	});

	it('should close app on completion', async () => {
		const closeCallsBefore = mockApp.close.mock.calls.length;
		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		// Should have called close at least once in this test
		expect(mockApp.close.mock.calls.length).toBeGreaterThan(closeCallsBefore);
	});

	it('should close app on error', async () => {
		const nestFactory = require('@nestjs/core').NestFactory;
		nestFactory.createApplicationContext = mock(
			async () => {
				throw new Error('App init failed');
			}
		);

		// Re-register command with new mock
		program = new Command();
		registerSyncCommand(program);

		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit or app init error
		}

		expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
	});

	it('should have --watch option', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();

		const options = syncCmd?.options || [];
		const optionNames = options.map((opt) => opt.long);

		expect(optionNames).toContain('--watch');
	});

	it('should not enter watch mode without --watch flag', async () => {
		const exitCallsBefore = processExitSpy.mock.calls.length;
		const syncCallsBefore = mockSyncService.sync.mock.calls.length;

		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		// Should call sync once and exit (relative to before this test)
		expect(mockSyncService.sync.mock.calls.length).toBe(syncCallsBefore + 1);
		expect(processExitSpy.mock.calls.length).toBeGreaterThan(exitCallsBefore);
	});
});

describe('sync command - watch mode option', () => {
	let program: Command;

	beforeEach(() => {
		program = new Command();
		registerSyncCommand(program);
	});

	it('should register --watch option', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();

		const options = syncCmd?.options || [];
		const watchOption = options.find((opt) => opt.long === '--watch');

		expect(watchOption).toBeDefined();
		// The description property may be a string or function depending on Commander version
		const description =
			typeof watchOption?.description === 'function'
				? watchOption.description()
				: watchOption?.description;
		expect(description).toContain('Watch for file changes');
	});

	it('should have watch option with short alias -w', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();

		const options = syncCmd?.options || [];
		const watchOption = options.find((opt) => opt.long === '--watch');

		expect(watchOption?.short).toBe('-w');
	});
});

describe('sync command - embedding options', () => {
	let program: Command;
	let mockApp: any;
	let mockSyncService: any;
	let consoleLogSpy: any;
	let processExitSpy: any;

	beforeEach(() => {
		program = new Command();
		mockSyncService = {
			sync: mock(async (options: SyncOptions) => ({
				added: 2,
				updated: 1,
				deleted: 0,
				unchanged: 5,
				errors: [],
				duration: 800,
				changes: [],
				cascadeWarnings: [],
				embeddingsGenerated: options.embeddings ? 3 : 0,
			})),
		};

		mockApp = {
			get: mock(() => mockSyncService),
			close: mock(async () => {}),
		};

		const nestFactory = require('@nestjs/core').NestFactory;
		nestFactory.createApplicationContext = mock(async () => mockApp);

		consoleLogSpy = spyOn(console, 'log');
		processExitSpy = spyOn(process, 'exit');
		(processExitSpy as any).mockImplementation(() => {
			throw new Error('PROCESS_EXIT_CALLED');
		});

		registerSyncCommand(program);
	});

	it('should have --no-embeddings option', () => {
		const syncCmd = program.commands.find((cmd) => cmd.name() === 'sync');
		expect(syncCmd).toBeDefined();

		const options = syncCmd?.options || [];
		const noEmbeddingsOption = options.find((opt) => opt.long === '--no-embeddings');

		expect(noEmbeddingsOption).toBeDefined();
	});

	it('should enable embeddings by default', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		expect(mockSyncService.sync.mock.calls.length).toBe(1);
		const callOptions = mockSyncService.sync.mock.calls[0][0];
		expect(callOptions.embeddings).toBe(true);
	});

	it('should disable embeddings when --no-embeddings is passed', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--no-embeddings']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		expect(mockSyncService.sync.mock.calls.length).toBe(1);
		const callOptions = mockSyncService.sync.mock.calls[0][0];
		expect(callOptions.embeddings).toBe(false);
	});

	it('should display embeddings count in results when > 0', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
		expect(logs.join('\n')).toContain('Embeddings: 3');
	});

	it('should not display embeddings count when 0', async () => {
		// Track calls before this test
		const callsBefore = consoleLogSpy.mock.calls.length;

		try {
			await program.parseAsync(['node', 'graph', 'sync', '--no-embeddings']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		// Only check logs from this test run
		const newLogs = consoleLogSpy.mock.calls.slice(callsBefore).map((call: any) => call[0]);
		const joinedLogs = newLogs.join('\n');
		expect(joinedLogs).not.toContain('Embeddings:');
	});

	it('should show message when embeddings are disabled', async () => {
		try {
			await program.parseAsync(['node', 'graph', 'sync', '--no-embeddings']);
		} catch (e) {
			// Expected - process.exit mock throws
		}

		const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
		expect(logs.join('\n')).toContain('Embedding generation disabled');
	});
});
