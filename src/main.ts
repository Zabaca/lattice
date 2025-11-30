#!/usr/bin/env node

import "reflect-metadata";
import { CommandFactory } from "nest-commander";
import { AppModule } from "./app.module.js";

async function bootstrap() {
	await CommandFactory.run(AppModule, ["error"]);
}

bootstrap().catch((err) => {
	console.error("❌ CLI failed:", err);
	process.exit(1);
});
