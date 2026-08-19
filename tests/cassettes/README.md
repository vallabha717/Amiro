# cassettes

Committed provider recordings, replayed by default so the suite runs with no
network and no API keys.

Empty until **Phase 3**, which builds `harness/cassette` (the record/replay
proxy) and the provider suites that populate this directory. Layout when it
arrives:

```
cassettes/<surface>/<feature>/<scenario>.yaml
```

The directory exists now so `providers.mode: replay` — the default — does not
warn about a missing path on a fresh checkout.

See [docs/testing/05-recording-and-replay.md](../../docs/testing/05-recording-and-replay.md).
