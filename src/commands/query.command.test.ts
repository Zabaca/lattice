import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { StatsCommand, SearchCommand, RelsCommand, CypherCommand, RelatedCommand } from './query.command.js';
import type { GraphService } from '../graph/graph.service.js';
import type { EmbeddingService } from '../embedding/embedding.service.js';
import type { PathResolverService } from '../sync/path-resolver.service.js';

describe('Query Commands', () => {
	let mockGraphService: any;
	let mockEmbeddingService: any;
	let mockPathResolverService: any;
	let consoleLogSpy: any;
	let consoleErrorSpy: any;
	let processExitSpy: any;

	beforeEach(() => {
		mockGraphService = {
			getStats: mock(async () => ({
				nodeCount: 100,
				edgeCount: 50,
				labels: ['Technology', 'Concept', 'Document'],
				relationshipTypes: ['USES', 'APPEARS_IN'],
				entityCounts: { Technology: 30, Concept: 40, Document: 30 },
				relationshipCounts: { USES: 25, APPEARS_IN: 25 },
			})),
			vectorSearch: mock(async () => []),
			vectorSearchAll: mock(async () => []),
			query: mock(async () => ({ resultSet: [] })),
		};

		mockEmbeddingService = {
			generateEmbedding: mock(async () => [0.1, 0.2, 0.3]),
		};

		mockPathResolverService = {
			resolveDocPath: mock((path: string) => `/absolute/${path}`),
		};

		consoleLogSpy = spyOn(console, 'log');
		consoleErrorSpy = spyOn(console, 'error');
		processExitSpy = spyOn(process, 'exit');
		(processExitSpy as any).mockImplementation(() => {
			throw new Error('PROCESS_EXIT_CALLED');
		});
	});

	describe('StatsCommand', () => {
		it('should display graph statistics', async () => {
			const command = new StatsCommand(mockGraphService as GraphService);

			try {
				await command.run();
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			const output = logs.join('\n');
			expect(output).toContain('Graph Statistics');
			expect(output).toContain('Total Nodes: 100');
			expect(output).toContain('Total Relationships: 50');
			expect(output).toContain('Technology: 30');
		});
	});

	describe('SearchCommand', () => {
		it('should perform semantic search with query', async () => {
			mockGraphService.vectorSearchAll = mock(async () => [
				{ name: 'TestEntity', label: 'Technology', score: 0.95 }
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);

			try {
				await command.run(['test query'], {});
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			const output = logs.join('\n');
			expect(output.includes('Semantic Search Results') || output.includes('TestEntity')).toBe(true);
		});

		it('should filter by label when --label is used', async () => {
			mockGraphService.vectorSearch = mock(async () => [
				{ name: 'TypeScript', title: 'TypeScript Language', score: 0.9 }
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);

			try {
				await command.run(['typescript'], { label: 'Technology' });
			} catch (e) {
				// Expected - process.exit mock throws
			}

			// Verify vectorSearch was called (for label-specific search)
			expect(mockGraphService.vectorSearch.mock.calls.length).toBeGreaterThan(0);
		});

		it('should show no results message when nothing found', async () => {
			mockGraphService.vectorSearchAll = mock(async () => []);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);

			try {
				await command.run(['nonexistent query'], {});
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('No results found');
		});

		it('should show results with similarity scores', async () => {
			mockGraphService.vectorSearchAll = mock(async () => [
				{ name: 'FalkorDB', label: 'Technology', description: 'Graph database', score: 0.95 }
			]);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);

			try {
				await command.run(['graph database'], {});
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('FalkorDB');
			expect(logs.join('\n')).toContain('Similarity:');
		});

		it('should suggest trying without --label when no results with label', async () => {
			mockGraphService.vectorSearch = mock(async () => []);

			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);

			try {
				await command.run(['test'], { label: 'NonexistentType' });
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('Try without --label');
		});

		it('parseLabel should return the value', () => {
			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);
			expect(command.parseLabel('Technology')).toBe('Technology');
		});

		it('parseLimit should return the value', () => {
			const command = new SearchCommand(
				mockGraphService as GraphService,
				mockEmbeddingService as EmbeddingService
			);
			expect(command.parseLimit('50')).toBe('50');
		});
	});

	describe('RelsCommand', () => {
		it('should show relationships for a node', async () => {
			mockGraphService.query = mock(async () => ({
				resultSet: [
					[
						[['id', 1], ['properties', [['name', 'FalkorDB']]]],
						[['type', 'USES']],
						[['id', 2], ['properties', [['name', 'Redis']]]],
					]
				]
			}));

			const command = new RelsCommand(mockGraphService as GraphService);

			try {
				await command.run(['FalkorDB']);
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('Relationships for "FalkorDB"');
		});

		it('should show no relationships message when none found', async () => {
			mockGraphService.query = mock(async () => ({ resultSet: [] }));

			const command = new RelsCommand(mockGraphService as GraphService);

			try {
				await command.run(['NonexistentNode']);
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('No relationships found');
		});
	});

	describe('CypherCommand', () => {
		it('should execute raw cypher query', async () => {
			mockGraphService.query = mock(async () => ({
				resultSet: [['test result']]
			}));

			const command = new CypherCommand(mockGraphService as GraphService);

			try {
				await command.run(['MATCH (n) RETURN n LIMIT 1']);
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('Cypher Query Results');
		});
	});

	describe('RelatedCommand', () => {
		it('should find related documents', async () => {
			mockGraphService.query = mock(async () => ({
				resultSet: [
					['docs/related.md', 'Related Document', 3]
				]
			}));

			const command = new RelatedCommand(
				mockGraphService as GraphService,
				mockPathResolverService as PathResolverService
			);

			try {
				await command.run(['docs/test.md'], {});
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('Documents Related to');
		});

		it('should show no related documents message when none found', async () => {
			mockGraphService.query = mock(async () => ({ resultSet: [] }));

			const command = new RelatedCommand(
				mockGraphService as GraphService,
				mockPathResolverService as PathResolverService
			);

			try {
				await command.run(['docs/test.md'], {});
			} catch (e) {
				// Expected - process.exit mock throws
			}

			const logs = consoleLogSpy.mock.calls.map((call: any) => call[0]);
			expect(logs.join('\n')).toContain('No related documents found');
		});

		it('parseLimit should return the value', () => {
			const command = new RelatedCommand(
				mockGraphService as GraphService,
				mockPathResolverService as PathResolverService
			);
			expect(command.parseLimit('20')).toBe('20');
		});
	});
});
