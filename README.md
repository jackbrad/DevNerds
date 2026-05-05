# DevNerds

A blueprint-based orchestration engine that runs AI coding agents through
deterministic + agentic workflows to ship verified code from task specs.

DevNerds is **project-agnostic** — point it at one or more git repos via a
config file, give it a task, and it plans, builds, evaluates, commits, and
pushes the result.

## Status

Early-stage. The API surface and config schema may still change. The first
production user is the [GoFlight](https://goflight.ai) engineering team; the
codebase has been extracted and genericized for public release.

## Key concepts

- **Blueprints** — State machines mixing deterministic nodes (lint, test,
  git) with agentic nodes (plan, build, evaluate, ship).
- **Steps** — Dynamically composed prompts: skeleton + task-specific blocks
  + service context + artifacts.
- **6-layer context** — Project brain → expertise skills → path rules →
  dynamic step prompt → on-demand discovery → hooks.
- **Hooks** — Exit-code-2 deterministic guardrails (file ownership, commit
  format, forbidden patterns).
- **Static artifacts** — Every step writes its output to disk. Full
  observability. Resumable from any point.

## Architecture

Visual overview: [`docs/architecture.excalidraw`](docs/architecture.excalidraw)
— drag the file onto [excalidraw.com](https://excalidraw.com) to view (deployment
topology, pipeline state machine, and step-prompt composition).

The source of truth is the code itself — start at:

- `engine/blueprint-engine.js` — the state-machine runner
- `blueprints/pipeline.js` — the default pipeline graph
- `steps/composer.js` — how step prompts are assembled
- `task-schema.json` — the canonical task shape

## Quickstart

```bash
# 1. Install
npm install

# 2. Copy and edit the config
cp config/devnerds.config.example.json config/devnerds.config.json
$EDITOR config/devnerds.config.json   # set repo paths, test commands

# 3. Set required env vars
export ANTHROPIC_API_KEY=sk-ant-...
export DEVNERDS_BOT_EMAIL=devnerds-bot@yourdomain.com   # optional
export DEVNERDS_ALERT_FROM=alerts@yourdomain.com         # optional (SES)
export DEVNERDS_ALERT_TO=you@yourdomain.com              # optional (SES)

# 4. Run a single task
npm run run-task -- path/to/task.json
```

See `aws/README.md` for the optional CDK stack (DynamoDB + S3 + Cognito +
Lambda + API Gateway) that hosts the task store and HTTP API.

## Configuration

`config/devnerds.config.example.json` documents the full config shape. The
key field is `projects`, a map of repo name → `{ repo_path, env_type,
test_commands, domains }`. Any number of repos is supported; the planner
slices tasks across them.

## License

MIT — see [LICENSE](LICENSE).
