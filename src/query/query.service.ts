import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";
import type { CypherResult } from "../graph/graph.types.js";

@Injectable()
export class QueryService {
	private readonly logger = new Logger(QueryService.name);

	constructor(private graphService: GraphService) {}

	async query(sql: string): Promise<CypherResult> {
		this.logger.debug(`Executing query: ${sql}`);
		return await this.graphService.query(sql);
	}
}
