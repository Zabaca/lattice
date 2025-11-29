import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphModule } from './graph/graph.module.js';
import { SyncModule } from './sync/sync.module.js';
import { EmbeddingModule } from './embedding/embedding.module.js';
import { QueryModule } from './query/query.module.js';
import {
	SyncCommand,
	StatusCommand,
	StatsCommand,
	SearchCommand,
	RelsCommand,
	CypherCommand,
	RelatedCommand,
	ValidateCommand,
	OntologyCommand,
	InitCommand,
} from './commands/index.js';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		GraphModule,
		SyncModule,
		EmbeddingModule,
		QueryModule,
	],
	providers: [
		// CLI Commands
		SyncCommand,
		StatusCommand,
		StatsCommand,
		SearchCommand,
		RelsCommand,
		CypherCommand,
		RelatedCommand,
		ValidateCommand,
		OntologyCommand,
		InitCommand,
	],
})
export class AppModule {}
