import { Module } from "@nestjs/common";
import { GraphService } from "./graph.service.js";

@Module({
	providers: [GraphService],
	exports: [GraphService],
})
export class GraphModule {}
