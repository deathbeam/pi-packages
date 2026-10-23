# [@deathbeam/pi-images](https://www.npmjs.com/package/@deathbeam/pi-images)

Describe images for vision-less models and generate images with the `image_generate` tool.

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

- `vision` is the model used to describe images. Only used when model does not have vision and when configured
- `generate` is the model used to generate images. Only used when configured.
- `outputDir` is the directory where generated images are saved. Defaults to `.pi/images`.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
