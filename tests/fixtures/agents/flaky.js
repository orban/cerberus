#!/usr/bin/env node
// Simulates a flaky agent that fails ~20% of the time
import { readFileSync } from "node:fs";

const scenarioPath = process.argv[process.argv.indexOf("--scenario") + 1];
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));

// 20% chance of failure
if (Math.random() < 0.20) {
  process.stderr.write("Intermittent failure\n");
  process.exit(1);
}

const output = {
  suggestions: [
    { file_exists: true, message: "Reviewed" },
  ],
  summary: `Reviewed: ${scenario.input.slice(0, 50)}`,
};

process.stdout.write(JSON.stringify(output));
