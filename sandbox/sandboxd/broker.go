package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/textproto"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The tools broker: per sandbox, an HTTP server on <dir>/run/tools.sock, which the sandbox sees as
// /run/bro/tools.sock. The `tools` CLI posts GraphQL to it; sandboxd forwards the body to tools.url with
// the router token the sandbox never holds, and hands the answer back as it is.
const (
	maxBrokerBody   = 25 << 20
	brokerTimeout   = 120 * time.Second
	brokerPerMinute = 120
	// Tool calls of one sandbox in flight at once; the others wait for a slot before their body is read,
	// so a sandbox holds at most brokerParallel × maxBrokerBody of sandboxd's memory.
	brokerParallel = 4
	brokerSlotWait = 30 * time.Second
)

// Headers tools.headers may not set: the broker's own, and what would confuse the upstream request.
var reservedHeaders = map[string]bool{
	"Authorization": true, "Host": true, "Content-Length": true, "Transfer-Encoding": true,
	"Connection": true, "Upgrade": true, "Te": true, "Trailer": true, "Keep-Alive": true,
	"Proxy-Authorization": true, "Proxy-Connection": true, "Content-Type": true,
}

func brokerClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = brokerTimeout
	return &http.Client{
		Transport: transport,
		// The token goes to tools.url and nowhere else.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type broker struct {
	server   *http.Server
	listener net.Listener
	limiter  *bucket
	slots    chan struct{}
	// calls is the context of its upstream requests: closing the broker cancels the ones in flight.
	calls  context.Context
	cancel context.CancelFunc
	closed sync.Once
}

func (m *Manager) startBroker(sb *Sandbox, socket string) (*broker, error) {
	if err := os.Remove(socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	// The sandbox user (uid 1000 in the sandbox) connects to it.
	if err := os.Chmod(socket, 0o666); err != nil {
		listener.Close()
		return nil, err
	}
	b := &broker{listener: listener, limiter: newBucket(brokerPerMinute, time.Minute),
		slots: make(chan struct{}, brokerParallel)}
	b.calls, b.cancel = context.WithCancel(context.Background())
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		configured := sb.rec.Tools != nil
		m.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tools": configured})
	})
	mux.HandleFunc("POST /graphql", func(w http.ResponseWriter, r *http.Request) { m.forward(w, r, sb, b) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &apiError{http.StatusNotFound, "not_found", "the broker serves POST /graphql and GET /health"})
	})
	b.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: brokerTimeout,
		WriteTimeout: brokerTimeout + 30*time.Second, ErrorLog: slog.NewLogLogger(m.log.Handler(), slog.LevelWarn)}
	// Registered whole (its server set): sandboxd's stop shuts down and closes every registered broker.
	m.mu.Lock()
	if m.draining {
		m.mu.Unlock()
		b.cancel()
		listener.Close()
		return nil, errors.New("sandboxd is stopping")
	}
	m.brokers[b] = true
	m.mu.Unlock()
	go b.server.Serve(listener)
	return b, nil
}

func (b *broker) close() {
	b.closed.Do(func() {
		// The connections first: a cancelled call's 502 does not reach a client that waits for the answer.
		b.server.Close()
		b.cancel()
	})
}

// shutdownBrokers is the brokers' part of sandboxd's stop: they take no new tool calls, and the ones in
// flight get until ctx ends. False when some were still running then.
func (m *Manager) shutdownBrokers(ctx context.Context) bool {
	m.mu.Lock()
	brokers := make([]*broker, 0, len(m.brokers))
	for b := range m.brokers {
		brokers = append(brokers, b)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	var open atomic.Bool
	for _, b := range brokers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b.server.Shutdown(ctx) != nil {
				open.Store(true)
			}
		}()
	}
	wg.Wait()
	return !open.Load()
}

// closeBrokers ends the brokers for good when sandboxd stops: tool calls still in flight are cancelled
// (their upstream requests with them), no broker starts and no tool call begins after it; m.toolCalls
// then counts down to the calls that have not finished their cleanup.
func (m *Manager) closeBrokers() {
	m.mu.Lock()
	m.draining = true
	brokers := make([]*broker, 0, len(m.brokers))
	for b := range m.brokers {
		brokers = append(brokers, b)
	}
	m.mu.Unlock()
	for _, b := range brokers {
		b.close()
	}
}

