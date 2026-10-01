package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHealthAndAuth(t *testing.T) {
	h := newHarness(t)
	response, err := http.Get(h.api.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	var health map[string]any
	json.NewDecoder(response.Body).Decode(&health)
	response.Body.Close()
	if response.StatusCode != 200 || health["version"] != version || health["rootfs"] != "test" || health["sandboxes"] != 0.0 ||
		!strings.HasPrefix(health["runsc"].(string), "runsc version") {
		t.Fatalf("health: %d %v", response.StatusCode, health)
	}
	for name, header := range map[string]string{
		"none":    "",
		"basic":   "Basic abc",
		"expired": "Bearer " + signToken(testKey, testHost, time.Now().Unix()-5),
		"host":    "Bearer " + signToken(testKey, "other", time.Now().Unix()+60),
	} {
		request, _ := http.NewRequest("GET", h.api.URL+"/v1/sandboxes/sb-1", nil)
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]string
		json.NewDecoder(response.Body).Decode(&body)
		response.Body.Close()
		if response.StatusCode != 401 || body["error"] != "unauthorized" || body["message"] == "" {
			t.Errorf("%s: %d %v", name, response.StatusCode, body)
		}
	}
	var failure map[string]string
	if status := h.call("GET", "/v1/sandboxes/-bad", nil, &failure); status != 400 {
		t.Errorf("an id starting with '-' (a runsc flag): %d", status)
	}
	if status := h.call("GET", "/v1/sandboxes/Upper", nil, &failure); status != 400 {
		t.Errorf("an upper-case id: %d", status)
	}
	if status := h.call("GET", "/v1/nothing", nil, &failure); status != 404 || failure["error"] != "not_found" {
		t.Errorf("unknown route: %d %v", status, failure)
	}
}

