import { Injectable, Logger } from "@nestjs/common";
import { GraphService } from "../graph/graph.service.js";

export interface GraphValidationIssue {
	type: "error" | "warning";
	nodeLabel: string;
	nodeName: string;
	field: string;
	message: string;
	suggestion?: string;
}

export interface GraphValidationResult {
	valid: boolean;
	issues: GraphValidationIssue[];
	stats: {
		totalNodes: number;
		documentsChecked: number;
		entitiesChecked: number;
		errorsFound: number;
		warningsFound: number;
	};
}

/**
 * Service for validating graph data consistency and completeness
 */
@Injectable()
export class GraphValidatorService {
	private readonly logger = new Logger(GraphValidatorService.name);

	constructor(private readonly graph: GraphService) {}

	/**
	 * Validate all nodes in the graph for property consistency and required fields
	 */
	async validateGraph(): Promise<GraphValidationResult> {
		const issues: GraphValidationIssue[] = [];
		let totalNodes = 0;
		let documentsChecked = 0;
		let entitiesChecked = 0;

		try {
			// Get all nodes from graph
			const result = await this.graph.query(
				"SELECT label, name, properties FROM nodes",
			);

			totalNodes = result.resultSet.length;

			for (const row of result.resultSet) {
				const label = row[0] as string;
				const name = row[1] as string;
				const propertiesJson = row[2] as string;

				let properties: Record<string, unknown>;
				try {
					properties =
						typeof propertiesJson === "string"
							? JSON.parse(propertiesJson)
							: propertiesJson;
				} catch (error) {
					issues.push({
						type: "error",
						nodeLabel: label,
						nodeName: name,
						field: "properties",
						message: "Invalid JSON in properties field",
						suggestion: "Re-sync this document to fix corrupted data",
					});
					continue;
				}

				if (label === "Document") {
					documentsChecked++;
					this.validateDocumentNode(name, properties, issues);
				} else {
					entitiesChecked++;
					this.validateEntityNode(label, name, properties, issues);
				}
			}
		} catch (error) {
			this.logger.error(
				`Graph validation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}

		const errorsFound = issues.filter((i) => i.type === "error").length;
		const warningsFound = issues.filter((i) => i.type === "warning").length;

		return {
			valid: errorsFound === 0,
			issues,
			stats: {
				totalNodes,
				documentsChecked,
				entitiesChecked,
				errorsFound,
				warningsFound,
			},
		};
	}

	/**
	 * Validate Document node properties
	 */
	private validateDocumentNode(
		name: string,
		properties: Record<string, unknown>,
		issues: GraphValidationIssue[],
	): void {
		// Check for duplicate 'name' in properties (should only be in column)
		if ("name" in properties) {
			issues.push({
				type: "warning",
				nodeLabel: "Document",
				nodeName: name,
				field: "name",
				message: "Duplicate 'name' field in properties (already in column)",
				suggestion: "Re-sync to remove duplicate",
			});
		}

		// Required fields for documents
		const requiredFields = ["title", "contentHash"];
		for (const field of requiredFields) {
			if (!(field in properties)) {
				issues.push({
					type: "error",
					nodeLabel: "Document",
					nodeName: name,
					field,
					message: `Missing required field: ${field}`,
					suggestion: "Re-sync this document to populate required fields",
				});
			}
		}

		// Recommended fields for documents
		const recommendedFields = ["summary", "created", "updated", "status"];
		for (const field of recommendedFields) {
			if (!(field in properties)) {
				issues.push({
					type: "warning",
					nodeLabel: "Document",
					nodeName: name,
					field,
					message: `Missing recommended field: ${field}`,
					suggestion: `Add '${field}' to document frontmatter`,
				});
			}
		}
	}

	/**
	 * Validate entity node properties (Technology, Tool, Concept, etc.)
	 */
	private validateEntityNode(
		label: string,
		name: string,
		properties: Record<string, unknown>,
		issues: GraphValidationIssue[],
	): void {
		// Check for duplicate 'name' in properties (should only be in column)
		if ("name" in properties) {
			issues.push({
				type: "warning",
				nodeLabel: label,
				nodeName: name,
				field: "name",
				message: "Duplicate 'name' field in properties (already in column)",
				suggestion: "Re-sync to remove duplicate",
			});
		}

		// Required field: description
		if (!("description" in properties) || !properties.description) {
			issues.push({
				type: "error",
				nodeLabel: label,
				nodeName: name,
				field: "description",
				message: "Missing required field: description",
				suggestion: `Add description to ${label} entity in frontmatter`,
			});
		}
	}

	/**
	 * Validate specific document by path
	 */
	async validateDocument(path: string): Promise<GraphValidationIssue[]> {
		const issues: GraphValidationIssue[] = [];

		try {
			const result = await this.graph.query(
				`SELECT label, name, properties FROM nodes WHERE label = 'Document' AND name = '${this.graph.escape(path)}'`,
			);

			if (result.resultSet.length === 0) {
				issues.push({
					type: "error",
					nodeLabel: "Document",
					nodeName: path,
					field: "node",
					message: "Document not found in graph",
					suggestion: "Run 'lattice sync' to add this document",
				});
				return issues;
			}

			const row = result.resultSet[0];
			const propertiesJson = row[2] as string;
			const properties =
				typeof propertiesJson === "string"
					? JSON.parse(propertiesJson)
					: propertiesJson;

			this.validateDocumentNode(path, properties, issues);
		} catch (error) {
			this.logger.error(
				`Failed to validate document ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}

		return issues;
	}
}
