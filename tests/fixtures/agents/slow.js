#!/usr/bin/env node
// Simulates a slow agent that exceeds timeout
setTimeout(() => {
  process.stdout.write(JSON.stringify({ result: "finally done" }));
}, 60_000);
