import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
	CypherCommand,
	InitCommand,
	OntologyCommand,
	RelsCommand,
	SearchCommand,
	StatusCommand,
	SyncCommand,
	ValidateCommand,
} from "./commands/index.js";
import { EmbeddingModule } from "./embedding/embedding.module.js";
import { GraphModule } from "./graph/graph.module.js";
import { QueryModule } from "./query/query.module.js";
import { SyncModule } from "./sync/sync.module.js";

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
		SearchCommand,
		RelsCommand,
		CypherCommand,
		ValidateCommand,
		OntologyCommand,
		InitCommand,
	],
})
export class AppModule {}
