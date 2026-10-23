# [@deathbeam/pi-archive](https://www.npmjs.com/package/@deathbeam/pi-archive)

Search past Pi sessions with `search_archive` and show recent session titles.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-archive             # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Configuration

Optional `archive` settings live in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "archive": {
        "compaction": "anthropic/claude-haiku-4-5:low"
    }
}
```

- `compaction` is a `provider/model-id` string with an optional `:<thinking>` suffix. When set, its used as compaction model.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
