# Brief 0001 — throwaway rehearsal feature

**Phase:** D0.5 · **Gate:** R0 · **Disposable:** yes, deleted after the rehearsal

The point is not the feature. The point is to run one change through the whole pipeline —
owner → worker → Reviewer A → Verifier → gate log — and find out where the process breaks
while the cost of finding out is minutes, not a day.

## Feature

A word count, end to end. Deliberately trivial and deliberately cross-layer.

New channel `scratch.wordCount`:

- **request** `{ text: string }`
- **response** `{ words: number, characters: number }`

Words are runs of non-whitespace. `characters` is `text.length`.

## Required touches (this is the rehearsal, so all of them)

1. `src/shared/channels.ts` — add the channel name; bump `PROTOCOL_VERSION` to 2.
2. `src/shared/ipc-contract.ts` — request/response schemas (`satisfies` must still compile).
3. `src/main/**` — a handler that parses the request and returns the count.
4. `src/renderer/**` — a textarea and a button that calls it and shows the result, including a
   distinct error state.
5. `tests/unit/**` — the counting function: empty string, single word, extra whitespace,
   unicode, very long input.
6. `tests/e2e/**` — the packaged/dev app: type text, click, see the count.

## Acceptance (Verifier runs these, not the author)

- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` · `npx playwright test` all clean
- [ ] Protocol version bumped and both sides updated in the same change
- [ ] Bad payload returns `BAD_REQUEST`, not a crash or a silent zero
- [ ] UI shows a distinct error state, not an empty result
- [ ] No `any`, no `@ts-expect-error`, no non-null assertion

## Do not

- Do not add a dependency.
- Do not touch unrelated files.
- Do not weaken a check to make it pass.
- Do not spend more than needed on styling — this code is deleted afterwards.

## After the gate

Record in the gate log: what the pipeline caught, what it missed, how long each step took,
and whether any rule was ambiguous. Then delete the feature in one revert PR.
