package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The harness runs sandboxd's API against the fake runsc (fake_runsc_test.go) and a stand-in for Object
// Storage. With SANDBOXD_REAL_ROOTFS=<a rootfs directory> (root only: runsc on this host) the same tests
// run against the real runsc on PATH; tests that look into the fake's internals skip then.
//
//	sudo SANDBOXD_REAL_ROOTFS=/srv/sandboxd/rootfs/<version> go test ./...

const testHost = "sbx-test-host"

var testKey = bytes.Repeat([]byte{0x42}, 32)

// signToken signs as Bro does: compact JSON with env before exp, unpadded base64url.
func signToken(key []byte, host string, exp int64) string {
	return signPayload(key, []byte(fmt.Sprintf(`{"env":%q,"exp":%d}`, host, exp)))
}

func signPayload(key, payload []byte) string {
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("v1." + encoded))
	return "v1." + encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type harness struct {
	t      *testing.T
	real   bool
	cfg    Config
	m      *Manager
	server *API
	api    *httptest.Server
	s3     *fakeS3
	logs   *syncBuffer
}

func realRootfs() string { return os.Getenv("SANDBOXD_REAL_ROOTFS") }

func newHarness(t *testing.T, options ...func(*Config)) *harness {
	t.Helper()
	dir := t.TempDir()
	config := defaultConfig()
	config.Host, config.Key = testHost, hex.EncodeToString(testKey)
	config.Root = filepath.Join(dir, "srv")
	config.RunscRoot = filepath.Join(dir, "runsc-state")
	config.RootfsVersion = "test"
	config.MemoryLimitMB = 8192
	config.MemoryMB = 512
	h := &harness{t: t, real: realRootfs() != "", s3: newFakeS3(t), logs: &syncBuffer{}}
	rootfs := filepath.Join(config.Root, "rootfs", config.RootfsVersion)
	if err := os.MkdirAll(filepath.Dir(rootfs), 0o700); err != nil {
		t.Fatal(err)
	}
	if h.real {
		binary, err := exec.LookPath("runsc")
		if err != nil {
			t.Fatal("SANDBOXD_REAL_ROOTFS is set but runsc is not on PATH")
		}
		config.Runsc = binary
		if err := os.Symlink(realRootfs(), rootfs); err != nil {
			t.Fatal(err)
		}
	} else {
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		config.Runsc = filepath.Join(dir, "bin", "runsc")
		os.MkdirAll(filepath.Dir(config.Runsc), 0o755)
		if err := os.Symlink(self, config.Runsc); err != nil {
			t.Fatal(err)
		}
		for _, sub := range []string{"workspace", "home/sandbox", "run/bro", "etc"} {
			os.MkdirAll(filepath.Join(rootfs, sub), 0o755)
		}
		os.WriteFile(filepath.Join(rootfs, "etc", "hostname"), []byte("sandbox\n"), 0o644)
	}
	for _, option := range options {
		option(&config)
	}
	if err := config.validate(); err != nil {
		t.Fatal(err)
	}
	h.cfg = config
	h.start()
	t.Cleanup(h.close)
	return h
}

