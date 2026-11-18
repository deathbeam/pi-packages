# [@deathbeam/pi-context](https://www.npmjs.com/package/@deathbeam/pi-context)

Keep context small: rewrite bash commands through [RTK](https://github.com/rtk-ai/rtk) when `rtk` is in `PATH`, prune stale tool results (superseded reads/edits, failed file calls, re-run bash commands), and set the compaction model.
Use `/gain` command to see how many tokens were saved.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-context             # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Configuration

Optional `context` settings live in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "context": {
        "compaction": "anthropic/claude-haiku-4-5:low"
    }
}
```

- `compaction` is a `provider/model-id` string with an optional `:<thinking>` suffix. When set, it is used as the compaction model. Project settings override global ones.

## Development

From the repo root:

```sh
npm install
npm test -- packages/pi-context
pi install ./packages/pi-context
```
