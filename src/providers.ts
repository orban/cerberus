// Shared LLM provider clients. Used by judge panels (judges.ts) and
// claim generation (pcc/claims.ts). Raw fetch, no SDK dependencies.

export type ProviderFn = (prompt: string, model: string) => Promise<string>;

export interface Provider {
  readonly call: ProviderFn;
  readonly name: string;
}

export function getProvider(model: string): Provider | null {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
    return { call: callOpenAI, name: "openai" };
  }
  if (model.startsWith("claude-")) {
    return { call: callAnthropic, name: "anthropic" };
  }
  if (model.startsWith("gemini-")) {
    return { call: callGoogle, name: "google" };
  }
  return null;
}

export function getEnvVar(providerName: string): string | undefined {
  switch (providerName) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY;
    default:
      return undefined;
  }
}

export const TIMEOUT_MS = 60_000;

export async function callOpenAI(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { choices: Array<{ message: { content: string } }> })
      .choices[0]?.message?.content;
    if (typeof content !== "string") throw new Error("No content in OpenAI response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { content: Array<{ text: string }> })
      .content[0]?.text;
    if (typeof content !== "string") throw new Error("No content in Anthropic response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function callGoogle(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data: unknown = await res.json();
    const content = (data as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> })
      .candidates[0]?.content?.parts[0]?.text;
    if (typeof content !== "string") throw new Error("No content in Google response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
