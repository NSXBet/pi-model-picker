#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

function getAgentDir() {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

const agentDir = getAgentDir();
const EXTENSION_DIR = join(agentDir, "extensions", "model-picker");

function log(msg) {
	console.log(`[pi-model-picker] ${msg}`);
}

function main() {
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
	log(`Installing version ${pkg.version}...`);

	mkdirSync(EXTENSION_DIR, { recursive: true });

	const files = ["package.json", ...(pkg.files || [])];

	for (const rawEntry of files) {
		const entry = rawEntry.replace(/\/+$/, "");
		const src = join(packageRoot, entry);
		const dest = join(EXTENSION_DIR, entry);

		if (!existsSync(src)) continue;

		try {
			const stat = statSync(src);
			if (stat.isDirectory()) {
				mkdirSync(dest, { recursive: true });
				cpSync(src, dest, { recursive: true });
				log(`Copied ${entry}/`);
			} else {
				cpSync(src, dest);
				log(`Copied ${entry}`);
			}
		} catch (error) {
			log(`Warning: Could not copy ${entry}: ${error.message}`);
		}
	}

	log("");
	log("Installation complete!");
	log("");
	log("Restart pi to load the extension.");
	log("");
	log("Usage:");
	log("  /models          — open the categorized model picker");
	log("  Ctrl+Shift+M     — keyboard shortcut");
	log("");
}

main();
