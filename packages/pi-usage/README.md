# [@deathbeam/pi-usage](https://www.npmjs.com/package/@deathbeam/pi-usage)

Use the `/usage` command for a fullscreen dashboard of token usage and costs.

## Keys

| Key                   | Action                                       |
| --------------------- | -------------------------------------------- |
| Tab, Shift+Tab, ← / → | Cycle groups. Inside an open day, skip day.  |
| `[` / `]`             | Step the day when it is the innermost filter |
| Enter                 | Open the selected row                        |
| Esc                   | Go back, or close when at the top level      |
| `q`                   | Close                                        |
| ↑ / ↓, `j` / `k`      | Move the cursor                              |
| Page Up / Page Down   | Move by a page                               |
| `g` / `G`             | Move to the first / last row                 |

Day rows include days without usage. Δ compares cost with the previous day. The sparkline shows the selected row over all history and is hidden when a day is open.

The summary compares the daily spend so far this week and month with last week and month. Weeks start on Monday in local time. `▲new` means the previous period had no spend.

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
