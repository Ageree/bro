package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestExecStream(t *testing.T) {
	h := newHarness(t)
	h.create("sb-exec", sandboxOptions{})
	result := h.exec("sb-exec", map[string]any{
		"command": `echo out; echo err >&2; printf '%s|%s|' "$GREETING" "$BRO_EXEC_ID"; cat; exit 3`,
		"env":     map[string]string{"GREETING": "привет мир", "BRO_EXEC_ID": "spoofed"},
		"stdin":   base64.StdEncoding.EncodeToString([]byte("from stdin")),
	})
	if result.status != 200 || result.code != 3 {
		t.Fatalf("exec: %+v", result)
	}
	if !strings.HasPrefix(result.stdout, "out\nпривет мир|") || !strings.HasSuffix(result.stdout, "|from stdin") ||
		strings.Contains(result.stdout, "spoofed") || result.stderr != "err\n" {
		t.Fatalf("stdout %q, stderr %q", result.stdout, result.stderr)
	}
	if first := result.events[0]; first.Type != "start" || !strings.HasPrefix(first.PID, "p") {
		t.Fatalf("first event %+v", first)
	}
	if last := result.events[len(result.events)-1]; last.Type != "exit" {
		t.Fatalf("last event %+v", last)
	}
	// No stdin in the request: the command sees its end at once instead of waiting on an open pipe.
	started := time.Now()
	if out := h.sh("sb-exec", "cat; echo done"); out != "done\n" || time.Since(started) > 5*time.Second {
		t.Fatalf("cat without stdin: %q after %s", out, time.Since(started))
	}
	h.sh("sb-exec", "mkdir -p 'sub dir'")
	if out := h.exec("sb-exec", map[string]any{"command": "pwd", "cwd": "/workspace/sub dir"}); out.code != 0 ||
		!strings.HasSuffix(out.stdout, "/workspace/sub dir\n") {
		t.Fatalf("cwd: %+v", out)
	}
	if h.real {
		if out := h.sh("sb-exec", `id -u; id -g; echo "$HOME"; cat /proc/self/status | grep ^CapEff`); out !=
			"1000\n1000\n/home/sandbox\nCapEff:\t0000000000000000\n" {
			t.Fatalf("identity: %q", out)
		}
	} else {
		for _, call := range h.calls() {
			if len(call) > 5 && call[5] == "exec" && call[6] != "--user=1000:1000" {
				t.Fatalf("exec as %q", call[6])
			}
		}
	}
	for name, body := range map[string]map[string]any{
		"no command":   {"command": " "},
		"relative cwd": {"command": "true", "cwd": "workspace"},
		"bad env":      {"command": "true", "env": map[string]string{"A-B": "x"}},
		"bad stdin":    {"command": "true", "stdin": "***"},
		"bad timeout":  {"command": "true", "timeoutMs": -1},
	} {
		if result := h.exec("sb-exec", body); result.status != 400 {
			t.Errorf("%s: %d", name, result.status)
		}
	}
	if result := h.exec("sb-missing", map[string]any{"command": "true"}); result.status != 409 {
		t.Fatalf("exec in an unknown sandbox: %d", result.status)
	}
}

func TestExecTimeoutClamp(t *testing.T) {
	for given, want := range map[int64]time.Duration{
		1500: 1500 * time.Millisecond, 3_600_001: time.Hour, 9_223_372_036_855: time.Hour, 1 << 62: time.Hour,
	} {
		_, _, _, timeout, err := parseExec([]byte(fmt.Sprintf(`{"command":"true","timeoutMs":%d}`, given)))
		if err != nil || timeout != want {
			t.Errorf("timeoutMs %d: %s %v, want %s", given, timeout, err, want)
		}
	}
}

// When sandboxd stops, an exec still open is cancelled: its command dies in the sandbox, not later on its
// own past any timeout.
func TestDrainKillsOpenExecs(t *testing.T) {
	h := newHarness(t)
	h.create("sb-drain", sandboxOptions{})
	events := h.openExec(context.Background(), "sb-drain", "sleep 300 & echo $! > d.pid; echo ready; wait")
	nextEvent(t, events)
	if e := nextEvent(t, events); string(e.Data) != "ready\n" {
		t.Fatalf("ready: %+v", e)
	}
	if !h.server.drain(h.api.Config, 200*time.Millisecond, 30*time.Second) {
		t.Fatal("the exec did not end")
	}
	h.restart()
	h.waitDead("sb-drain", "d.pid")
}

func TestExecTimeout(t *testing.T) {
	h := newHarness(t)
	h.create("sb-timeout", sandboxOptions{})
	started := time.Now()
	result := h.exec("sb-timeout", map[string]any{"command": "sleep 30 & echo $! > t.pid; echo ready; wait", "timeoutMs": 700})
	if result.code != 124 || result.stdout != "ready\n" || time.Since(started) > 10*time.Second {
		t.Fatalf("timeout: %+v after %s", result, time.Since(started))
	}
	h.waitDead("sb-timeout", "t.pid")
}

