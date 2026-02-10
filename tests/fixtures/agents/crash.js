#!/usr/bin/env node
// Simulates a crashing agent
process.stderr.write("Fatal error: something went wrong\n");
process.exit(1);
