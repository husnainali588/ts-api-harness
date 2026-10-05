# QUESTIONS.md — decisions made without asking (AUTORUN §3)

One line each: question → choice.

- `docs/BUILD_PROMPTS.md` was deleted in the working tree when AUTORUN started, but AUTORUN depends on it → restored it unchanged from `HEAD` (no content lost).
- Phase 1 asks for `.env.example` "with empty values", but reading `.env.example` was blocked by the session's permission classifier → left the provided file untouched and unread; the pre-commit secret-pattern scan of the first commit found no key formats in it. **Please confirm its values are empty.**
- YAML task files could not be parse-checked in Phase 0b (no `yaml` package yet) → covered by the Phase 1 task-loader tests instead.
