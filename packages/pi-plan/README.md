# [@deathbeam/pi-plan](https://www.npmjs.com/package/@deathbeam/pi-plan)

Structured plans: a `plan` tool, a progress widget, and a `/plan` picker over every plan in the project.
Each task carries its own `doneWhen` check, and `plan get <id>` returns one task with the plan's goal and context.
The bundled `prepare-plan` skill writes a plan, and `import-plan` migrates existing plan documents (`.plans/*.md`, Cursor, Kiro, Taskmaster).

Plans live in `.pi/plans/<name>.json` at the repository root. Add `.pi/plans/` to `.gitignore` if the first `plan create` cannot write it to `.git/info/exclude`.

## Installation

```sh
# Choose one:
pi install npm:@deathbeam/pi-plan                # this package
pi install git:github.com/deathbeam/pi-packages  # all my packages
```

## Development

From the repo root:

```sh
npm install
npm test -- packages/pi-plan
pi install ./packages/pi-plan
```
