package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type upstreamCall struct {
	path, auth, custom, contentType, body string
	active                                int // requests sandboxd counts in sb-tools meanwhile
}

func TestBroker(t *testing.T) {
	h := newHarness(t)
	calls := make(chan upstreamCall, 300)
	upstream := httptestServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.m.mu.Lock()
		active := h.m.sandboxes["sb-tools"].active
		h.m.mu.Unlock()
		calls <- upstreamCall{r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Bro-Test"),
			r.Header.Get("Content-Type"), string(body), active}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://elsewhere.example/steal", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/graphql-response+json")
		w.Write([]byte(`{"data":{"tools":[{"name":"web_search"}]}}`))
	})
	tools := &toolsConfig{URL: upstream + "/eve/v1/sandbox-tools", Token: "router-token-1",
		Headers: map[string]string{"x-bro-test": "yes"}}
	h.create("sb-tools", sandboxOptions{tools: tools})
	client := brokerHTTP(h.cfg.paths("sb-tools").socket)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	response, err := client.Get("http://sandbox/health")
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("health: %v %v", response, err)
	}
	var health map[string]any
	json.NewDecoder(response.Body).Decode(&health)
	response.Body.Close()
	if health["ok"] != true || health["tools"] != true {
		t.Fatalf("health: %v", health)
	}

	post := func(body string) (int, string) {
		t.Helper()
		response, err := client.Post("http://sandbox/graphql", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(data)
	}
	status, body := post(`{"query":"{ tools { name } }"}`)
	if status != 200 || body != `{"data":{"tools":[{"name":"web_search"}]}}` {
		t.Fatalf("graphql: %d %q", status, body)
	}
	call := <-calls
	if call.path != "/eve/v1/sandbox-tools" || call.auth != "Bearer router-token-1" || call.custom != "yes" ||
		call.contentType != "application/json" || call.body != `{"query":"{ tools { name } }"}` {
		t.Fatalf("upstream saw %+v", call)
	}
	// A tool call is work in the sandbox: the idle reaper does not stop it meanwhile.
	if call.active != 1 {
		t.Fatalf("requests in the sandbox during a tool call: %d", call.active)
	}

	// Every PUT brings a fresh token.
	tools.Token = "router-token-2"
	h.create("sb-tools", sandboxOptions{tools: tools})
	post(`{}`)
	if call := <-calls; call.auth != "Bearer router-token-2" {
		t.Fatalf("after the PUT the broker sent %q", call.auth)
	}

	if h.real && h.brokerFromInside(t, "sb-tools") {
		if call := <-calls; call.auth != "Bearer router-token-2" || call.body != "{}" {
			t.Fatalf("upstream saw from inside %+v", call)
		}
	}

	// Redirects are handed back, not followed: the token goes to tools.url only.
	tools.URL = upstream + "/redirect"
	h.create("sb-tools", sandboxOptions{tools: tools})
	if status, _ := post(`{}`); status != http.StatusFound {
		t.Fatalf("redirect: %d", status)
	}
	<-calls

	huge := strings.Repeat("x", maxBrokerBody+1)
	if status, body := post(huge); status != 413 || !strings.Contains(body, "too_large") {
		t.Fatalf("a body over 25 MiB: %d %q", status, body)
	}

	limited := 0
	for i := 0; i < 130 && limited == 0; i++ {
		if status, body := post(`{}`); status == 429 {
			limited = i
			if !strings.Contains(body, "rate_limited") {
				t.Fatalf("429 body %q", body)
			}
		}
	}
	if limited < 110 {
		t.Fatalf("rate limited after %d requests", limited)
	}

	h.create("sb-no-tools", sandboxOptions{})
	response, err = brokerHTTP(h.cfg.paths("sb-no-tools").socket).Post("http://sandbox/graphql", "application/json", strings.NewReader("{}"))
	if err != nil || response.StatusCode != 503 {
		t.Fatalf("no tools: %v %v", response, err)
	}
	response.Body.Close()
	h.assertNoSecrets("router-token-1", "router-token-2", "deadbeef")
}