func TestCreateReattachAndGet(t *testing.T) {
	h := newHarness(t)
	first := h.create("sb-create", sandboxOptions{memory: 768})
	if !first.Created || first.Restored || first.State != "running" || first.ID != "sb-create" {
		t.Fatalf("first PUT: %+v", first)
	}
	again := h.create("sb-create", sandboxOptions{})
	if again.Created || again.State != "running" {
		t.Fatalf("second PUT: %+v", again)
	}
	var view statusView
	if status := h.call("GET", "/v1/sandboxes/sb-create", nil, &view); status != 200 || view.State != "running" ||
		view.MemoryMB != 768 || view.LastUsedAt == "" {
		t.Fatalf("GET: %d %+v", status, view)
	}
	if _, err := time.Parse(time.RFC3339, view.LastUsedAt); err != nil {
		t.Fatalf("lastUsedAt %q: %v", view.LastUsedAt, err)
	}
	var failure map[string]string
	body := h.sandboxBody("sb-create", sandboxOptions{})
	body["workspace"] = "personal:someone-else"
	if status := h.call("PUT", "/v1/sandboxes/sb-create", body, &failure); status != 409 || failure["error"] != "workspace_mismatch" {
		t.Fatalf("other workspace: %d %v", status, failure)
	}
	if status := h.call("GET", "/v1/sandboxes/sb-none", nil, &failure); status != 404 || failure["error"] != "not_found" {
		t.Fatalf("GET unknown: %d %v", status, failure)
	}
	for name, mutate := range map[string]func(map[string]any){
		"no workspace": func(b map[string]any) { delete(b, "workspace") },
		"no snapshot":  func(b map[string]any) { delete(b, "snapshot") },
		"bad key":      func(b map[string]any) { b["snapshot"].(map[string]any)["key"] = "abc" },
		"bad put":      func(b map[string]any) { b["snapshot"].(map[string]any)["put"] = "ftp://x/y" },
		"memory":       func(b map[string]any) { b["memoryMb"] = 10 },
		"tools url":    func(b map[string]any) { b["tools"] = map[string]any{"url": "nope", "token": "t"} },
		"tools header": func(b map[string]any) {
			b["tools"] = map[string]any{"url": "https://x/y", "token": "t", "headers": map[string]string{"Authorization": "x"}}
		},
	} {
		body := h.sandboxBody("sb-bad", sandboxOptions{})
		mutate(body)
		if status := h.call("PUT", "/v1/sandboxes/sb-bad", body, &failure); status != 400 || failure["error"] != "bad_request" {
			t.Errorf("%s: %d %v", name, status, failure)
		}
	}
	if h.real {
		return
	}
	var run []string
	for _, call := range h.calls() {
		if slices.Contains(call, "run") {
			run = call
		}
	}
	want := []string{"--root=" + h.cfg.RunscRoot, "--platform=systrap", "--network=none", "--overlay2=root:memory,size=384m",
		"--host-uds=open", "run", "--detach", "--bundle=" + h.cfg.paths("sb-create").bundle, "sb-create"}
	if !slices.Equal(run, want) {
		t.Fatalf("runsc run:\n got %q\nwant %q", run, want)
	}
	// The host cgroup gets the headroom on top of what the guest was told (memory.go).
	if !slices.ContainsFunc(h.calls(), func(call []string) bool {
		return slices.Equal(call[5:], []string{"update", fmt.Sprintf("--memory=%d", int64(768+256)<<20), "sb-create"})
	}) {
		t.Fatalf("no runsc update with the headroom: %q", h.calls())
	}
	var spec struct {
		Process struct {
			User         map[string]int      `json:"user"`
			Capabilities map[string][]string `json:"capabilities"`
			NoNewPrivs   bool                `json:"noNewPrivileges"`
			Args         []string            `json:"args"`
		} `json:"process"`
		Root   map[string]any   `json:"root"`
		Mounts []map[string]any `json:"mounts"`
		Linux  struct {
			CgroupsPath string                      `json:"cgroupsPath"`
			Resources   map[string]map[string]int64 `json:"resources"`
		} `json:"linux"`
	}
	data, _ := os.ReadFile(filepath.Join(h.cfg.paths("sb-create").bundle, "config.json"))
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.Process.User["uid"] != 1000 || spec.Process.User["gid"] != 1000 || !spec.Process.NoNewPrivs ||
		len(spec.Process.Capabilities["bounding"]) != 0 || spec.Root["readonly"] != false ||
		spec.Linux.Resources["memory"]["limit"] != 768<<20 || spec.Linux.Resources["pids"]["limit"] != 1024 ||
		spec.Linux.CgroupsPath != "/sandboxd/sb-create" {
		t.Fatalf("spec: %s", data)
	}
	var bind map[string]any
	for _, mount := range spec.Mounts {
		if mount["destination"] == "/run/bro" {
			bind = mount
		}
	}
	if bind == nil || bind["source"] != h.cfg.paths("sb-create").run || !strings.Contains(string(data), `"ro"`) {
		t.Fatalf("no /run/bro bind mount: %s", data)
	}
	for _, size := range []string{`"size=192m"`} { // /tmp and /dev/shm: a quarter each
		if strings.Count(string(data), size) != 2 {
			t.Fatalf("tmpfs sizes: %s", data)
		}
	}
	info, err := os.Stat(h.cfg.paths("sb-create").socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o666 {
		t.Fatalf("tools.sock: %v %v", info, err)
	}
}

func TestCapacity(t *testing.T) {
	// Each sandbox counts with its headroom: 512 + 256.
	h := newHarness(t, func(c *Config) { c.MaxSandboxes = 2; c.MemoryLimitMB = 2600 })
	h.create("sb-a", sandboxOptions{memory: 512})
	h.create("sb-b", sandboxOptions{memory: 512})
	var failure map[string]string
	if status := h.call("PUT", "/v1/sandboxes/sb-c", h.sandboxBody("sb-c", sandboxOptions{memory: 256}), &failure); status != 507 ||
		failure["error"] != "host_full" {
		t.Fatalf("third sandbox: %d %v", status, failure)
	}
	if again := h.create("sb-a", sandboxOptions{}); again.Created {
		t.Fatal("a live sandbox's PUT must not count against the limits")
	}
	if status := h.call("DELETE", "/v1/sandboxes/sb-b", nil, nil); status != 204 {
		t.Fatalf("DELETE: %d", status)
	}
	if status := h.call("PUT", "/v1/sandboxes/sb-c", h.sandboxBody("sb-c", sandboxOptions{memory: 2048}), &failure); status != 507 ||
		failure["error"] != "host_full" || !strings.Contains(failure["message"], "2600 MiB") {
		t.Fatalf("over the memory limit: %d %v", status, failure)
	}
	h.create("sb-c", sandboxOptions{memory: 1024})
	if status := h.call("DELETE", "/v1/sandboxes/sb-never", nil, nil); status != 204 {
		t.Fatalf("DELETE of an unknown sandbox: %d", status)
	}
}

func TestNetworkPolicy(t *testing.T) {
	h := newHarness(t)
	h.create("sb-net", sandboxOptions{})
	var failure map[string]string
	if status := h.call("POST", "/v1/sandboxes/sb-net/network", `{"policy":"deny-all"}`, nil); status != 204 {
		t.Fatalf("deny-all: %d", status)
	}
	for _, body := range []string{`{"policy":"allow-all"}`, `{"policy":{"allow":["example.com"]}}`} {
		if status := h.call("POST", "/v1/sandboxes/sb-net/network", body, &failure); status != 409 ||
			failure["error"] != "unsupported_policy" {
			t.Fatalf("%s: %d %v", body, status, failure)
		}
	}
	if status := h.call("POST", "/v1/sandboxes/sb-net/network", `{}`, &failure); status != 400 {
		t.Fatalf("no policy: %d", status)
	}
	if status := h.call("POST", "/v1/sandboxes/sb-other/network", `{"policy":"deny-all"}`, &failure); status != 409 ||
		failure["error"] != "sandbox_stopped" {
		t.Fatalf("unknown sandbox: %d", status)
	}
	if h.real {
		// --network=none: loopback only.
		if out := h.sh("sb-net", "cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '"); out != "lo\n" {
			t.Fatalf("interfaces: %q", out)
		}
	}
}

func TestStartFailureCleansUp(t *testing.T) {
	h := newHarness(t)
	h.fakeOnly()
	os.WriteFile(filepath.Join(h.cfg.RunscRoot, "fail-run"), nil, 0o600)
	var failure map[string]string
	if status := h.call("PUT", "/v1/sandboxes/sb-fail", h.sandboxBody("sb-fail", sandboxOptions{}), &failure); status != 502 ||
		failure["error"] != "runtime_failed" {
		t.Fatalf("PUT: %d %v", status, failure)
	}
	if status := h.call("GET", "/v1/sandboxes/sb-fail", nil, nil); status != 404 {
		t.Fatalf("GET after a failed start: %d", status)
	}
	if _, err := os.Stat(h.cfg.paths("sb-fail").dir); !os.IsNotExist(err) {
		t.Fatalf("the sandbox's directory is left: %v", err)
	}
	state := readState(t, h)
	if rec := state["sb-fail"]; rec.State != stateStopped || rec.Snapshot != nil {
		t.Fatalf("record after a failed start: %+v", rec)
	}
	os.Remove(filepath.Join(h.cfg.RunscRoot, "fail-run"))
	h.create("sb-fail", sandboxOptions{})
}

func readState(t *testing.T, h *harness) map[string]record {
	t.Helper()
	data, err := os.ReadFile(h.cfg.statePath())
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(h.cfg.statePath())
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state.json mode %v", info.Mode())
	}
	var state stateFile
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	records := map[string]record{}
	for _, rec := range state.Sandboxes {
		records[rec.ID] = rec
	}
	return records
}

