import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GraphModule } from "../graph/graph.module.js";
import { CascadeService } from "./cascade.service.js";
import { DocumentParserService } from "./document-parser.service.js";
import { ManifestService } from "./manifest.service.js";
import { OntologyService } from "./ontology.service.js";
import { PathResolverService } from "./path-resolver.service.js";
import { SyncService } from "./sync.service.js";

@Module({
	imports: [GraphModule, EmbeddingModule],
	providers: [
		SyncService,
		ManifestService,
		DocumentParserService,
		OntologyService,
		CascadeService,
		PathResolverService,
	],
	exports: [
		SyncService,
		ManifestService,
		DocumentParserService,
		OntologyService,
		CascadeService,
		PathResolverService,
	],
})
export class SyncModule {}
