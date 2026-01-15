import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import {
	ExtractCommand,
	InitCommand,
	OntologyCommand,
	QuestionAddCommand,
	QuestionLinkCommand,
	QuestionUnansweredCommand,
	ReceiveCommand,
	RelsCommand,
	SearchCommand,
	ShareCommand,
	SiteCommand,
	SqlCommand,
	StatusCommand,
	SyncCommand,
} from "./commands/index.js";
import { EmbeddingModule } from "./embedding/embedding.module.js";
import { GraphModule } from "./graph/graph.module.js";
import { QueryModule } from "./query/query.module.js";
import { SiteModule } from "./site/index.js";
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
		SiteModule,
	],
	providers: [
		// CLI Commands
		ExtractCommand,
		SyncCommand,
		StatusCommand,
		SearchCommand,
		RelsCommand,
		SqlCommand,
		OntologyCommand,
		InitCommand,
		SiteCommand,
		ShareCommand,
		ReceiveCommand,
		QuestionAddCommand,
		QuestionLinkCommand,
		QuestionUnansweredCommand,
	],
})
export class AppModule {}
