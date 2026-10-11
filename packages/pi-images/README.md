# [@deathbeam/pi-images](https://www.npmjs.com/package/@deathbeam/pi-images)

Describe images for vision-less models and generate images with the `image_generate` tool.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-images              # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Usage

**Vision handoff** runs automatically: when the current model cannot see images and `images.vision`
is set, every image in the conversation (`read` results, pasted attachments) is described by the vision
model and replaced with a `[Image description: ...]` text block. Descriptions are cached per image for the process
lifetime, so each image is described once until pi is restarted.

**Image generation** is the `image_generate` tool: generate images from a prompt, or edit input image
files from the working directory. Generated images are returned as attachments and saved to
`images.outputDir` (default `.pi/images`).

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

`vision` and `generate` are `provider/model-id` strings (the model id is free-form and may contain
slashes). Either feature is off while its key is unset: without `vision` images pass through as Pi
sends them, and `image_generate` fails with instructions. The provider must be known to Pi (it must
have at least one registered model and a configured API key). The image request then goes to the provider's
registered `baseUrl`/`api` when it has one, or to its first registered model's, and is shaped accordingly
(OpenAI-compatible `/images/generations`, Google `generateContent`, or OpenRouter chat completions).

Project settings override global ones.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