// openExec starts an exec and returns its events as they come.
func (h *harness) openExec(ctx context.Context, id, command string) <-chan event {
	h.t.Helper()
	data, _ := json.Marshal(map[string]any{"command": command})
	request, _ := http.NewRequestWithContext(ctx, "POST", h.api.URL+"/v1/sandboxes/"+id+"/exec", strings.NewReader(string(data)))
	request.Header.Set("Authorization", "Bearer "+h.token())
	response, err := http.DefaultClient.Do(request)
	if err != nil || response.StatusCode != 200 {
		h.t.Fatalf("exec: %v %v", response, err)
	}
	events := make(chan event, 100)
	go func() {
		defer close(events)
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			var e event
			if json.Unmarshal(scanner.Bytes(), &e) == nil {
				events <- e
			}
		}
	}()
	return events
}

func nextEvent(t *testing.T, events <-chan event) event {
	t.Helper()
	select {
	case e, ok := <-events:
		if !ok {
			t.Fatal("the stream ended")
		}
		return e
	case <-time.After(15 * time.Second):
		t.Fatal("no event in 15 s")
	}
	return event{}
}

func TestExecDisconnectKills(t *testing.T) {
	h := newHarness(t)
	h.create("sb-gone", sandboxOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	events := h.openExec(ctx, "sb-gone", "sleep 30 & echo $! > d.pid; echo ready; wait")
	if e := nextEvent(t, events); e.Type != "start" {
		t.Fatalf("first event %+v", e)
	}
	if e := nextEvent(t, events); e.Type != "stdout" || string(e.Data) != "ready\n" {
		t.Fatalf("second event %+v", e)
	}
	cancel()
	h.waitDead("sb-gone", "d.pid")
}

func TestKillProc(t *testing.T) {
	h := newHarness(t)
	h.create("sb-kill", sandboxOptions{})
	events := h.openExec(context.Background(), "sb-kill", "sleep 30 & echo $! > k.pid; echo ready; wait")
	start := nextEvent(t, events)
	if e := nextEvent(t, events); string(e.Data) != "ready\n" {
		t.Fatalf("ready: %+v", e)
	}
	if status := h.call("POST", "/v1/sandboxes/sb-kill/procs/"+start.PID+"/kill", nil, nil); status != 204 {
		t.Fatalf("kill: %d", status)
	}
	var last event
	for e := range events {
		last = e
	}
	if last.Type != "exit" || *last.Code != 137 {
		t.Fatalf("last event after kill: %+v", last)
	}
	h.waitDead("sb-kill", "k.pid")
	if status := h.call("POST", "/v1/sandboxes/sb-kill/procs/"+start.PID+"/kill", nil, nil); status != 204 {
		t.Fatalf("second kill: %d", status)
	}
	if status := h.call("POST", "/v1/sandboxes/sb-kill/procs/p999999/kill", nil, nil); status != 204 {
		t.Fatalf("kill of an unknown pid: %d", status)
	}
	if status := h.call("POST", "/v1/sandboxes/sb-nope/procs/p1/kill", nil, nil); status != 204 {
		t.Fatalf("kill in an unknown sandbox: %d", status)
	}
}

// A background process that keeps stdout open does not hold the stream: it ends two seconds after the
// command, and the process lives on (a server the next command talks to).
func TestExecBackgroundChild(t *testing.T) {
	h := newHarness(t)
	h.create("sb-bg", sandboxOptions{})
	started := time.Now()
	result := h.exec("sb-bg", map[string]any{"command": "sleep 30 & echo $! > bg.pid; echo started"})
	if result.code != 0 || result.stdout != "started\n" || time.Since(started) < 1500*time.Millisecond ||
		time.Since(started) > 8*time.Second {
		t.Fatalf("background child: %+v after %s", result, time.Since(started))
	}
	if !h.processAlive("sb-bg", "bg.pid") {
		t.Fatal("the background process was killed with the command")
	}
}

// A command that is silent longer than exec_ping_seconds gets {"type":"ping"} lines meanwhile (clients and
// proxies cut silent streams), never before start nor after exit; a talkative one gets none.
func TestExecPing(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.ExecPingSeconds = 1 })
	h.create("sb-ping", sandboxOptions{})
	result := h.exec("sb-ping", map[string]any{"command": "echo before; sleep 3.5; echo after"})
	var kinds []string
	for _, e := range result.events {
		kinds = append(kinds, e.Type)
	}
	pings := strings.Count(strings.Join(kinds, " "), "ping")
	if result.code != 0 || pings < 2 || pings > 4 || kinds[0] != "start" || kinds[len(kinds)-1] != "exit" {
		t.Fatalf("events of a silent command: %v", kinds)
	}
	if strings.Contains(strings.Join(kinds, " "), "start ping") {
		t.Fatalf("a ping came right after start, before a whole quiet second: %v", kinds)
	}
	// While it writes every 0.2 s there is no ping (after its last line the runtime may take a while to
	// report the exit: a ping there is right).
	talkative := h.exec("sb-ping", map[string]any{"command": "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i; sleep 0.2; done"})
	writing := false
	for _, e := range talkative.events {
		switch {
		case e.Type == "stdout":
			writing = string(e.Data) != "12\n"
		case e.Type == "ping" && writing:
			t.Fatalf("a ping while the command wrote every 0.2 s: %+v", talkative.events)
		}
	}
}
