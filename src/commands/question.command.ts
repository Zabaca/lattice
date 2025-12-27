import { Injectable } from "@nestjs/common";
import { Command, CommandRunner, Option } from "nest-commander";
import { EmbeddingService } from "../embedding/embedding.service.js";
import { GraphService } from "../graph/graph.service.js";

/**
 * Escape special characters in SQL string values
 */
function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}

// Question Add Command
interface QuestionAddOptions {
	answeredBy?: string;
}

@Injectable()
@Command({
	name: "question:add",
	arguments: "<question>",
	description: "Add a new question to the knowledge graph",
})
export class QuestionAddCommand extends CommandRunner {
	constructor(
		private readonly graphService: GraphService,
		private readonly embeddingService: EmbeddingService,
	) {
		super();
	}

	async run(inputs: string[], options: QuestionAddOptions): Promise<void> {
		const questionText = inputs[0];

		if (!questionText) {
			console.error("Error: Question text is required");
			console.error('Usage: lattice question:add "your question"');
			process.exit(1);
		}

		try {
			// 1. Create Question node
			await this.graphService.upsertNode("Question", {
				name: questionText,
				text: questionText,
				createdAt: new Date().toISOString(),
			});

			// 2. Generate and store embedding for semantic search
			const embedding = await this.embeddingService.generateEmbedding(
				`Question: ${questionText}`,
			);
			await this.graphService.updateNodeEmbedding(
				"Question",
				questionText,
				embedding,
			);

			console.log(`\n✅ Added question: "${questionText}"`);

			// 3. If --answered-by provided, also create relationship
			if (options.answeredBy) {
				// Check if document exists
				const docResult = await this.graphService.query(`
					SELECT name FROM nodes
					WHERE label = 'Document' AND name = '${escapeSql(options.answeredBy)}'
				`);

				if (docResult.resultSet.length === 0) {
					console.log(`\n⚠️  Document not found: ${options.answeredBy}`);
					console.log(
						"   Run 'lattice sync' first to add documents to the graph.",
					);
					console.log("   Question was created but not linked.\n");
					process.exit(0);
				}

				await this.graphService.upsertRelationship(
					"Question",
					questionText,
					"ANSWERED_BY",
					"Document",
					options.answeredBy,
					{},
				);
				console.log(`   Linked to: ${options.answeredBy}`);
			}

			console.log();
			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	@Option({
		flags: "--answered-by <path>",
		description: "Immediately link to a document that answers this question",
	})
	parseAnsweredBy(value: string): string {
		return value;
	}
}

// Question Link Command
interface QuestionLinkOptions {
	doc: string;
}

@Injectable()
@Command({
	name: "question:link",
	arguments: "<question>",
	description: "Link a question to a document via ANSWERED_BY relationship",
})
export class QuestionLinkCommand extends CommandRunner {
	constructor(
		private readonly graphService: GraphService,
		private readonly embeddingService: EmbeddingService,
	) {
		super();
	}

	async run(inputs: string[], options: QuestionLinkOptions): Promise<void> {
		const questionText = inputs[0];

		if (!questionText) {
			console.error("Error: Question text is required");
			console.error(
				'Usage: lattice question:link "your question" --doc path/to/doc.md',
			);
			process.exit(1);
		}

		if (!options.doc) {
			console.error("Error: --doc flag is required");
			console.error(
				'Usage: lattice question:link "your question" --doc path/to/doc.md',
			);
			process.exit(1);
		}

		try {
			// Check if Question exists; if not, create it with embedding
			const existingQuestions = await this.graphService.query(`
				SELECT name FROM nodes
				WHERE label = 'Question' AND name = '${escapeSql(questionText)}'
			`);

			if (existingQuestions.resultSet.length === 0) {
				// Create the question first
				await this.graphService.upsertNode("Question", {
					name: questionText,
					text: questionText,
					createdAt: new Date().toISOString(),
				});

				const embedding = await this.embeddingService.generateEmbedding(
					`Question: ${questionText}`,
				);
				await this.graphService.updateNodeEmbedding(
					"Question",
					questionText,
					embedding,
				);

				console.log(`\n✅ Created question: "${questionText}"`);
			}

			// Check if Document exists
			const existingDocs = await this.graphService.query(`
				SELECT name FROM nodes
				WHERE label = 'Document' AND name = '${escapeSql(options.doc)}'
			`);

			if (existingDocs.resultSet.length === 0) {
				console.error(`\n❌ Document not found in graph: ${options.doc}`);
				console.error(
					"   Run 'lattice sync' first to add documents to the graph.\n",
				);
				process.exit(1);
			}

			// Create ANSWERED_BY relationship
			await this.graphService.upsertRelationship(
				"Question",
				questionText,
				"ANSWERED_BY",
				"Document",
				options.doc,
				{},
			);

			console.log(`\n✅ Linked: "${questionText}"`);
			console.log(`        → ${options.doc}\n`);
			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	@Option({
		flags: "-d, --doc <path>",
		description: "Path to the document that answers this question",
	})
	parseDoc(value: string): string {
		return value;
	}
}

// Question Unanswered Command
@Injectable()
@Command({
	name: "question:unanswered",
	description: "List all questions without ANSWERED_BY relationships",
})
export class QuestionUnansweredCommand extends CommandRunner {
	constructor(private readonly graphService: GraphService) {
		super();
	}

	async run(): Promise<void> {
		try {
			// SQL to find Questions without ANSWERED_BY relationships
			const result = await this.graphService.query(`
				SELECT
					q.name as question,
					q.properties->>'createdAt' as created_at,
					q.created_at as db_created_at
				FROM nodes q
				WHERE q.label = 'Question'
					AND NOT EXISTS (
						SELECT 1 FROM relationships r
						WHERE r.source_label = 'Question'
							AND r.source_name = q.name
							AND r.relation_type = 'ANSWERED_BY'
					)
				ORDER BY COALESCE(q.properties->>'createdAt', q.created_at::VARCHAR) DESC
			`);

			console.log("\n=== Unanswered Questions ===\n");

			if (result.resultSet.length === 0) {
				console.log("No unanswered questions found.\n");
				console.log(
					'Add questions with: lattice question:add "your question"\n',
				);
				process.exit(0);
			}

			result.resultSet.forEach((row, idx) => {
				const [question, createdAt, dbCreatedAt] = row as [
					string,
					string | null,
					string | null,
				];
				const displayDate = createdAt || dbCreatedAt || "unknown";
				console.log(`${idx + 1}. ${question}`);
				console.log(`   Created: ${displayDate}`);
			});

			console.log(
				`\nTotal: ${result.resultSet.length} unanswered question(s)\n`,
			);
			console.log("To link a question to an answer:");
			console.log(
				'  lattice question:link "question text" --doc path/to/doc.md\n',
			);

			process.exit(0);
		} catch (error) {
			console.error(
				"Error:",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}
}
