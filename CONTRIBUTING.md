# Contributing to C4Loom

Thanks for helping make architecture diagrams reproducible and useful.

## Development setup

Install Node.js 22+, Java 21+, and Git, then run:

```sh
npm ci
npm run setup
npx playwright install chromium
npm test
npm run test:e2e
```

On Linux, use `npx playwright install --with-deps chromium` when browser system
libraries are missing.

## Changes that need real rendering tests

Changes to model compilation, rendering, process supervision, filesystem
boundaries, or MCP responses must pass the real end-to-end suite. A unit test
or an engine hash check alone does not demonstrate working image generation.

Keep `stdout` exclusively for MCP JSON-RPC. Send diagnostics and progress logs
to `stderr`. Preserve local-first defaults, explicit model validation, editable
sources, transparent image canvases, and honest error reporting.

## Pull requests

1. Describe the problem and the observable change.
2. Add focused tests for new or changed behavior.
3. Run unit tests and applicable real rendering tests.
4. Update the README or example if the public contract changes.
5. Do not commit downloaded engines, dependencies, local configurations, logs,
   generated run directories, credentials, or unrelated project files.

The example model documents this repository's own tool. Keep it consistent
with the actual functions and components in `src/`.
