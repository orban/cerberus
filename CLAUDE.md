# Cerberus

Statistical CI/CD for AI agents.

## Commands

- `npm run build` — Build with tsup
- `npm test` — Run tests with vitest
- `npm run typecheck` — Type-check with tsc
- `npm run dev` — Run CLI in dev mode with tsx

## Conventions

- TypeScript strict mode, ESM only
- No `any` in source code
- 4 runtime deps: commander, zod, yaml, picocolors
- Use `node:` prefix for Node.js built-in imports
- Prefer `readonly` for interface fields
- Tests in `tests/` directory using vitest
- Assertions use `vm.runInNewContext()`, never `new Function()`
- Adapter uses `spawn()` with `shell: false`, never shell execution
