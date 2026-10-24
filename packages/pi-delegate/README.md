# [@deathbeam/pi-delegate](https://www.npmjs.com/package/@deathbeam/pi-delegate)

Run subagents with `delegate`, `delegate_list`, `delegate_steer`, `delegate_cancel`, `delegate_apply`, and
`delegate_discard`.
Use `/delegate` command to inspect jobs in a full-screen TUI.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-delegate            # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Configuration

Optional `delegate` settings live in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "delegate": {
        "agentDirs": ["./.pi/agents"],
        "models": {
            "cheap": "anthropic/claude-haiku-5-5:low",
            "balanced": "anthropic/claude-sonnet-5-5:high",
            "strong": "anthropic/claude-opus-5-5:high"
        }
    }
}
```

Agents are Markdown files with frontmatter, the body becomes the child's system prompt:

```markdown
---
name: scout
description: Explore the codebase
tools: read, grep
model: cheap
isolated: false
---

Explore the codebase and report relevant paths.
```

- `name` is required and must be unique
- `descripion` is required
- `tools` is optional, a comma-separated list of tool names. Defaults to the session tools.
- `model` is optional, a tier name or `provider/model[:thinking]`. Defaults to the session model.
- `isolated` is optional, defaults to `false`. See [Isolation](#isolation).

## Isolation

`isolated: true` (on a `delegate` call or in agent frontmatter) runs the delegate in its own git clone at
`.pi/worktrees/<id>`, starting from your current working tree including uncommitted changes.

`delegate_apply` merges the result into your working tree as uncommitted changes.
`delegate_discard` discards the clone and its changes.

Any later delegate can share that clone with `clone: <job id>`, for review, tests, or follow-up work.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
