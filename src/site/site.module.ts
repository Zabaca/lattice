import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module.js";
import { WelcomeGeneratorService } from "./welcome-generator.service.js";

@Module({
	imports: [GraphModule],
	providers: [WelcomeGeneratorService],
	exports: [WelcomeGeneratorService],
})
export class SiteModule {}
