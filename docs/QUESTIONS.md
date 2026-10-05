# QUESTIONS.md — decisions made without asking (AUTORUN §3)

One line each: question → choice.

- `docs/BUILD_PROMPTS.md` was deleted in the working tree when AUTORUN started, but AUTORUN depends on it → restored it unchanged from `HEAD` (no content lost).
- Phase 1 asks for `.env.example` "with empty values", but reading `.env.example` was blocked by the session's permission classifier → left the provided file untouched and unread; the pre-commit secret-pattern scan of the first commit found no key formats in it. **Please confirm its values are empty.**
- Core size: CLAUDE.md targets < 1,500 lines; after Phase 2 it is 1,685 incl. comments and the public type declarations in `core/sdk.ts` → kept the types (they are the plugin contract) and will report the final count instead of compressing readable code.
- Record (exit 1) notes from post-hooks → logged to events.jsonl only, not appended to the model's tool result (saves tokens; the model needs blocks, not records).
- YAML task files could not be parse-checked in Phase 0b (no `yaml` package yet) → covered by the Phase 1 task-loader tests instead.
