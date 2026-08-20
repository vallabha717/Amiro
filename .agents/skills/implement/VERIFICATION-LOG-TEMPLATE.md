# Verification Log — Phase NN (<Title>)

**Date:** YYYY-MM-DD
**Run ID:** <the amirotest run id, if the harness was used>
**Machine notes:** <anything environment-specific that affects reproduction —
a missing toolchain, no postgres, no keyring daemon>

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: <quoted verbatim from the phase doc>

```
$ <the exact command>
<the exact output, pasted>
```

**Verdict:** ✅ MET — <the one line tying the output to the criterion>.

---

## Criterion 2: <quoted verbatim>

```
$ <command>
<output>
```

**Verdict:** ⚠️ PARTIAL — <what the output does and does not prove, and what
would close the gap>.

---

## Criterion 3: <quoted verbatim>

```
$ <command>
<output>
```

**Verdict:** ❌ NOT MET — <why; where it is tracked>.

---

## New test coverage actually runs

The addresses this phase added, proven to be discovered and executed — a
new suite that silently matched nothing reads as a green run.

```
$ go run ./cmd/amirotest list --surface <s>
<output showing the new addresses>

$ go run ./cmd/amirotest run --surface <s> --feature <f>
<output — the pass count, which must have gone up by the number added>
```

---

## Guards

```
$ go test ./suites/meta/... -v
<output — route coverage, boundaries, sleeps, hardcoded waits, secret leak>
```

---

## Regression check

Everything that had to keep working, and the proof it does.

```
$ pnpm check
<output>

$ cd backend-go && go build ./... && go vet ./... && go test ./...
<output>

$ cd tests && go run ./cmd/amirotest run
<output — including the skip count, with every skip reasoned>
```

---

## Notes

Anything found while verifying that is not a criterion: a flake and its
frequency, a latent bug, a surprising number worth a baseline. These become
the follow-ups in the phase record.
