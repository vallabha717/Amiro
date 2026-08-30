package permission

import (
	"testing"
	"time"
)

func TestSession_LockExcludesConcurrentRLock(t *testing.T) {
	store := NewStore()
	sess := store.For("thread-1")

	sess.Lock() // simulates a restore in progress

	rlocked := make(chan struct{})
	go func() {
		sess.RLock() // simulates a turn trying to start
		close(rlocked)
		sess.RUnlock()
	}()

	select {
	case <-rlocked:
		t.Fatal("RLock acquired while Lock was held -- a turn's write raced a restore")
	case <-time.After(50 * time.Millisecond):
		// expected: RLock is blocked while the exclusive lock is held
	}

	sess.Unlock()

	select {
	case <-rlocked:
	case <-time.After(time.Second):
		t.Fatal("RLock never acquired after Unlock")
	}
}

func TestSession_RLockAllowsConcurrentRLock(t *testing.T) {
	store := NewStore()
	sess := store.For("thread-1")

	sess.RLock()
	defer sess.RUnlock()

	done := make(chan struct{})
	go func() {
		sess.RLock() // two turns against the same thread may overlap
		close(done)
		sess.RUnlock()
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("a second RLock could not be acquired alongside the first -- turns should be able to overlap")
	}
}

func TestSession_NilLockMethodsAreNoOps(t *testing.T) {
	var sess *Session
	// Must not panic -- the "optional dependency degrades rather than
	// panics" contract every other method on Session already has.
	sess.RLock()
	sess.RUnlock()
	sess.Lock()
	sess.Unlock()
}
