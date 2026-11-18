# [@deathbeam/pi-hashline](https://www.npmjs.com/package/@deathbeam/pi-hashline)

Replace pi's `read`, `edit`, and `grep` tools with hash-anchored versions that address lines as `LINE#HASH`.
`grep` needs `rg` in `PATH`; without it, the built-in grep stays.

Fork of [pi-hashline-edit](https://www.npmjs.com/package/pi-hashline-edit) with bug fixes and native tool output.
See [the blog post](https://stencil.so/blog/the-harness-problem) for why it exists.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-hashline            # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Development

From the repo root:

```sh
npm install
npm test -- packages/pi-hashline
pi install ./packages/pi-hashline
```
