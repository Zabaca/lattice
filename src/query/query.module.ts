import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { GraphService } from "../graph/graph.service.js";
import { QueryService } from "./query.service.js";

@Module({
	imports: [GraphModule, EmbeddingModule],
	providers: [QueryService, GraphService],
	exports: [QueryService, GraphService],
})
export class QueryModule {}
