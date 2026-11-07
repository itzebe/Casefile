# CASEFILE — Visual Design Contract

CASEFILE is a working document bench, not a chat toy. AgentKit owns the
conversation primitives; the product owns the case workspace around them.

## Product mode

- Mode: `operate`
- Audience and cadence: a person working one dispute at a time, returning over
  days to read, annotate, and confirm.
- Primary workflow: add evidence, read what it establishes, review what
  conflicts, see what is still unknown, and confirm — or refuse to confirm —
  each proposed fact.

## Visual direction

- Direction name: **Quiet evidence ledger.**
- Palette family: neutral ink on plain surfaces; one semantic accent for state.
  Status colour is reserved for meaning (confirmed, contradictory, unread),
  never decoration.
- Type treatment: dense sans-serif labels; document text is the largest thing
  on the page because it is what the reader came for.
- Composition: the document is the centre. Controls sit in a persistent left
  rail; the graph, findings, gaps, notes, and activity stack beside or below it.
- Shape language: bordered cards, dashed borders for what is *not yet*
  established, quiet corners, restrained controls.

## The design constitution

These rules are not style preferences; they are what the product is.

1. **The document is the source of truth.** Every statement the app makes
   resolves to the passage it came from, and the passage is one click away.
2. **Proposed and confirmed look different.** A proposal is never rendered with
   the visual weight of a confirmed fact.
3. **Unknown is a first-class state.** A gap has its own look — dashed, quiet,
   with what would help — and is never filled with a plausible guess.
4. **The agent proposes; the person decides.** No control lets the agent
   confirm on a person's behalf, and no wording implies it did.
5. **Honest failure beats silent emptiness.** An unreadable file, an unavailable
   OCR engine, and a refused action each say so, in place.
6. **No placeholder destinations.** If a control is shown, it works. A screen
   the app does not implement is not linked.

## Anti-references

- A chat bubble where a document should be.
- A confidence percentage standing in for a citation.
- A green "verified" badge on anything the user did not verify.
- Marketing hero copy on a working surface.
- A dead control, or a link to a screen that does not exist.

## Evidence of the contract

- `tests/ui-contract.test.ts` asserts the workspace renders the states above.
- `tests/security-authz.test.ts` asserts that a case the caller does not own is
  refused at the action boundary, and that no action reaches another owner's row.
- The e2e journeys assert that a confirmed link persists and is audited without
  altering the source document (`e2e/journeys.e2e.ts`, Journey C).
