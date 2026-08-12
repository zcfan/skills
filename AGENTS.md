# Repository instructions

## Write for the present state

- Write README content, Skill instructions, metadata, comments, and examples for a reader who knows only the current repository.
- Describe the current purpose, behavior, interfaces, requirements, and constraints directly.
- Do not narrate repository evolution, discarded implementations, previous layouts, refactors, bug-fix history, or conversation context.
- Do not justify the current design by contrasting it with an earlier or hypothetical design. Prefer a positive statement of the current contract.
- Use negative constraints only when they prevent a realistic safety or correctness failure in the current workflow.
- Document data migration or backward compatibility only when it is an active user-facing feature. Name the data being migrated and the action users or agents must take so the section is self-contained.
- Keep English and Chinese documentation aligned in meaning.

## Test stable contracts

- Test executable behavior and machine-readable structure, not prose wording.
- Do not add tests that read Markdown merely to assert that a sentence or phrase exists.
