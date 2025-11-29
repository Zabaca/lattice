import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { SyncService } from '../sync/sync.service.js';
import { ManifestService } from '../sync/manifest.service.js';

interface StatusCommandOptions {
	verbose?: boolean;
}

@Injectable()
@Command({
	name: 'status',
	description: 'Show documents that need syncing (new or updated)',
})
export class StatusCommand extends CommandRunner {
	constructor(
		private readonly syncService: SyncService,
		private readonly manifestService: ManifestService,
	) {
		super();
	}

	async run(_inputs: string[], options: StatusCommandOptions): Promise<void> {
		try {
			// Load manifest before detecting changes
			await this.manifestService.load();

			// Detect all changes
			const changes = await this.syncService.detectChanges();

			// Group by change type
			const newDocs = changes.filter((c) => c.changeType === 'new');
			const updatedDocs = changes.filter((c) => c.changeType === 'updated');
			const deletedDocs = changes.filter((c) => c.changeType === 'deleted');
			const unchangedDocs = changes.filter((c) => c.changeType === 'unchanged');

			const pendingCount = newDocs.length + updatedDocs.length + deletedDocs.length;

			console.log('\n📊 Graph Status\n');

			// Show new documents
			if (newDocs.length > 0) {
				console.log(`New (${newDocs.length}):`);
				newDocs.forEach((doc) => {
					console.log(`  + ${doc.path}`);
				});
				console.log();
			}

			// Show updated documents
			if (updatedDocs.length > 0) {
				console.log(`Updated (${updatedDocs.length}):`);
				updatedDocs.forEach((doc) => {
					console.log(`  ~ ${doc.path}`);
				});
				console.log();
			}

			// Show deleted documents
			if (deletedDocs.length > 0) {
				console.log(`Deleted (${deletedDocs.length}):`);
				deletedDocs.forEach((doc) => {
					console.log(`  - ${doc.path}`);
				});
				console.log();
			}

			// Show unchanged only in verbose mode
			if (options.verbose && unchangedDocs.length > 0) {
				console.log(`Unchanged (${unchangedDocs.length}):`);
				unchangedDocs.forEach((doc) => {
					console.log(`  · ${doc.path}`);
				});
				console.log();
			}

			// Summary
			if (pendingCount === 0) {
				console.log('✅ All documents are in sync\n');
			} else {
				console.log(`Total: ${pendingCount} document(s) need syncing`);
				console.log('💡 Run `lattice sync` to apply changes\n');
			}

			process.exit(0);
		} catch (error) {
			console.error(
				'Error:',
				error instanceof Error ? error.message : String(error)
			);
			process.exit(1);
		}
	}

	@Option({
		flags: '-v, --verbose',
		description: 'Show all documents including unchanged',
	})
	parseVerbose(): boolean {
		return true;
	}
}