// start makes a Manager on the harness's config, as sandboxd does when it starts.
func (h *harness) start() {
	h.t.Helper()
	h.m = newManager(h.cfg, newRunsc(h.cfg), slog.New(slog.NewJSONHandler(h.logs, nil)))
	h.m.memTotalMB = func() (int, error) { return 16384, nil }
	var err error
	if h.m.runsc, err = h.m.rt.Version(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	if err := h.m.prepare(); err != nil {
		h.t.Fatal(err)
	}
	if err := h.m.reconcile(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	h.server = &API{m: h.m, now: time.Now}
	h.api = httptest.NewServer(h.server.handler())
}

// restart drops the API and the Manager (sandboxes keep running) and starts anew.
func (h *harness) restart() {
	h.api.Close()
	h.m.mu.Lock()
	for _, sb := range h.m.sandboxes {
		if sb.broker != nil {
			sb.broker.close()
		}
	}
	h.m.mu.Unlock()
	h.start()
}

func (h *harness) close() {
	h.api.Close()
	ids := []string{}
	h.m.mu.Lock()
	for id := range h.m.sandboxes {
		ids = append(ids, id)
	}
	h.m.mu.Unlock()
	for _, id := range ids {
		h.m.remove(context.Background(), id)
	}
	if statuses, err := h.m.rt.List(context.Background()); err == nil {
		for id := range statuses {
			h.m.rt.Delete(context.Background(), id)
		}
	}
	if h.real {
		// runsc --network=none keeps a network namespace bind-mounted at <runsc root>/null-netns.
		syscall.Unmount(filepath.Join(h.cfg.RunscRoot, "null-netns"), syscall.MNT_DETACH)
	}
}

func (h *harness) token() string {
	return signToken(testKey, testHost, time.Now().Add(5*time.Minute).Unix())
}

func (h *harness) request(method, path string, body io.Reader) *http.Response {
	h.t.Helper()
	request, err := http.NewRequest(method, h.api.URL+path, body)
	if err != nil {
		h.t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+h.token())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	return response
}

// call sends JSON (or raw bytes) and decodes a JSON answer into out when given.
func (h *harness) call(method, path string, body any, out any) int {
	h.t.Helper()
	var reader io.Reader
	switch value := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(value)
	case string:
		reader = strings.NewReader(value)
	default:
		data, _ := json.Marshal(value)
		reader = bytes.NewReader(data)
	}
	response := h.request(method, path, reader)
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			h.t.Fatalf("%s %s: %d %q is not JSON: %v", method, path, response.StatusCode, data, err)
		}
	}
	return response.StatusCode
}

type sandboxOptions struct {
	get    *string
	tools  *toolsConfig
	memory int
}

func (h *harness) sandboxBody(id string, options sandboxOptions) map[string]any {
	body := map[string]any{
		"workspace": "personal:test",
		"snapshot":  map[string]any{"get": options.get, "put": h.s3.url("/bucket/" + id + ".snap"), "key": hex.EncodeToString(testKey)},
	}
	if options.tools != nil {
		body["tools"] = options.tools
	}
	if options.memory != 0 {
		body["memoryMb"] = options.memory
	}
	return body
}

// create PUTs a sandbox and fails the test unless it answers 200.
func (h *harness) create(id string, options sandboxOptions) putResult {
	h.t.Helper()
	var answer json.RawMessage
	status := h.call("PUT", "/v1/sandboxes/"+id, h.sandboxBody(id, options), &answer)
	if status != http.StatusOK {
		h.t.Fatalf("PUT %s: %d %s", id, status, answer)
	}
	var result putResult
	if err := json.Unmarshal(answer, &result); err != nil {
		h.t.Fatalf("PUT %s: %s: %v", id, answer, err)
	}
	return result
}

type execResult struct {
	events []event
	stdout string
	stderr string
	code   int
	status int
}

func (h *harness) exec(id string, request map[string]any) execResult {
	h.t.Helper()
	data, _ := json.Marshal(request)
	response := h.request("POST", "/v1/sandboxes/"+id+"/exec", bytes.NewReader(data))
	defer response.Body.Close()
	return readEvents(h.t, response)
}

func readEvents(t *testing.T, response *http.Response) execResult {
	t.Helper()
	result := execResult{status: response.StatusCode, code: -1}
	if response.StatusCode != http.StatusOK {
		return result
	}
	if got := response.Header.Get("Content-Type"); got != "application/x-ndjson" {
		t.Fatalf("exec content type %q", got)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 1<<20), 8<<20)
	for scanner.Scan() {
		var e event
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			t.Fatalf("not an event: %q", scanner.Text())
		}
		result.events = append(result.events, e)
		switch e.Type {
		case "stdout":
			result.stdout += string(e.Data)
		case "stderr":
			result.stderr += string(e.Data)
		case "exit":
			result.code = *e.Code
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("the exec stream broke off after %d events: %v", len(result.events), err)
	}
	return result
}

