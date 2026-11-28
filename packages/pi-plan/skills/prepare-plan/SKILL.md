---
name: prepare-plan
description: Turn a request into a plan of independently verifiable tasks with the plan tool; use before implementing multi-step work.
---

# Prepare plan

Write the plan with the `plan` tool, action `create`. The plan is the source of truth: each task is worked from `get <task>` and updated when its goal's check passes.

## Process

1. **Orient.** Read the code the change touches, its callers, its tests and the repo instructions. Every fact, `path:line` and command in the plan comes from code you or a helper read, not from memory. Stop when you can name the behaviour to change, the seam it goes through, and the check that proves it.

2. **Gather facts before writing.** When others explore for you, ask each for a report with `path:line` evidence: current behaviour, seams, callers, tests and checks. Write the plan from those reports and the user's decisions. A plan written from conversation memory cites nothing and leaves every task to guesswork.

3. **Resolve decisions.** Find facts in the code and docs rather than asking. Ask the user only for a decision that changes the plan. Settle a blocking choice before the plan exists and record it in the plan `detail`.

4. **Write the plan detail.** Plan `detail` is markdown in sections (headings inside it use `####` or lower, below the fixed `##`):

    - Current behaviour, with `path:line` for each site.
    - The problem: why that code is wrong today.
    - The chosen design, and the alternatives rejected, with the reason.
    - Accepted behaviour changes.
    - Out of scope.
    - Open questions.

5. **Write the tasks.** Prefer existing code and the smallest change that meets the goal. Split the work into tasks that are independently verifiable and leave the repo working. For a feature, slice by behaviour rather than by layer: "create with status and notes", not "add schema", then "add handler". For a wide mechanical refactor, plan expand, migrate, contract.

    Each task is executed from `get <task>` alone: the plan's goal and detail, and that one task. Write it for a reader who never saw this conversation.

    - `title`: the deliverable or behaviour, one line.
    - `goal`: the observable result and the command that proves it.
    - `detail`: the approach, the interfaces it must match, the pitfalls, and a `Where:` line citing `path:line` for each file that changes. Headings inside it use `####` or lower, below the fixed `###`.

    Add `dependsOn` only for a real dependency; tasks without one run at the same time, so keep their files disjoint.

6. **Self-check.** Trace every requirement in the request to a task, and every task to a goal with a check. Replace each "handle edge cases" or "write tests" with the behaviour and the check. Confirm that no task names a path or interface that a later task defines differently. Read each task as `get <task>` will show it and confirm it can be done and checked without this conversation.

7. **Create the plan.** One `plan create` call. Set `title` to three to eight words naming the outcome. Task ids follow list order (`t1..tn`), so write `dependsOn` with those ids.

## Writing a goal

The plan `goal` and a task `goal` mean the same thing: the observable outcome plus the check that proves it, for example:

- `npm test -- packages/x: 42 passed`
- `curl localhost:8080/health returns 200 with {"ok":true}`
- `open the settings page and press Save: the toast reads Saved`

The plan goal is the final verification of the whole plan. Mark a task `done` only after its goal's check passed.

For manual or visual work, describe the observation and how to reproduce it. When no check exists yet, write the one to run: `unverified: confirm X with Y`.

## Hand off

Report the plan id, the task count and any decision still open. Planning ends here: start the tasks when the user asks for it.
