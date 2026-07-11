import { describe, it, expect } from "vitest";
import { getProvider, getEnvVar } from "../../src/providers.js";

describe("providers module (shared surface)", () => {
  it("routes model prefixes to providers", () => {
    expect(getProvider("claude-sonnet-5")!.name).toBe("anthropic");
    expect(getProvider("gpt-4o")!.name).toBe("openai");
    expect(getProvider("gemini-2.0-flash")!.name).toBe("google");
    expect(getProvider("llama-3")).toBeNull();
  });

  it("maps provider names to env vars", () => {
    expect(getEnvVar("unknown")).toBeUndefined();
  });
});
