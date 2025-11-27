import { Module } from '@nestjs/common';
import { SyncService } from './sync.service.js';
import { ManifestService } from './manifest.service.js';
import { DocumentParserService } from './document-parser.service.js';
import { OntologyService } from './ontology.service.js';
import { CascadeService } from './cascade.service.js';
import { PathResolverService } from './path-resolver.service.js';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';

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
