package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestSnapshotStopRestore(t *testing.T) {
	h := newHarness(t)
	const id = "sb-snap"
	h.create(id, sandboxOptions{})
	blob := make([]byte, 2<<20+5)
	rand.Read(blob)
	h.writeFile(id, "/workspace/notes/a.txt", []byte("alpha"))
	h.writeFile(id, "/workspace/b.bin", blob)
	h.sh(id, "ln -s notes/a.txt link; chmod 700 notes; mkfifo pipe")

	var snap snapshotResult
	if status := h.call("POST", "/v1/sandboxes/"+id+"/snapshot", nil, &snap); status != 200 || snap.Bytes == 0 {
		t.Fatalf("snapshot: %d %+v", status, snap)
	}
	object := h.s3.object("/bucket/" + id + ".snap")
	if !bytes.HasPrefix(object, []byte(snapshotMagic)) || int64(len(object)) != snap.Bytes {
		t.Fatalf("object: %d bytes, %q…; answer said %d", len(object), object[:min(8, len(object))], snap.Bytes)
	}
	// The presigned query reaches Object Storage as signed: %2F stays %2F.
	if !slices.ContainsFunc(h.s3.queries, func(q string) bool { return strings.Contains(q, "key%2F20261001%2Fru-central-1") }) {
		t.Fatalf("queries: %q", h.s3.queries)
	}
	h.sh(id, "echo after > notes/later.txt") // still running after a snapshot

	var stopped snapshotResult
	if status := h.call("POST", "/v1/sandboxes/"+id+"/stop", nil, &stopped); status != 200 || stopped.Bytes == 0 {
		t.Fatalf("stop: %d %+v", status, stopped)
	}
	if status := h.call("GET", "/v1/sandboxes/"+id, nil, nil); status != 404 {
		t.Fatalf("GET after stop: %d", status)
	}
	if result := h.exec(id, map[string]any{"command": "true"}); result.status != 409 {
		t.Fatalf("exec after stop: %d", result.status)
	}
	if status := h.call("POST", "/v1/sandboxes/"+id+"/stop", nil, nil); status != 404 {
		t.Fatalf("second stop: %d", status)
	}
	if rec := readState(t, h)[id]; rec.State != stateStopped || rec.Snapshot != nil || rec.StopReason != "requested" {
		t.Fatalf("record after stop: %+v", rec)
	}

	get := h.s3.url("/bucket/" + id + ".snap")
	result := h.create(id, sandboxOptions{get: &get})
	if !result.Created || !result.Restored {
		t.Fatalf("restore: %+v", result)
	}
	for path, want := range map[string]string{
		"/workspace/notes/a.txt":     "alpha",
		"/workspace/notes/later.txt": "after\n",
		"/workspace/b.bin":           string(blob),
	} {
		if status, data := h.readFile(id, path); status != 200 || string(data) != want {
			t.Fatalf("%s after restore: %d, %d bytes", path, status, len(data))
		}
	}
	if out := h.sh(id, "readlink link; stat -c %a notes; test -p pipe && echo fifo || echo no-fifo"); out != "notes/a.txt\n700\nfifo\n" {
		t.Fatalf("after restore: %q", out)
	}
	h.assertNoSecrets("deadbeef", hex.EncodeToString(testKey))
}

func TestRestoreMissingOrBroken(t *testing.T) {
	h := newHarness(t)
	none := h.s3.url("/bucket/none.snap")
	if result := h.create("sb-fresh", sandboxOptions{get: &none}); !result.Created || result.Restored {
		t.Fatalf("no snapshot yet: %+v", result)
	}
	if status := h.writeFile("sb-fresh", "/workspace/x", []byte("x")); status != 204 {
		t.Fatalf("write in the fresh sandbox: %d", status)
	}

	// A snapshot sealed with another key, one cut short, an answer other than 200 or 404.
	var sealed bytes.Buffer
	s, _ := newSealer(&sealed, bytes.Repeat([]byte{9}, 32))
	s.Write([]byte("not a tar under this key"))
	s.Close()
	h.s3.mu.Lock()
	h.s3.objects["/bucket/other-key.snap"] = sealed.Bytes()
	h.s3.objects["/bucket/cut.snap"] = sealed.Bytes()[:sealed.Len()-3]
	h.s3.mu.Unlock()
	for _, path := range []string{"/bucket/other-key.snap", "/bucket/cut.snap", "/bucket/fails.snap"} {
		if path == "/bucket/fails.snap" {
			h.s3.set(0, 500)
		}
		get := h.s3.url(path)
		var failure map[string]string
		if status := h.call("PUT", "/v1/sandboxes/sb-broken", h.sandboxBody("sb-broken", sandboxOptions{get: &get}), &failure); status != 502 ||
			failure["error"] != "restore_failed" {
			t.Fatalf("%s: %d %v", path, status, failure)
		}
		if status := h.call("GET", "/v1/sandboxes/sb-broken", nil, nil); status != 404 {
			t.Fatalf("%s: GET after a failed restore: %d", path, status)
		}
		statuses, _ := h.m.rt.List(context.Background())
		if _, ok := statuses["sb-broken"]; ok {
			t.Fatalf("%s: the container of a failed restore is still there", path)
		}
	}
	h.s3.set(0, 0)
}

