# [@deathbeam/pi-usage](https://www.npmjs.com/package/@deathbeam/pi-usage)

Use the `/usage` command for a fullscreen dashboard of token usage and cost: a summary block (total
cost, requests, sessions, input/output/cache tokens, cache hit ratio, daily cost sparkline) and a
table you can group by provider (with models nested), model, or project (session cwd).

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-usage               # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```

## Keys

- `q` / `esc` — close
- `tab` / `←→` — cycle period (Today, 7d, 30d, All)
- `v` — cycle grouping (Provider, Model, Project)
- `↑↓` / `j k` — move the cursor
- `pgup` / `pgdn` — page the table
- `home` / `g`, `end` / `G` — jump to the top / bottom
