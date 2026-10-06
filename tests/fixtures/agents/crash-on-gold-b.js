#!/usr/bin/env node
// Succeeds on every scenario except GOLD-B, where it exits nonzero.
//
// `executeTrial()` never rejects, so this arrives at the calibration pass as a
// normal TrialOutput with exitCode 1 and empty stdout. The gold-set pass must
// skip it rather than ask the judge to rule on a crash.
import { readFileSync } from "node:fs";

const scenarioPath = process.argv[process.argv.indexOf("--scenario") + 1];
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));

if (scenario.input.trim() === "GOLD-B") {
  process.stderr.write("Fatal error: the agent died on this scenario\n");
  process.exit(1);
}

const output = {
  suggestions: [{ file_exists: true, message: "Looks good" }],
  summary: `Reviewed: ${scenario.input.slice(0, 50)}`,
};

process.stdout.write(JSON.stringify(output));