func TestStopKeepsRunningWhenUploadFails(t *testing.T) {
	h := newHarness(t)
	h.create("sb-keep", sandboxOptions{})
	h.writeFile("sb-keep", "/workspace/precious", []byte("do not lose"))
	h.s3.set(500, 0)
	var failure map[string]string
	if status := h.call("POST", "/v1/sandboxes/sb-keep/stop", nil, &failure); status != 502 || failure["error"] != "snapshot_failed" {
		t.Fatalf("stop with a failing upload: %d %v", status, failure)
	}
	if status := h.call("POST", "/v1/sandboxes/sb-keep/snapshot", nil, &failure); status != 502 {
		t.Fatalf("snapshot with a failing upload: %d", status)
	}
	if status, data := h.readFile("sb-keep", "/workspace/precious"); status != 200 || string(data) != "do not lose" {
		t.Fatalf("the sandbox did not keep running: %d %q", status, data)
	}
	h.s3.set(0, 0)
	if status := h.call("POST", "/v1/sandboxes/sb-keep/stop", nil, nil); status != 200 {
		t.Fatalf("stop: %d", status)
	}
}

func TestIdleReaper(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	for _, id := range []string{"sb-idle", "sb-busy", "sb-fresh"} {
		h.create(id, sandboxOptions{})
	}
	h.writeFile("sb-idle", "/workspace/kept.txt", []byte("kept"))
	busy, err := h.m.begin("sb-busy") // a request in flight
	if err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(21 * time.Minute)
	h.m.mu.Lock()
	h.m.sandboxes["sb-fresh"].rec.LastUsedAt = future.Add(-time.Minute)
	h.m.mu.Unlock()

	h.s3.set(500, 0)
	h.m.reap(ctx, future)
	if status := h.call("GET", "/v1/sandboxes/sb-idle", nil, nil); status != 200 {
		t.Fatalf("an idle sandbox whose snapshot failed was stopped: %d", status)
	}
	if !strings.Contains(h.logs.String(), "idle sandbox not stopped") {
		t.Fatalf("no log of the failed idle stop:\n%s", h.logs.String())
	}
	// The GET above counts as no use: lastUsedAt moves only with work in the sandbox.
	h.s3.set(0, 0)
	h.m.reap(ctx, future)
	if status := h.call("GET", "/v1/sandboxes/sb-idle", nil, nil); status != 404 {
		t.Fatalf("the idle sandbox is still there: %d", status)
	}
	if len(h.s3.object("/bucket/sb-idle.snap")) == 0 {
		t.Fatal("the idle sandbox was stopped without a snapshot")
	}
	for _, id := range []string{"sb-busy", "sb-fresh"} {
		if status := h.call("GET", "/v1/sandboxes/"+id, nil, nil); status != 200 {
			t.Fatalf("%s was reaped: %d", id, status)
		}
	}
	h.m.end(busy)
	if rec := readState(t, h)["sb-idle"]; rec.State != stateStopped || rec.StopReason != "idle" {
		t.Fatalf("record: %+v", rec)
	}
	// A container that dies on its own is noticed on the next tick.
	h.m.rt.Kill(ctx, "sb-fresh", "KILL")
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		h.m.reap(ctx, time.Now())
		status := h.call("GET", "/v1/sandboxes/sb-fresh", nil, nil)
		if status == 404 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a dead container still counts as running: %d", status)
		}
	}
	h.m.reap(ctx, time.Now().Add(stoppedRecordTTL+time.Hour))
	if _, ok := readState(t, h)["sb-idle"]; ok {
		t.Fatal("an old stopped record was not pruned")
	}
}