func (m *Manager) forward(w http.ResponseWriter, r *http.Request, sb *Sandbox, b *broker) {
	started := time.Now()
	m.mu.Lock()
	tools := sb.rec.Tools
	draining := m.draining
	if !draining {
		m.toolCalls.Add(1)
	}
	m.mu.Unlock()
	if draining {
		w.Header().Set("Retry-After", "5")
		writeError(w, &apiError{http.StatusServiceUnavailable, "tools_unavailable", "sandboxd is restarting"})
		return
	}
	defer m.toolCalls.Done()
	if tools == nil {
		writeError(w, &apiError{http.StatusServiceUnavailable, "tools_unavailable", "this sandbox has no tool router"})
		return
	}
	if !b.limiter.take(time.Now()) {
		w.Header().Set("Retry-After", "1")
		writeError(w, &apiError{http.StatusTooManyRequests, "rate_limited",
			"at most 120 tool requests a minute per sandbox"})
		return
	}
	// A call that waits past brokerSlotWait gets 429 busy (not rate_limited: that is the bucket's): the CLI
	// says "retry", where a longer wait would end in its own timeout or in this server's ReadTimeout.
	wait := time.NewTimer(brokerSlotWait)
	defer wait.Stop()
	select {
	case b.slots <- struct{}{}:
		defer func() { <-b.slots }()
	case <-wait.C:
		w.Header().Set("Retry-After", "5")
		writeError(w, &apiError{http.StatusTooManyRequests, "busy",
			"at most 4 tool requests at once per sandbox, and the others have waited 30 s"})
		return
	case <-r.Context().Done():
		return
	}
	// A tool call is work in the sandbox: the idle reaper leaves it running until the answer is back.
	running, err := m.begin(sb.id)
	if err != nil {
		writeError(w, err) // 409 sandbox_stopped, as everywhere in the API
		return
	}
	defer m.end(running)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBrokerBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, &apiError{http.StatusRequestEntityTooLarge, "too_large", "a request may have at most 25 MiB"})
			return
		}
		writeError(w, badRequest("the body did not arrive whole"))
		return
	}
	// Not the connection's context: a client that half-closes its side after the request must still get
	// the answer. Closing the broker (teardown, sandboxd's stop) cancels it.
	ctx, cancel := context.WithTimeout(b.calls, brokerTimeout)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, tools.URL, bytes.NewReader(body))
	if err != nil {
		writeError(w, &apiError{http.StatusBadGateway, "upstream_failed", "tools.url is not a valid URL"})
		return
	}
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	upstream.Header.Set("Content-Type", contentType)
	if accept := r.Header.Get("Accept"); accept != "" {
		upstream.Header.Set("Accept", accept)
	}
	for name, value := range tools.Headers {
		upstream.Header.Set(name, value)
	}
	upstream.Header.Set("Authorization", "Bearer "+tools.Token)
	response, err := m.upstream.Do(upstream)
	if err != nil {
		status, code := http.StatusBadGateway, "upstream_failed"
		if errors.Is(err, context.DeadlineExceeded) {
			status, code = http.StatusGatewayTimeout, "upstream_timeout"
		}
		m.log.Warn("tool request failed", "sandbox", sb.id, "url", redact(tools.URL), "error", redactError(err))
		writeError(w, &apiError{status, code, "the tool router did not answer"})
		return
	}
	defer response.Body.Close()
	for _, name := range []string{"Content-Type", "Retry-After"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, copyErr := io.Copy(w, response.Body)
	attributes := []any{"sandbox", sb.id, "status", response.StatusCode, "ms", time.Since(started).Milliseconds()}
	if copyErr != nil {
		attributes = append(attributes, "error", redactError(copyErr))
	}
	m.log.Info("tool request", attributes...)
}

// validTools checks tools from a PUT body.
func validTools(tools *toolsConfig) error {
	if tools == nil {
		return nil
	}
	if !httpURL(tools.URL) {
		return badRequest("tools.url must be an http(s) URL")
	}
	if tools.Token == "" || len(tools.Token) > 8192 || strings.ContainsAny(tools.Token, "\r\n\x00 ") {
		return badRequest("tools.token must be a non-empty token")
	}
	if len(tools.Headers) > 32 {
		return badRequest("tools.headers may have at most 32 entries")
	}
	canonical := make(map[string]string, len(tools.Headers))
	for name, value := range tools.Headers {
		key := textproto.CanonicalMIMEHeaderKey(name)
		if !headerName(name) || reservedHeaders[key] || strings.ContainsAny(value, "\r\n\x00") || len(value) > 8192 {
			return badRequest("tools.headers has an invalid or reserved header: " + name)
		}
		canonical[key] = value
	}
	tools.Headers = canonical
	return nil
}

func headerName(name string) bool {
	if name == "" {
		return false
	}
	for _, c := range name {
		if c > 127 || !(c == '-' || c == '_' || c == '.' || c == '!' || c == '#' || c == '$' || c == '%' ||
			c == '&' || c == '\'' || c == '*' || c == '+' || c == '^' || c == '`' || c == '|' || c == '~' ||
			('0' <= c && c <= '9') || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')) {
			return false
		}
	}
	return true
}

// bucket is a token bucket: `capacity` requests at once, refilled at capacity per `period`.
type bucket struct {
	mu       sync.Mutex
	capacity float64
	rate     float64 // tokens per second
	tokens   float64
	last     time.Time
}

func newBucket(capacity int, period time.Duration) *bucket {
	return &bucket{capacity: float64(capacity), rate: float64(capacity) / period.Seconds(), tokens: float64(capacity)}
}

func (b *bucket) take(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.last.IsZero() {
		b.tokens = min(b.capacity, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
