---
name: leanrig-delegate
description: Route work to cheap subagents — explorer for search, worker for implementation, reviewer for pre-finalize review — to keep the premium main model focused on judgment.
---

## Delegation policy

The main session (premium model) handles **judgment, synthesis, and coordination**. Routine work goes to cheaper subagents. Default question: "why am I doing this myself?"

### Route to leanrig-explorer

Use for any read-only discovery task:
- Broad `grep -r` / `glob` searches across the repo.
- Reading and summarizing large files or log outputs.
- Answering "where is X defined / used?" questions.
- Any task whose output is just a structured summary of existing content.

**Do not** use explorer for tasks that require understanding the full problem context or making judgment calls.

### Route to leanrig-worker

Use for bounded implementation tasks:
- A feature, fix, or refactor that fits in a self-contained brief.
- Test writing for a specific module.
- Any task with clear scope, exclusions, and verifiable acceptance criteria.

Write a brief with: objective / scope (files) / exclusions / acceptance / constraints. Worker returns changed files + verification evidence.

### Route to leanrig-reviewer

Use before finalizing any non-trivial diff:
- After worker completes, before merging or presenting the result.
- For independent verification of logic, invariants, and error handling.
- Reviewer is read-only; it returns verdict + evidence, not edits.

### Keep in main session

- Decisions that require full conversation context.
- Tasks where writing the brief costs as much as doing the work.
- Tight back-and-forth with the user.
- Synthesizing results from multiple subagents into a final answer.

## Practical usage

Invoke a subagent by naming it and providing a brief:
- "leanrig-explorer: find all callers of `runInstall` and return file:line refs."
- "leanrig-worker: [brief with objective/scope/acceptance]."
- "leanrig-reviewer: review the diff in [files] against [criteria]."

Treat subagent output as trusted but unverified — check acceptance criteria yourself before finalizing.
