---
name: prepare-plan
description: Turn a request into a plan of independently verifiable tasks with the plan tool; use before implementing multi-step work.
---

# Prepare plan

Write the plan with the `plan` tool, action `create`. The plan is the source of truth: each task is worked from it and updated when its check passes.

## Process

1. **Orient.** Gather the request, repo instructions, the code the change touches, its callers, its tests, and prior patterns. Stop when you can name the behaviour to change, the seam it goes through, and the check that proves it. If the plan exists, report it and continue with `update`; use a new name only for new work.

2. **Resolve decisions.** Find facts in the code and docs rather than asking. Ask the user only for a decision that changes the plan. Record an assumption in `context` instead of leaving a task that a later reader cannot execute. Settle a blocking choice before the plan exists.

3. **Write the tasks.** Prefer existing code and the smallest change that meets the goal. Split the work into tasks that are independently verifiable and leave the repo working. For a feature, slice by behaviour rather than by layer: "create with status and notes", not "add schema", then "add handler". For a wide mechanical refactor, plan expand, migrate, contract.

    Each task is executed from `get <id>` alone: the goal, the context and that one task. Write it for a reader who never saw this conversation: exact paths, the interfaces it must match, and its check. Add `blockedBy` only for a real dependency; tasks without one can run at the same time, so keep their `where` files disjoint.

4. **Self-check.** Trace every requirement in the request to a task, and every task to a concrete `doneWhen`. Replace each "handle edge cases" or "write tests" with the behaviour and the check. Confirm that no task names a path or interface that a later task defines differently. Read each task as `get <id>` will show it and confirm it can be done and checked without this conversation.

5. **Create the plan.** One `plan create` call. Task ids follow list order, so write `blockedBy` with those ids.

## Writing doneWhen

A good check names the result, the command, and the expected output:

- `npm test -- packages/x: 42 passed`
- `curl localhost:8080/health returns 200 with {"ok":true}`
- `open the settings page and press Save: the toast reads Saved`

For manual or visual work, describe the observation and how to reproduce it. When no check exists yet, write the one to run: `unverified: confirm X with Y`.

## Hand off

Report the plan name, the task count, and any decision still open. Planning ends here: start the tasks when the user asks for it.
