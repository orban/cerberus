import { Command } from "commander";
import { EXIT_CODE } from "./types.js";
import { CerberusError } from "./errors.js";

const program = new Command();

program
  .name("cerberus")
  .description("Statistical CI/CD for AI agents")
  .version("0.1.0");

program
  .command("run")
  .description("Run the test suite defined in cerberus.yaml")
  .option("-c, --config <path>", "Path to config file", "cerberus.yaml")
  .option("--json", "Output results as JSON")
  .option("-o, --output <path>", "Write JSON results to file")
  .action(async (options: { config: string; json?: boolean; output?: string }) => {
    // Phase 2 will wire this up
    const { loadConfig } = await import("./config.js");
    try {
      const config = await loadConfig(options.config);
      const { runSuite } = await import("./runner.js");
      const { formatResults, writeJsonOutput, persistResult } = await import("./output.js");
      const result = await runSuite(config, {
        json: options.json ?? false,
      });
      if (options.json || options.output) {
        const json = writeJsonOutput(result);
        if (options.output) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(options.output, json + "\n", "utf-8");
        }
        if (options.json) {
          process.stdout.write(json + "\n");
        }
      } else {
        formatResults(result);
      }

      // Persist result to .cerberus/runs/
      await persistResult(result);
      process.exit(result.status === "pass" ? EXIT_CODE.PASS
        : result.status === "fail" ? EXIT_CODE.FAIL
        : result.status === "inconclusive" ? EXIT_CODE.INCONCLUSIVE
        : EXIT_CODE.RUNTIME_ERROR);
    } catch (e) {
      if (e instanceof CerberusError) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(e.exitCode);
      }
      throw e;
    }
  });

program
  .command("init")
  .description("Scaffold a cerberus.yaml config file")
  .option("--force", "Overwrite existing config")
  .action(async (options: { force?: boolean }) => {
    // Phase 4 will implement this
    const { existsSync } = await import("node:fs");
    const { writeFile, mkdir } = await import("node:fs/promises");

    const configPath = "cerberus.yaml";
    if (!options.force && existsSync(configPath)) {
      process.stderr.write(`Error: ${configPath} already exists. Use --force to overwrite.\n`);
      process.exit(EXIT_CODE.CONFIG_ERROR);
    }

    const template = `# Cerberus configuration
adapter:
  command: "node ./agent.js --scenario {{scenario}}"
  timeout: 30000

studies:
  - name: default
    scenario: scenarios/example.yaml
    contracts:
      - name: produces-valid-output
        type: code
        assert: "output.meta.exitCode === 0"
        threshold: 0.95
        trials: 20
`;

    const scenarioTemplate = `input: |
  Your test input goes here.
metadata:
  category: default
`;

    await mkdir("scenarios", { recursive: true });
    await writeFile(configPath, template, "utf-8");
    await writeFile("scenarios/example.yaml", scenarioTemplate, "utf-8");

    process.stdout.write(`Created ${configPath} and scenarios/example.yaml\n`);
    process.stdout.write("Edit the config and run: cerberus run\n");
  });

program.parse();
