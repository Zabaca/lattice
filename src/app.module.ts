import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
	InitCommand,
	MigrateCommand,
	OntologyCommand,
	RelsCommand,
	SearchCommand,
	SqlCommand,
	StatusCommand,
	SyncCommand,
	ValidateCommand,
} from "./commands/index.js";
import { EmbeddingModule } from "./embedding/embedding.module.js";
import { GraphModule } from "./graph/graph.module.js";
import { QueryModule } from "./query/query.module.js";
import { SyncModule } from "./sync/sync.module.js";
import { getEnvPath } from "./utils/paths.js";

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			envFilePath: getEnvPath(),
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
		SqlCommand,
		ValidateCommand,
		OntologyCommand,
		InitCommand,
		MigrateCommand,
	],
})
export class AppModule {}
