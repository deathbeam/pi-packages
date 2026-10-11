# [@deathbeam/pi-delegate](https://www.npmjs.com/package/@deathbeam/pi-delegate)

Run subagents with `delegate`, `delegate_list`, `delegate_steer`, and `delegate_cancel`.
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

Relative `agentDirs` resolve against the project cwd, later same-name definitions win. Project `models` override global
tiers (`cheap`, `balanced`, `strong`); a tier is a `provider/model` string with an optional `:<thinking>` suffix, as in
pi's `--model`. An unset tier makes the child use the current session model. Thinking resolves from the agent's
`model` suffix first, then the tier suffix, then the session level.

Agents are Markdown files with frontmatter, the body becomes the child's system prompt:

```markdown
---
name: scout
description: Explore the codebase
tools: read, grep
model: cheap
---

Explore the codebase and report relevant paths.
```

Omit `tools` to inherit active tools. `model` can also be an explicit `provider/model[:thinking]`. The model sees the agent list from
when the extension loaded, so run `/reload` after adding agents or changing their descriptions.

The main session is prompted to act as an orchestrator. When it makes 5, 10, 20, … direct exploration calls (`read`,
`grep`, `find`, `ls`, shell, web tools) without delegating, a hidden reminder nudges it to delegate the rest. The count
resets on each prompt and each `delegate` call.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
