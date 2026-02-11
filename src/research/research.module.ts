import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ExaSearchService } from "./exa-search.service.js";

@Module({
	imports: [ConfigModule],
	providers: [ExaSearchService],
	exports: [ExaSearchService],
})
export class ResearchModule {}
