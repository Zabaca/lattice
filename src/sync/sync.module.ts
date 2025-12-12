import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { CascadeService } from "./cascade.service.js";
import { DatabaseChangeDetectorService } from "./database-change-detector.service.js";
import { DocumentParserService } from "./document-parser.service.js";
import { EntityExtractorService } from "./entity-extractor.service.js";
import { GraphValidatorService } from "./graph-validator.service.js";
import { ManifestService } from "./manifest.service.js";
import { OntologyService } from "./ontology.service.js";
import { PathResolverService } from "./path-resolver.service.js";
import { SyncService } from "./sync.service.js";

@Module({
	imports: [GraphModule, EmbeddingModule],
	providers: [
		SyncService,
		ManifestService,
		DatabaseChangeDetectorService,
		EntityExtractorService,
		DocumentParserService,
		OntologyService,
		CascadeService,
		PathResolverService,
		GraphValidatorService,
	],
	exports: [
		SyncService,
		ManifestService,
		DatabaseChangeDetectorService,
		EntityExtractorService,
		DocumentParserService,
		OntologyService,
		CascadeService,
		PathResolverService,
		GraphValidatorService,
	],
})
export class SyncModule {}
