# [@deathbeam/pi-usage](https://www.npmjs.com/package/@deathbeam/pi-usage)

Use the `/usage` command for a fullscreen dashboard of token usage and costs.

## Keys

| Key                 | Action                                                        |
| ------------------- | ------------------------------------------------------------- |
| Tab, Shift+Tab      | Cycle periods                                                 |
| ← / →               | Cycle periods, or step the last filter if it is a time bucket |
| `v`                 | Cycle provider, model, project, day, week, and month groups   |
| Enter               | Open the selected row                                         |
| Esc                 | Go back, or close when at the top level                       |
| `q`                 | Close                                                         |
| ↑ / ↓, `j` / `k`    | Move the cursor                                               |
| Page Up / Page Down | Move by a page                                                |
| `g` / `G`           | Move to the first / last row                                  |

Switching periods removes time filters and keeps provider, model, and project filters. The sparkline shows daily costs for the selected row.

Weeks start on Monday in local time. Time rows include days without usage. `/day` uses the days in the visible window, including today. Δ compares that pace with the next older row. A rise from zero is shown as `▲new`.

The summary compares the current window with the same number of calendar days immediately before it. All has no comparison unless a time bucket is open.

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
