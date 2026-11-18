# [@deathbeam/pi-images](https://www.npmjs.com/package/@deathbeam/pi-images)

Describe images for models that cannot see them and generate images with the `image_generate` tool.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-images              # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Configuration

Optional `images` settings live in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "images": {
        "vision": "anthropic/claude-haiku-4-5",
        "generate": "inferhub/cb/gemini-3.0-pro-image",
        "outputDir": ".pi/images"
    }
}
```

- `vision` is the `provider/model-id` used to describe images when the current model cannot see them. Images stay undescribed when unset.
- `generate` is the `provider/model-id` used by `image_generate`. The tool fails when unset.
- `outputDir` is where generated images are saved. Defaults to `.pi/images`.

## Development

From the repo root:

```sh
npm install
npm test -- packages/pi-images
pi install ./packages/pi-images
```
