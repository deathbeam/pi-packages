# [@deathbeam/pi-rtk](https://www.npmjs.com/package/@deathbeam/pi-rtk)

Rewrite bash commands to [RTK](https://github.com/rtk-ai/rtk) (`rtk ...`) so tool output costs fewer tokens.

This is the RTK Pi hook packaged for the `packages` setting, so it replaces `rtk init -g --agent pi`, which
drops a loose file into `~/.pi/agent/extensions`. The decision logic stays in `rtk rewrite`; this package only
delegates to it. Adapted from [rtk-ai/rtk `hooks/pi/rtk.ts`](https://github.com/rtk-ai/rtk/blob/develop/hooks/pi/rtk.ts)
(Apache-2.0).

## Installation

`rtk` must be in `PATH`.

```sh
# Choose one:
pi install npm:@deathbeam/pi-rtk             # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

Or add it to `packages` in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
    "packages": ["npm:@deathbeam/pi-rtk"]
}
```

## Usage

Every bash command is passed to `rtk rewrite` before it runs. A rewrite replaces the command; no rewrite or a
missing `rtk` leaves it untouched.

`/rtk` shows the `rtk gain` report.

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
