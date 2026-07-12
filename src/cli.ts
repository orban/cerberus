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

interface CheckCliOptions {
  readonly base?: string;
  readonly policy?: string;
  readonly description?: string;
  readonly descriptionFile?: string;
  readonly model?: string;
  readonly llm: boolean; // --no-llm flips this to false
  readonly llmContent: string;
  readonly json?: boolean;
  readonly output?: string;
  readonly advisory?: boolean;
  readonly override?: string;
  readonly replay?: string;
  readonly replayMerges?: string;
}

program
  .command("check")
  .description("Analyze a git change range into a Change Contract with a policy verdict")
  .argument("[range]", "git range (base..head, base...head, or a single base ref; default: merge-base with the base branch)")
  .option("--base <ref>", "Base ref (default resolution: origin/HEAD > origin/main > origin/master > main > master)")
  .option("--policy <path>", "Policy YAML (default: ./pcc-policy.yaml when present, else the embedded advisory-first default)")
  .option("--description <text>", "Task or PR description")
  .option("--description-file <path>", "Read the task or PR description from a file")
  .option("--model <model>", "LLM model for claim generation")
  .option("--no-llm", "Skip LLM claim generation (deterministic claims only)")
  .option("--llm-content <mode>", "Prompt content mode: hunks or minimal (no raw diff content)", "hunks")
  .option("--json", "Output the result as JSON instead of markdown")
  .option("-o, --output <path>", "Write JSON result to a file")
  .option("--advisory", "Always exit 0 (verdict still reported)")
  .option("--override <owner-rationale>", 'Record a reviewer override: "<owner>: <rationale>" (exits 0)')
  .option("--replay <path>", "Batch mode: analyze newline-separated ranges from a file")
  .option("--replay-merges <n>", "Batch mode: analyze the last N first-parent merge commits")
  .action(async (range: string | undefined, options: CheckCliOptions) => {
    const { CerberusError, ConfigError } = await import("./errors.js");
    try {
      if (options.llmContent !== "hunks" && options.llmContent !== "minimal") {
        throw new ConfigError(`Invalid --llm-content: ${options.llmContent} (expected hunks or minimal)`);
      }

      const cwd = process.cwd();
      const { existsSync } = await import("node:fs");

      let policyPath: string | undefined = options.policy;
      if (!policyPath && existsSync("pcc-policy.yaml")) {
        policyPath = "pcc-policy.yaml";
      }

      let description = options.description;
      if (options.descriptionFile !== undefined) {
        const { readFile } = await import("node:fs/promises");
        try {
          description = await readFile(options.descriptionFile, "utf-8");
        } catch {
          throw new ConfigError(`Cannot read description file: ${options.descriptionFile}`);
        }
      }

      if (options.replay !== undefined || options.replayMerges !== undefined) {
        const { runReplay } = await import("./pcc/replay.js");
        // Set exitCode instead of calling process.exit() so pending stdout
        // writes drain before the process ends (exit() drops piped output).
        process.exitCode = await runReplay({
          cwd,
          rangesFile: options.replay,
          merges: options.replayMerges !== undefined ? Number(options.replayMerges) : undefined,
          policyPath,
        });
        return;
      }

      const { runCheck } = await import("./pcc/check.js");
      const { renderMarkdown, renderJson, persistCheck } = await import("./pcc/report.js");

      process.stderr.write("Analyzing change range...\n");
      const result = await runCheck({
        cwd,
        range,
        base: options.base,
        description,
        policyPath,
        noLlm: !options.llm,
        model: options.model,
        llmContent: options.llmContent,
        advisory: options.advisory,
        override: options.override,
      });

      const json = renderJson(result);
      if (options.output) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(options.output, json + "\n", "utf-8");
      }
      if (options.json) {
        process.stdout.write(json + "\n");
      } else {
        process.stdout.write(renderMarkdown(result) + "\n");
      }

      const persisted = await persistCheck(result, cwd);
      process.stderr.write(`Result persisted to ${persisted}\n`);
      // exitCode, not process.exit(): the report can exceed the pipe buffer,
      // and exit() would truncate it mid-write in CI (`check ... | tee`).
      process.exitCode = result.effectiveExitCode;
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
