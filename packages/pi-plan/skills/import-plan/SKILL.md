---
name: import-plan
description: Migrate existing plan documents into plan state; use when asked to migrate, import or convert plans, or when work starts from .plans, Cursor, Kiro or Taskmaster plans.
---

# Import plan

Move existing plan documents into the `plan` tool: one `plan create` call per document.

Migrate every plan you find in the project. When the request names specific files or plans, convert only those.

## Process

1. **Find the sources.** Look for the known locations:

    - `.plans/*.md` — `## Goal`, `## Context`, `## Notes`, and `- [ ]` tasks with `Where:`, `Blocked by:` and `Done when:` sub-bullets.
    - `.cursor/plans/*.plan.md` — YAML frontmatter with a `todos` list of `id`, `content` and `status`.
    - `.kiro/specs/*/tasks.md` — numbered checkbox tasks, each with a `_Requirements:_` reference.
    - `.taskmaster/tasks/tasks.json` — `id`, `title`, `details`, `testStrategy`, `dependencies`, `status` and `subtasks` per task.
    - `docs/plans/*.md` — plan-like markdown, including plan-mode `Plan:` numbered lists and superpowers-style `### Task N:` sections.

2. **Read a source whole.** Read every task list, checkbox, status field, note and log line before mapping. The mapping below covers the common formats; a format you have not seen gets mapped by the same rules.

3. **Skip a taken id.** If `.pi/plans/<id>.json` already exists, report the skip and convert the next source.

4. **Create one plan per source.** Use the mapping rules, then call `plan create`.

5. **Report.** End with one table: source file, new plan id, tasks by status, and what you skipped or guessed. Tell the user they can remove the source files once the plan reads correctly. Never edit or delete a source yourself.

## Mapping rules

Map each field by what it says; its position in the file does not decide.

- **Plan id.** The file name without its extension, in kebab-case; the plan title when the file name says nothing.
- **title.** The plan's title or goal in three to eight words.
- **goal.** The plan's goal, summary or objective, as one observable outcome plus the check that proves it.
- **detail.** The plan's context, decisions, constraints, design notes and open questions, in sections. Condense it, but keep every decision and every path.
- **notes.** A top-level Notes, log or rulings section becomes plan notes. Create the plan first, then append each note with `update` and a `note` but no `task`.
- **Tasks.** Each top-level actionable item becomes one task.
    - `title`: the item's text.
    - `goal`: its verification, acceptance or test step, with the command when the source names it.
    - `detail`: the item's body, sub-bullets and interfaces, with a `Where:` line citing `path:line` for each path it mentions.
    - `dependsOn`: only the dependencies the source states, mapped to the new ids. List order alone is no dependency.
- **Status.** A checked or completed item is `done`. An in-progress item, or the next open one the source marks as current, is `doing`. Everything else is `todo`. Take every status from the source.
- **Task notes.** Execution notes and log lines go to the notes of the task they belong to.

Fold a nested sub-step into its parent task's `detail` or notes. When a sub-step is independently verifiable, it becomes its own task with `dependsOn` on the parent.

When an item has no verification step, set its `goal` to `unverified: <what to check>`.

Task ids follow list order (`t1..tn`); translate stated dependencies after you order the tasks. `update` changes only status and notes, so check titles, goals, details and `dependsOn` before the `create` call.
