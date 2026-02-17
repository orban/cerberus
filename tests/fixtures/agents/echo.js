#!/usr/bin/env node
// Reads scenario from file, echoes structured JSON output
import { readFileSync } from "node:fs";

const scenarioPath = process.argv[process.argv.indexOf("--scenario") + 1];
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));

const output = {
  suggestions: [
    { file_exists: true, message: "Looks good" },
  ],
  summary: `Reviewed: ${scenario.input.slice(0, 50)}`,
};

process.stdout.write(JSON.stringify(output));
