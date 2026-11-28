# [@deathbeam/pi-plan](https://www.npmjs.com/package/@deathbeam/pi-plan)

Structured plans: a `plan` tool, a progress widget, and a `/plan` inspector over every plan in the project.
The bundled `prepare-plan` skill writes a plan, and `import-plan` migrates existing plan documents (`.plans/*.md`, Cursor, Kiro, Taskmaster).

Plans live in `.pi/plans/<id>.json` at the repository root. Add `.pi/plans/` to `.gitignore` if the first `plan create` cannot write it to `.git/info/exclude`.

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