// A request that comes while a stop runs waits for it: the stop's snapshot does not miss its work, and
// the teardown does not cut it short. After a stop that went through it finds the sandbox stopped.
func TestStopHoldsNewRequests(t *testing.T) {
	h := newHarness(t)
	h.create("sb-gate", sandboxOptions{})
	sb := h.m.lookup("sb-gate")
	sb.op.Lock() // as the reaper or a stop does
	h.m.mu.Lock()
	sb.stopping = true
	h.m.mu.Unlock()
	began := make(chan error, 1)
	go func() {
		running, err := h.m.begin("sb-gate")
		if err == nil {
			h.m.end(running)
		}
		began <- err
	}()
	select {
	case err := <-began:
		t.Fatalf("a request started during the stop: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	h.m.mu.Lock()
	sb.stopping, sb.rec.State = false, stateStopped
	h.m.mu.Unlock()
	sb.op.Unlock()
	if err := <-began; err == nil || !strings.Contains(err.Error(), "sandbox_stopped") {
		t.Fatalf("after the stop: %v", err)
	}
	h.m.mu.Lock()
	sb.rec.State = stateRunning
	h.m.mu.Unlock()
}

// DELETE of an id sandboxd never knew leaves no entry for good: the reaper forgets absent ones.
func TestAbsentEntriesForgotten(t *testing.T) {
	h := newHarness(t)
	for i := range 20 {
		if status := h.call("DELETE", fmt.Sprintf("/v1/sandboxes/sb-never-%d", i), nil, nil); status != 204 {
			t.Fatalf("DELETE: %d", status)
		}
	}
	h.create("sb-live", sandboxOptions{})
	h.m.reap(context.Background(), time.Now())
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	if len(h.m.sandboxes) != 1 || h.m.sandboxes["sb-live"] == nil {
		t.Fatalf("entries after the reaper: %d", len(h.m.sandboxes))
	}
}

// A state.json write that fails is tried again on the next tick: a stale file would have a restart delete
// a live container.
func TestStateWriteRetried(t *testing.T) {
	h := newHarness(t)
	h.create("sb-state", sandboxOptions{})
	path := h.cfg.statePath()
	os.Remove(path)
	os.MkdirAll(filepath.Join(path, "in-the-way"), 0o700) // rename onto a directory fails
	h.m.save()
	h.m.mu.Lock()
	dirty := h.m.dirty
	h.m.mu.Unlock()
	if !dirty || !strings.Contains(h.logs.String(), "writing state.json failed") {
		t.Fatalf("a failed write is not marked for a retry (dirty %v)", dirty)
	}
	os.RemoveAll(path)
	h.m.reap(context.Background(), time.Now())
	if rec := readState(t, h)["sb-state"]; rec.State != stateRunning {
		t.Fatalf("after the retry: %+v", rec)
	}
}

// A file tar cannot read fails the snapshot (and so the stop) instead of being left out of it.
func TestSnapshotUnreadableFile(t *testing.T) {
	h := newHarness(t)
	if !h.real && os.Geteuid() == 0 {
		t.Skip("root reads every file: needs gVisor (SANDBOXD_REAL_ROOTFS) or a non-root run")
	}
	h.create("sb-unreadable", sandboxOptions{})
	h.writeFile("sb-unreadable", "/workspace/secret.txt", []byte("x"))
	h.sh("sb-unreadable", "chmod 000 secret.txt")
	var failure map[string]string
	if status := h.call("POST", "/v1/sandboxes/sb-unreadable/stop", nil, &failure); status != 502 ||
		failure["error"] != "snapshot_failed" || !strings.Contains(failure["message"], "secret.txt") {
		t.Fatalf("stop with an unreadable file: %d %v", status, failure)
	}
	h.sh("sb-unreadable", "chmod 600 secret.txt")
	if status := h.call("POST", "/v1/sandboxes/sb-unreadable/stop", nil, nil); status != 200 {
		t.Fatalf("stop once readable: %d", status)
	}
}
