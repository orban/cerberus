import { type ExitCode, EXIT_CODE } from "./types.js";

export class CerberusError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CerberusError";
    this.exitCode = exitCode;
  }
}

export class ConfigError extends CerberusError {
  constructor(message: string) {
    super(message, EXIT_CODE.CONFIG_ERROR);
    this.name = "ConfigError";
  }
}