func TestReconcileAfterRestart(t *testing.T) {
	h := newHarness(t)
	seen := make(chan string, 10)
	upstream := httptestServer(t, func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Authorization")
		w.Write([]byte(`{"data":{}}`))
	})
	h.create("sb-keep", sandboxOptions{tools: &toolsConfig{URL: upstream + "/graphql", Token: "router-token-keep"}})
	h.create("sb-dead", sandboxOptions{})
	h.create("sb-starting", sandboxOptions{})
	if status := h.writeFile("sb-keep", "/workspace/x.txt", []byte("survives")); status != 204 {
		t.Fatalf("write: %d", status)
	}
	ctx := context.Background()
	// Meanwhile: sb-dead's container died, sandboxd went down halfway through starting sb-starting, and a
	// container appeared that has no record.
	h.m.rt.Delete(ctx, "sb-dead")
	h.m.mu.Lock()
	h.m.sandboxes["sb-starting"].rec.State = stateStarting
	h.m.mu.Unlock()
	h.m.save()
	orphan := h.cfg.paths("sb-orphan")
	os.MkdirAll(orphan.run, 0o755)
	if err := writeBundle(h.cfg, orphan, "sb-orphan", 256); err != nil {
		t.Fatal(err)
	}
	if err := h.m.rt.Run(ctx, "sb-orphan", orphan.bundle, orphan.log, 128); err != nil {
		t.Fatal(err)
	}

	h.restart()
	var view statusView
	if status := h.call("GET", "/v1/sandboxes/sb-keep", nil, &view); status != 200 || view.State != "running" {
		t.Fatalf("adopted sandbox: %d %+v", status, view)
	}
	if status, data := h.readFile("sb-keep", "/workspace/x.txt"); status != 200 || string(data) != "survives" {
		t.Fatalf("adopted sandbox's file: %d %q", status, data)
	}
	response, err := brokerHTTP(h.cfg.paths("sb-keep").socket).Post("http://sandbox/graphql", "application/json",
		strings.NewReader(`{"query":"{ tools { name } }"}`))
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("adopted broker: %v %v", response, err)
	}
	response.Body.Close()
	if auth := <-seen; auth != "Bearer router-token-keep" {
		t.Fatalf("adopted broker sent %q", auth)
	}
	for _, id := range []string{"sb-dead", "sb-starting"} {
		if status := h.call("GET", "/v1/sandboxes/"+id, nil, nil); status != 404 {
			t.Fatalf("%s after restart: %d", id, status)
		}
	}
	state := readState(t, h)
	if rec := state["sb-dead"]; rec.State != stateStopped || rec.StopReason == "" || rec.Tools != nil || rec.Snapshot != nil {
		t.Fatalf("lost sandbox's record: %+v", rec)
	}
	if rec := state["sb-starting"]; rec.State != stateStopped {
		t.Fatalf("half-started sandbox's record: %+v", rec)
	}
	if rec := state["sb-keep"]; rec.State != stateRunning || rec.Tools == nil || rec.Snapshot == nil {
		t.Fatalf("adopted sandbox's record: %+v", rec)
	}
	statuses, err := h.m.rt.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := statuses["sb-orphan"]; ok {
		t.Fatal("the container without a record is still there")
	}
	if _, ok := statuses["sb-starting"]; ok {
		t.Fatal("the half-started container is still there")
	}
}

func httptestServer(t *testing.T, handler http.HandlerFunc) string {
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server.URL
}

// assertNoSecrets fails when a log line holds any of the secrets.
func (h *harness) assertNoSecrets(secrets ...string) {
	h.t.Helper()
	logs := h.logs.String()
	for _, secret := range secrets {
		if strings.Contains(logs, secret) {
			h.t.Fatalf("the logs hold %q:\n%s", secret, logs)
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(logs))
	for scanner.Scan() {
		if !json.Valid(scanner.Bytes()) {
			h.t.Fatalf("not a one-line JSON log: %q", scanner.Text())
		}
	}
}
