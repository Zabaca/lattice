import { Command } from 'commander';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { SyncService } from '../sync/sync.service.js';
import { ManifestService } from '../sync/manifest.service.js';

export function registerStatusCommand(program: Command) {
	program
		.command('status')
		.description('Show documents that need syncing (new or updated)')
		.option('-v, --verbose', 'Show all documents including unchanged')
		.action(async (options) => {
			let app;
			try {
				app = await NestFactory.createApplicationContext(AppModule, {
					logger: false,
				});
				const sync = app.get(SyncService);
				const manifest = app.get(ManifestService);

				// Load manifest before detecting changes
				await manifest.load();

				// Detect all changes
				const changes = await sync.detectChanges();

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
					console.log('💡 Run `bun graph sync` to apply changes\n');
				}

				await app.close();
				process.exit(0);
			} catch (error) {
				console.error(
					'Error:',
					error instanceof Error ? error.message : String(error)
				);
				if (app) await app.close();
				process.exit(1);
			}
		});
}
