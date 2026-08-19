# basic workspace fixture

The default sandbox for the agent's file tools. Every test gets a **copy**
of this directory at `<runDir>/backend/<test-id>/workspace/`, pointed at by
`AMIRO_WORKSPACE_ROOT`.

Deliberately small and deliberately boring: it exists so file-tool tests
have something real to read, write, glob and grep, not to be interesting.
Anything a test needs that is *specific* to that test should be written by
the test into its own copy.

Richer fixtures (`go-project/`, `ts-project/`, `large/`, `unicode/`) arrive
with the suites that need them — see
`docs/testing/reference/tests-tree.md`.
