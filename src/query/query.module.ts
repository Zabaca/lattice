import { Module } from "@nestjs/common";
import { QueryService } from "./query.service.js";
import { GraphModule } from "../graph/graph.module.js";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GraphService } from "../graph/graph.service.js";

@Module({
	imports: [GraphModule, EmbeddingModule],
	providers: [QueryService, GraphService],
	exports: [QueryService, GraphService],
})
export class QueryModule {}
