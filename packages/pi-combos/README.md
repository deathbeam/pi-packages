# [@deathbeam/pi-combos](https://www.npmjs.com/package/@deathbeam/pi-combos)

Combine models from different providers into one `combo/<name>` model that falls back to the next model when one fails.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-combos              # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Configuration

Optional `combos` settings live in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "combos": {
        "smart": ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]
    }
}
```

- Each key is a combo name, selectable as `combo/<name>`. Project combos override global ones with the same name, and count only in a trusted project.
- Each value is a list of `provider/model-id` strings, tried in order. A model that fails before producing output falls back to the next one and moves to the end of the list for 1 minute, doubling on each failure in a row up to 30 minutes.
- The combo uses the smallest context window and output limit of its models.
- A resumed session comes back on the combo it selected, not on the member that answered last.

## Development

From the repo root:

```sh
npm install
npm test -- packages/pi-combos
pi install ./packages/pi-combos
```
