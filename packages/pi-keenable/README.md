# [@deathbeam/pi-keenable](https://www.npmjs.com/package/@deathbeam/pi-keenable)

Add Keenable-backed `web_search` and `web_fetch` tools. Set `KEENABLE_API_KEY` for private access.
Without a key, requests use Keenable's rate-limited `/public` endpoints. Requests time out after 60s.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-keenable            # this package
pi install git:github.com/deathbeam/pi-packages  # all four packages
```

## Development

From this package directory:

```sh
npm install
npm test
pi install .
```
