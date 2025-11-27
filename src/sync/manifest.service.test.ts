import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ManifestService } from './manifest.service.js';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';

describe('ManifestService', () => {
	let service: ManifestService;
	const testManifestPath = '.test-sync-manifest.json';

	beforeEach(() => {
		service = new ManifestService();
		// Override default path for testing
		(service as any).manifestPath = testManifestPath;
	});

	afterEach(async () => {
		// Clean up test files
		if (existsSync(testManifestPath)) {
			await rm(testManifestPath);
		}
	});

	describe('getContentHash', () => {
		it('should generate consistent hash for same content', () => {
			const content = 'Test content';
			const hash1 = service.getContentHash(content);
			const hash2 = service.getContentHash(content);

			expect(hash1).toBe(hash2);
		});

		it('should generate different hash for different content', () => {
			const hash1 = service.getContentHash('Content 1');
			const hash2 = service.getContentHash('Content 2');

			expect(hash1).not.toBe(hash2);
		});

		it('should generate valid SHA256 hash', () => {
			const hash = service.getContentHash('Test');
			// SHA256 produces 64 character hex string
			expect(hash).toMatch(/^[a-f0-9]{64}$/);
		});
	});

	describe('load and save', () => {
		it('should create empty manifest if file does not exist', async () => {
			const manifest = await service.load();

			expect(manifest).toBeDefined();
			expect(manifest.version).toBe('1.0');
			expect(manifest.documents).toEqual({});
			expect(manifest.lastSync).toBeDefined();
		});

		it('should save manifest to disk', async () => {
			const manifest = await service.load();
			manifest.documents['test.md'] = {
				contentHash: 'abc123',
				frontmatterHash: 'def456',
				lastSynced: new Date().toISOString(),
				entityCount: 5,
				relationshipCount: 3,
			};

			await service.save();

			expect(existsSync(testManifestPath)).toBe(true);
		});

		it('should persist and reload manifest correctly', async () => {
			const manifest = await service.load();
			manifest.documents['docs/test.md'] = {
				contentHash: 'abc123',
				frontmatterHash: 'def456',
				lastSynced: '2025-01-01T00:00:00Z',
				entityCount: 5,
				relationshipCount: 3,
			};

			await service.save();

			// Create new service instance
			const service2 = new ManifestService();
			(service2 as any).manifestPath = testManifestPath;

			const loadedManifest = await service2.load();

			expect(loadedManifest.documents['docs/test.md']).toBeDefined();
			expect(loadedManifest.documents['docs/test.md'].contentHash).toBe('abc123');
			expect(loadedManifest.documents['docs/test.md'].entityCount).toBe(5);
		});
	});

	describe('detectChange', () => {
		it('should detect new document', async () => {
			await service.load();
			const changeType = service.detectChange('docs/new.md', 'hash1', 'fmhash1');

			expect(changeType).toBe('new');
		});

		it('should detect unchanged document', async () => {
			const manifest = await service.load();
			manifest.documents['docs/test.md'] = {
				contentHash: 'hash1',
				frontmatterHash: 'fmhash1',
				lastSynced: new Date().toISOString(),
				entityCount: 5,
				relationshipCount: 3,
			};
			(service as any).manifest = manifest;

			const changeType = service.detectChange('docs/test.md', 'hash1', 'fmhash1');

			expect(changeType).toBe('unchanged');
		});

		it('should detect updated content', async () => {
			const manifest = await service.load();
			manifest.documents['docs/test.md'] = {
				contentHash: 'hash1',
				frontmatterHash: 'fmhash1',
				lastSynced: new Date().toISOString(),
				entityCount: 5,
				relationshipCount: 3,
			};
			(service as any).manifest = manifest;

			const changeType = service.detectChange('docs/test.md', 'hash2', 'fmhash1');

			expect(changeType).toBe('updated');
		});

		it('should detect updated frontmatter', async () => {
			const manifest = await service.load();
			manifest.documents['docs/test.md'] = {
				contentHash: 'hash1',
				frontmatterHash: 'fmhash1',
				lastSynced: new Date().toISOString(),
				entityCount: 5,
				relationshipCount: 3,
			};
			(service as any).manifest = manifest;

			const changeType = service.detectChange('docs/test.md', 'hash1', 'fmhash2');

			expect(changeType).toBe('updated');
		});
	});

	describe('updateEntry', () => {
		it('should add new entry to manifest', async () => {
			await service.load();

			service.updateEntry('docs/test.md', 'hash1', 'fmhash1', 5, 3);

			const entry = (service as any).manifest.documents['docs/test.md'];

			expect(entry).toBeDefined();
			expect(entry.contentHash).toBe('hash1');
			expect(entry.frontmatterHash).toBe('fmhash1');
			expect(entry.entityCount).toBe(5);
			expect(entry.relationshipCount).toBe(3);
			expect(entry.lastSynced).toBeDefined();
		});

		it('should update existing entry', async () => {
			await service.load();

			service.updateEntry('docs/test.md', 'hash1', 'fmhash1', 5, 3);
			service.updateEntry('docs/test.md', 'hash2', 'fmhash2', 10, 7);

			const entry = (service as any).manifest.documents['docs/test.md'];

			expect(entry.contentHash).toBe('hash2');
			expect(entry.entityCount).toBe(10);
		});
	});

	describe('removeEntry', () => {
		it('should remove entry from manifest', async () => {
			await service.load();

			service.updateEntry('docs/test.md', 'hash1', 'fmhash1', 5, 3);
			expect((service as any).manifest.documents['docs/test.md']).toBeDefined();

			service.removeEntry('docs/test.md');

			expect((service as any).manifest.documents['docs/test.md']).toBeUndefined();
		});

		it('should handle removing non-existent entry gracefully', async () => {
			await service.load();

			// Should not throw
			expect(() => {
				service.removeEntry('docs/nonexistent.md');
			}).not.toThrow();
		});
	});

	describe('getTrackedPaths', () => {
		it('should return all tracked document paths', async () => {
			await service.load();

			service.updateEntry('docs/test1.md', 'hash1', 'fmhash1', 5, 3);
			service.updateEntry('docs/test2.md', 'hash2', 'fmhash2', 10, 7);
			service.updateEntry('docs/subdir/test3.md', 'hash3', 'fmhash3', 2, 1);

			const paths = service.getTrackedPaths();

			expect(paths).toContain('docs/test1.md');
			expect(paths).toContain('docs/test2.md');
			expect(paths).toContain('docs/subdir/test3.md');
			expect(paths.length).toBe(3);
		});

		it('should return empty array when no documents tracked', async () => {
			await service.load();

			const paths = service.getTrackedPaths();

			expect(paths).toEqual([]);
		});
	});
});