// At most brokerParallel tool calls of a sandbox are in flight (each may hold 25 MiB): the others wait.
func TestBrokerParallel(t *testing.T) {
	h := newHarness(t)
	var mu sync.Mutex
	inflight, most := 0, 0
	upstream := httptestServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		inflight++
		most = max(most, inflight)
		mu.Unlock()
		time.Sleep(300 * time.Millisecond)
		mu.Lock()
		inflight--
		mu.Unlock()
		w.Write([]byte(`{"data":{}}`))
	})
	h.create("sb-parallel", sandboxOptions{tools: &toolsConfig{URL: upstream + "/graphql", Token: "t"}})
	client := brokerHTTP(h.cfg.paths("sb-parallel").socket)
	var wg sync.WaitGroup
	statuses := make(chan int, brokerParallel+3)
	for range brokerParallel + 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response, err := client.Post("http://sandbox/graphql", "application/json", strings.NewReader("{}"))
			if err != nil {
				statuses <- 0
				return
			}
			response.Body.Close()
			statuses <- response.StatusCode
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != 200 {
			t.Fatalf("a tool call answered %d", status)
		}
	}
	if most != brokerParallel {
		t.Fatalf("%d tool calls in flight at once, want %d", most, brokerParallel)
	}
}

// brokerFromInside posts to /run/bro/tools.sock from a process in the sandbox (perl is in ubuntu-base);
// false when it could not (no perl).
func (h *harness) brokerFromInside(t *testing.T, id string) bool {
	if strings.TrimSpace(h.sh(id, "command -v perl || true")) == "" {
		t.Log("no perl in the rootfs: the broker is not tried from inside")
		return false
	}
	time.Sleep(time.Second) // a token or two back in the bucket
	out := h.sh(id, `perl -MIO::Socket::UNIX -e '
		my $s = IO::Socket::UNIX->new(Peer => "/run/bro/tools.sock") or die "connect: $!\n";
		my $b = "{}";
		print $s "POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ".length($b)."\r\nConnection: close\r\n\r\n$b";
		my $line = <$s>; print $line;'`)
	if !strings.HasPrefix(out, "HTTP/1.1 200") {
		t.Fatalf("from inside the sandbox: %q", out)
	}
	t.Logf("broker from inside the sandbox: %s", strings.TrimSpace(out))
	return true
}

func TestBucket(t *testing.T) {
	b := newBucket(120, time.Minute)
	now := time.Unix(1000, 0)
	for i := 0; i < 120; i++ {
		if !b.take(now) {
			t.Fatalf("request %d refused", i)
		}
	}
	if b.take(now) {
		t.Fatal("request 121 in the same instant taken")
	}
	if !b.take(now.Add(500*time.Millisecond)) || b.take(now.Add(500*time.Millisecond)) {
		t.Fatal("half a second refills one request")
	}
	later := now.Add(10 * time.Minute)
	taken := 0
	for b.take(later) {
		taken++
	}
	if taken != 120 {
		t.Fatalf("after a long pause %d requests, want 120", taken)
	}
}

func TestValidTools(t *testing.T) {
	for _, headers := range []map[string]string{
		{"Authorization": "x"}, {"host": "x"}, {"X-Ok": "a\r\nInjected: 1"}, {"Bad Name": "x"}, {"Content-Type": "x"},
	} {
		if err := validTools(&toolsConfig{URL: "https://a/b", Token: "t", Headers: headers}); err == nil {
			t.Errorf("headers %v taken", headers)
		}
	}
	tools := &toolsConfig{URL: "https://a/b", Token: "t", Headers: map[string]string{"x-bro-sandbox": "sb-1"}}
	if err := validTools(tools); err != nil || tools.Headers["X-Bro-Sandbox"] != "sb-1" {
		t.Fatalf("%v %v", err, tools.Headers)
	}
	for _, token := range []string{"", "a b", "a\nb", strings.Repeat("x", 9000)} {
		if err := validTools(&toolsConfig{URL: "https://a/b", Token: token}); err == nil {
			t.Errorf("token %q taken", fmt.Sprint(len(token)))
		}
	}
}

// A URL in a log line or an error keeps its origin only: a token may sit in a path segment.
func TestRedact(t *testing.T) {
	for raw, want := range map[string]string{
		"https://router.example/api/SECRET/graphql?sig=SECRET": "https://router.example/…",
		"https://user:SECRET@s3.example/":                      "https://s3.example",
		"http://127.0.0.1:9000":                                "http://127.0.0.1:9000",
		"not a url":                                            "<invalid url>",
	} {
		if got := redact(raw); got != want {
			t.Errorf("redact(%q) = %q, want %q", raw, got, want)
		}
	}
}
