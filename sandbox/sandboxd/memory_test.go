package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeProc writes a /proc with processes pid → (parent, state, start time).
func fakeProc(t *testing.T, processes map[int][3]string) string {
	t.Helper()
	dir := t.TempDir()
	for pid, p := range processes {
		os.MkdirAll(filepath.Join(dir, strconv.Itoa(pid)), 0o755)
		stat := fmt.Sprintf("%d (gvisor (x)) %s %s 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 %s 0 0\n", pid, p[1], p[0], p[2])
		os.WriteFile(filepath.Join(dir, strconv.Itoa(pid), "stat"), []byte(stat), 0o644)
		os.WriteFile(filepath.Join(dir, strconv.Itoa(pid), "oom_score_adj"), []byte("0\n"), 0o644)
	}
	return dir
}

func adj(t *testing.T, proc string, pid int) string {
	data, err := os.ReadFile(filepath.Join(proc, strconv.Itoa(pid), "oom_score_adj"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}

func TestPreferGuestVictims(t *testing.T) {
	// 10 the sentry; 11 the stub template, 12 and 13 stubs (13's child 14); 20 the gofer, 30 elsewhere.
	proc := fakeProc(t, map[int][3]string{
		10: {"1", "S", "100"}, 11: {"10", "S", "101"}, 12: {"10", "S", "102"}, 13: {"10", "S", "103"},
		14: {"13", "S", "104"}, 20: {"1", "S", "105"}, 30: {"20", "S", "106"},
	})
	changed, err := preferGuestVictims(proc, 10)
	if err != nil || changed != 4 {
		t.Fatalf("changed %d, %v", changed, err)
	}
	for pid, want := range map[int]string{10: "0", 11: "1000", 12: "1000", 13: "1000", 14: "1000", 20: "0", 30: "0"} {
		if got := adj(t, proc, pid); got != want {
			t.Errorf("pid %d: oom_score_adj %s, want %s", pid, got, want)
		}
	}
}

func TestProcIdentity(t *testing.T) {
	proc := fakeProc(t, map[int][3]string{10: {"1", "S", "100"}, 11: {"1", "Z", "101"}})
	sentry := identify(proc, 10)
	if sentry.pid != 10 || sentry.start != "100" || sentry.gone(proc) {
		t.Fatalf("identity %+v", sentry)
	}
	if !identify(proc, 11).gone(proc) {
		t.Fatal("a zombie counts as alive")
	}
	if (procIdentity{}).gone(proc) || identify(proc, 0) != (procIdentity{}) {
		t.Fatal("an unknown process counts as gone")
	}
	os.WriteFile(filepath.Join(proc, "10", "stat"), []byte("10 (other) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0\n"), 0o644)
	if !sentry.gone(proc) {
		t.Fatal("a reused pid counts as the sentry")
	}
	os.RemoveAll(filepath.Join(proc, "10"))
	if !sentry.gone(proc) {
		t.Fatal("an exited sentry counts as alive")
	}
}

func TestMemoryBudgets(t *testing.T) {
	for memory, want := range map[int][4]int{256: {256, 128, 64, 64}, 1536: {256, 768, 384, 384}, 8192: {1024, 4096, 2048, 2048}} {
		got := [4]int{headroomMB(memory), overlayMB(memory), tmpMB(memory), shmMB(memory)}
		if got != want {
			t.Errorf("%d MiB: headroom, overlay, /tmp, /dev/shm = %v, want %v", memory, got, want)
		}
		if got[1]+got[2]+got[3] > memory {
			t.Errorf("%d MiB: files may take more than the sandbox's memory", memory)
		}
	}
}

// kill ends a sandbox's container behind sandboxd's back: the real sentry gets SIGKILL, as from the OOM
// killer; the fake's container stops.
func (h *harness) killContainer(id string) {
	h.t.Helper()
	ctx := context.Background()
	if !h.real {
		if err := h.m.rt.Kill(ctx, id, "KILL"); err != nil {
			h.t.Fatal(err)
		}
		return
	}
	state, err := h.m.rt.State(ctx, id)
	if err != nil || state.PID <= 1 {
		h.t.Fatalf("no sentry pid: %+v %v", state, err)
	}
	syscall.Kill(state.PID, syscall.SIGKILL)
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if state, _ := h.m.rt.State(ctx, id); state.Status != "running" {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatal("the container still runs after its sentry was killed")
		}
	}
}

// A container that died (its sentry killed by the OOM killer) is found on the next request: work in it is
// refused with 409 sandbox_stopped, GET says 404, and the next PUT makes it anew from its last snapshot.
func TestDeadContainer(t *testing.T) {
	h := newHarness(t)
	get := func(id string) *string { u := h.s3.url("/bucket/" + id + ".snap"); return &u }
	for _, how := range []string{"exec", "get", "put", "stop"} {
		id := "sb-dead-" + how
		h.create(id, sandboxOptions{get: get(id)})
		h.writeFile(id, "/workspace/saved.txt", []byte("in the snapshot"))
		if status := h.call("POST", "/v1/sandboxes/"+id+"/snapshot", nil, nil); status != 200 {
			t.Fatalf("%s: snapshot %d", how, status)
		}
		h.writeFile(id, "/workspace/lost.txt", []byte("after the snapshot"))
		h.killContainer(id)

		switch how {
		case "exec":
			// The first request may already be streaming when the death shows: then its last line says so.
			result := h.exec(id, map[string]any{"command": "echo hi"})
			var last event
			if len(result.events) > 0 {
				last = result.events[len(result.events)-1]
			}
			if result.status != 409 && (last.Type != "error" || !strings.HasPrefix(last.Message, "sandbox_stopped")) {
				t.Fatalf("exec in a dead sandbox: %+v", result)
			}
			if result := h.exec(id, map[string]any{"command": "echo hi"}); result.status != 409 {
				t.Fatalf("second exec in a dead sandbox: %d", result.status)
			}
			var failure map[string]string
			response := h.request("GET", "/v1/sandboxes/"+id+"/files?path=/workspace/saved.txt", nil)
			body := readJSON(t, response, &failure)
			if response.StatusCode != 409 || failure["error"] != "sandbox_stopped" || !strings.Contains(failure["message"], "exited") {
				t.Fatalf("read in a dead sandbox: %d %s", response.StatusCode, body)
			}
		case "get":
			if status := h.call("GET", "/v1/sandboxes/"+id, nil, nil); status != 404 {
				t.Fatalf("GET of a dead sandbox: %d", status)
			}
		case "stop":
			if status := h.call("POST", "/v1/sandboxes/"+id+"/stop", nil, nil); status != 404 {
				t.Fatalf("stop of a dead sandbox: %d", status)
			}
		}
		if how != "put" {
			if rec := readState(t, h)[id]; rec.State != stateStopped || rec.StopReason != reasonDied {
				t.Fatalf("%s: record %+v", how, rec)
			}
		}
		result := h.create(id, sandboxOptions{get: get(id)})
		if !result.Created || !result.Restored {
			t.Fatalf("%s: PUT after the death: %+v", how, result)
		}
		if status, data := h.readFile(id, "/workspace/saved.txt"); status != 200 || string(data) != "in the snapshot" {
			t.Fatalf("%s: restored file: %d %q", how, status, data)
		}
		if status, _ := h.readFile(id, "/workspace/lost.txt"); status != 404 {
			t.Fatalf("%s: a file from after the snapshot survived: %d", how, status)
		}
	}
}

func readJSON(t *testing.T, response *http.Response, out any) string {
	t.Helper()
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	json.Unmarshal(data, out)
	return string(data)
}

// The guest takes more memory than its sandbox has: the process is killed or refused, never the sandbox.
func TestMemoryOverrun(t *testing.T) {
	h := newHarness(t)
	if !h.real {
		t.Skip("needs gVisor: SANDBOXD_REAL_ROOTFS")
	}
	const id = "sb-memory"
	h.create(id, sandboxOptions{memory: 512})
	h.writeFile(id, "/workspace/keep.txt", []byte("kept"))
	ctx := context.Background()
	state, err := h.m.rt.State(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, limit := range []string{
		"/sys/fs/cgroup/sandboxd/" + id + "/memory.max", "/sys/fs/cgroup/memory/sandboxd/" + id + "/memory.limit_in_bytes",
	} {
		if data, err := os.ReadFile(limit); err == nil {
			if got := strings.TrimSpace(string(data)); got != strconv.Itoa((512+256)<<20) {
				t.Fatalf("%s = %s, want the headroom on top", limit, got)
			}
		}
	}
	if adj(t, "/proc", state.PID) != "0" {
		t.Fatal("the sentry's oom_score_adj changed")
	}
	if out := h.sh(id, "grep MemTotal /proc/meminfo"); !strings.Contains(out, " 524288 kB") {
		t.Fatalf("the guest sees %q", out)
	}
	allocate := map[string]string{
		"at once": `perl -e '$x = "a" x (768*1024*1024); print "allocated\n"'`,
		"gradual": `perl -e 'my @a; push @a, "a" x (1024*1024) for 1..1000; print "allocated\n"'`,
		// Each fits alone, the two together do not: one of them is killed.
		"together": `p='my @a; push @a, "a" x (1024*1024) for 1..400; sleep 2'; perl -e "$p" & a=$!; perl -e "$p" & b=$!; ` +
			`wait $a; first=$?; wait $b; echo "$first $?"`,
	}
	if strings.TrimSpace(h.sh(id, "command -v perl || true")) == "" {
		t.Skip("no perl in the rootfs")
	}
	for name, command := range allocate {
		result := h.exec(id, map[string]any{"command": command, "timeoutMs": 60000})
		if result.status != 200 || strings.Contains(result.stdout, "allocated") {
			t.Fatalf("%s: %+v", name, result)
		}
		if name == "together" {
			if codes := strings.Fields(result.stdout); result.code != 0 || len(codes) != 2 || !slices.Contains(codes, "137") {
				t.Fatalf("together: exits %q, stderr %q", result.stdout, result.stderr)
			}
		} else if result.code != 137 {
			t.Fatalf("%s: exit %d, stderr %q", name, result.code, result.stderr)
		}
		if out := h.sh(id, "cat /workspace/keep.txt"); out != "kept" {
			t.Fatalf("%s: the sandbox lost its files: %q", name, out)
		}
	}
	for path, size := range map[string]string{"/tmp/big": "300M", "/dev/shm/big": "300M", "/workspace/big": "400M"} {
		result := h.exec(id, map[string]any{"command": "head -c " + size + " /dev/zero > " + path + "; code=$?; rm -f " + path + "; exit $code"})
		if result.code == 0 || !strings.Contains(result.stderr, "No space left") {
			t.Fatalf("%s past its size: %+v", path, result)
		}
	}
	var view statusView
	if status := h.call("GET", "/v1/sandboxes/"+id, nil, &view); status != 200 || view.State != "running" {
		t.Fatalf("after the overruns: %d %+v", status, view)
	}
}

// The sandbox's cgroup has its CPU quota (cpus), and `runsc update --memory` after the start leaves it.
func TestCPUQuota(t *testing.T) {
	h := newHarness(t)
	if !h.real {
		t.Skip("needs gVisor: SANDBOXD_REAL_ROOTFS")
	}
	const id = "sb-cpu"
	h.create(id, sandboxOptions{})
	found := false
	for path, want := range map[string]string{
		"/sys/fs/cgroup/sandboxd/" + id + "/cpu.max":                      "200000 100000",
		"/sys/fs/cgroup/cpu/sandboxd/" + id + "/cpu.cfs_quota_us":         "200000",
		"/sys/fs/cgroup/cpu/sandboxd/" + id + "/cpu.cfs_period_us":        "100000",
		"/sys/fs/cgroup/cpu,cpuacct/sandboxd/" + id + "/cpu.cfs_quota_us": "200000",
	} {
		if data, err := os.ReadFile(path); err == nil {
			found = true
			if got := strings.TrimSpace(string(data)); got != want {
				t.Fatalf("%s = %s, want %s", path, got, want)
			}
		}
	}
	if !found {
		t.Fatal("no CPU quota file of the sandbox's cgroup")
	}
	t.Logf("CPUs the guest sees: %s", strings.TrimSpace(h.sh(id, "nproc")))
}
