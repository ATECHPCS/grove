# MISTAKES

Repo-specific, code-level traps. Newest at top. Format: what went wrong → why → how to avoid.

## `git commit` times out under a 2–5 min tool limit
- **What**: `git commit` was killed twice (exit 143) mid pre-commit hook.
- **Why**: `.githooks/pre-commit` runs `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test` (539 tests) + grove-web eslint. From a cold/`fmt`-touched cache that's a 3–5+ min rebuild — longer than the command timeout. `cargo fmt --all` right before committing re-touches files and forces the clippy/test rebuild.
- **Avoid**: warm the caches first — run `cargo clippy -- -D warnings` and `cargo test` to completion, THEN `git commit` (the hook re-runs them from a warm cache in ~50–90 s). Run `cargo fmt --all` before the warm-up, not between it and the commit.

## Frontend lives under `grove-web/src`, not `src`
- **What**: an Edit to `src/components/Tasks/TaskView/sessionActivity.ts` failed — file not found.
- **Why**: `src/` is the Rust crate; the React app is `grove-web/src/`. CLAUDE.md's tree shows both but it's easy to drop the `grove-web/` prefix.
- **Avoid**: frontend paths always start `grove-web/src/…`.

## The `../../../api` barrel uses named re-exports, not `export *`
- **What**: adding `getActiveChats` to `api/tasks.ts` didn't make it importable from the `../../../api` barrel.
- **Why**: `grove-web/src/api/index.ts` re-exports each symbol by name (`export { getChatHistory, … } from './tasks'`), so a new export must be added to that list too.
- **Avoid**: when adding an api function consumed via the barrel, add it in BOTH `api/tasks.ts` and the named list in `api/index.ts`.
