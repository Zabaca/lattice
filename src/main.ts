import { program } from 'commander';
import {
	registerSyncCommand,
	registerStatusCommand,
	registerQueryCommands,
	registerValidateCommand,
	registerOntologyCommand,
	registerInitCommand,
} from './commands/index.js';

// Set up CLI metadata
program
	.name('lattice')
	.description(
		'Human-initiated, AI-powered knowledge graph for markdown documentation',
	)
	.version('0.3.0');

// Register all commands
registerInitCommand(program);
registerSyncCommand(program);
registerStatusCommand(program);
registerQueryCommands(program);
registerValidateCommand(program);
registerOntologyCommand(program);

// Parse and execute
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
	program.outputHelp();
}