// sh runs a command in the sandbox and returns its stdout, failing the test on a non-zero exit.
func (h *harness) sh(id, command string) string {
	h.t.Helper()
	result := h.exec(id, map[string]any{"command": command})
	if result.status != http.StatusOK || result.code != 0 {
		h.t.Fatalf("%q: status %d, exit %d, stderr %q", command, result.status, result.code, result.stderr)
	}
	return result.stdout
}

func (h *harness) readFile(id, path string) (int, []byte) {
	h.t.Helper()
	response := h.request("GET", "/v1/sandboxes/"+id+"/files?path="+urlQuery(path), nil)
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}

func (h *harness) writeFile(id, path string, data []byte) int {
	h.t.Helper()
	response := h.request("PUT", "/v1/sandboxes/"+id+"/files?path="+urlQuery(path), bytes.NewReader(data))
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

func urlQuery(value string) string {
	return url.QueryEscape(value)
}

// processAlive asks the sandbox whether the pid in the file is a live process (a zombie is not).
func (h *harness) processAlive(id, pidFile string) bool {
	h.t.Helper()
	out := h.sh(id, `p=$(cat `+pidFile+`); if [ -e /proc/$p ] && ! grep -q "^State:[[:space:]]*Z" /proc/$p/status 2>/dev/null; then echo alive; else echo dead; fi`)
	return strings.TrimSpace(out) == "alive"
}

func (h *harness) waitDead(id, pidFile string) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for h.processAlive(id, pidFile) {
		if time.Now().After(deadline) {
			h.t.Fatalf("the process in %s is still alive", pidFile)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// calls is the fake runsc's call log.
func (h *harness) calls() [][]string {
	h.t.Helper()
	data, _ := os.ReadFile(filepath.Join(h.cfg.RunscRoot, "calls.log"))
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var call []string
		if json.Unmarshal([]byte(line), &call) == nil {
			calls = append(calls, call)
		}
	}
	return calls
}

func (h *harness) fakeOnly() {
	if h.real {
		h.t.Skip("looks into the fake runsc")
	}
}

// brokerClient talks HTTP over the sandbox's tools.sock from the host side.
func brokerHTTP(socket string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		},
	}}
}

// fakeS3 stands in for Object Storage behind presigned URLs: PUT needs a Content-Length, GET answers the
// object or 404; failures can be forced.
type fakeS3 struct {
	mu        sync.Mutex
	server    *httptest.Server
	objects   map[string][]byte
	putStatus int
	getStatus int
	puts      int
	queries   []string
}

func newFakeS3(t *testing.T) *fakeS3 {
	s := &fakeS3{objects: map[string][]byte{}}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.queries = append(s.queries, r.URL.RawQuery)
		switch r.Method {
		case http.MethodPut:
			if s.putStatus != 0 {
				w.WriteHeader(s.putStatus)
				return
			}
			if r.ContentLength <= 0 || len(r.TransferEncoding) > 0 {
				http.Error(w, "MissingContentLength", http.StatusLengthRequired)
				return
			}
			data, err := io.ReadAll(r.Body)
			if err != nil || int64(len(data)) != r.ContentLength {
				http.Error(w, "IncompleteBody", http.StatusBadRequest)
				return
			}
			s.objects[r.URL.Path] = data
			s.puts++
		case http.MethodGet:
			if s.getStatus != 0 {
				w.WriteHeader(s.getStatus)
				return
			}
			data, ok := s.objects[r.URL.Path]
			if !ok {
				http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound)
				return
			}
			w.Write(data)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(s.server.Close)
	return s
}

// url is a presigned-looking URL: the signature's %2F must reach the server as sent.
func (s *fakeS3) url(path string) string {
	return s.server.URL + path + "?X-Amz-Credential=key%2F20261001%2Fru-central-1&X-Amz-Signature=deadbeef"
}

func (s *fakeS3) object(path string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.objects[path]
}

func (s *fakeS3) set(put, get int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.putStatus, s.getStatus = put, get
}
