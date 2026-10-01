package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const version = "2026-10-01.1"

// API is sandboxd's HTTP interface (sandbox/README.md, "API sandboxd").
type API struct {
	m   *Manager
	now func() time.Time
}

func (a *API) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", a.health)
	routes := map[string]http.HandlerFunc{
		"PUT /v1/sandboxes/{id}":                   a.putSandbox,
		"GET /v1/sandboxes/{id}":                   a.getSandbox,
		"DELETE /v1/sandboxes/{id}":                a.deleteSandbox,
		"POST /v1/sandboxes/{id}/exec":             a.exec,
		"POST /v1/sandboxes/{id}/procs/{pid}/kill": a.killProc,
		"GET /v1/sandboxes/{id}/files":             a.readFile,
		"PUT /v1/sandboxes/{id}/files":             a.writeFile,
		"DELETE /v1/sandboxes/{id}/files":          a.deleteFile,
		"POST /v1/sandboxes/{id}/network":          a.network,
		"POST /v1/sandboxes/{id}/snapshot":         a.snapshot,
		"POST /v1/sandboxes/{id}/stop":             a.stop,
	}
	for pattern, handler := range routes {
		mux.Handle(pattern, a.authorized(handler))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, &apiError{http.StatusNotFound, "not_found", "no such route"})
	})
	return a.logged(mux)
}

// authorized checks the bearer token and the sandbox id before the handler runs.
func (a *API) authorized(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok {
			writeError(w, &apiError{http.StatusUnauthorized, "unauthorized", "a bearer token is required"})
			return
		}
		if err := verifyToken(strings.TrimSpace(token), a.m.cfg.Host, a.m.cfg.keyBytes(), a.now()); err != nil {
			writeError(w, &apiError{http.StatusUnauthorized, "unauthorized", err.Error()})
			return
		}
		if !sandboxIDPattern.MatchString(r.PathValue("id")) {
			writeError(w, badRequest("sandbox id must match [a-z0-9][a-z0-9-]{0,62}"))
			return
		}
		next(w, r)
	})
}

// recorder keeps the status for the request log; Unwrap lets http.ResponseController flush through it.
type recorder struct {
	http.ResponseWriter
	status int
}

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(p)
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// logged writes one line per request (the path only: queries carry file paths, never tokens) and turns
// a panic into a 500 with the reason.
func (a *API) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rec := &recorder{ResponseWriter: w}
		defer func() {
			if failure := recover(); failure != nil {
				if failure == http.ErrAbortHandler {
					a.m.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
						"ms", time.Since(started).Milliseconds(), "aborted", true)
					panic(failure)
				}
				a.m.log.Error("request panicked", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(failure))
				if rec.status == 0 {
					writeError(rec, &apiError{http.StatusInternalServerError, "internal", fmt.Sprint(failure)})
				}
				return
			}
			if r.URL.Path != "/v1/health" {
				a.m.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
					"ms", time.Since(started).Milliseconds())
			}
		}()
		next.ServeHTTP(rec, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		status, data = http.StatusInternalServerError, []byte(`{"error":"internal","message":"encoding failed"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(append(data, '\n'))
}

func writeError(w http.ResponseWriter, err error) {
	var answer *apiError
	if !errors.As(err, &answer) {
		answer = &apiError{http.StatusInternalServerError, "internal", err.Error()}
	}
	writeJSON(w, answer.Status, map[string]string{"error": answer.Code, "message": answer.Message})
}

// readBody reads a request body of at most `limit` bytes; the whole body, so the server notices a client
// that goes away afterwards (its background read starts once the body is consumed).
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &apiError{http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("the body may have at most %d bytes", limit)}
		}
		return nil, badRequest("the body did not arrive whole")
	}
	return body, nil
}

func httpURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != ""
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version": version, "runsc": a.m.runsc, "rootfs": a.m.cfg.RootfsVersion, "sandboxes": a.m.liveCount(),
	})
}

func parsePut(body []byte, defaultMemory int) (putRequest, int, error) {
	var request putRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return request, 0, badRequest("body must be a JSON object: " + err.Error())
	}
	if request.Workspace == "" || len(request.Workspace) > 200 {
		return request, 0, badRequest("workspace must be 1 to 200 characters")
	}
	memory := defaultMemory
	if request.MemoryMB != nil {
		memory = *request.MemoryMB
	}
	if memory < minMemoryMB || memory > maxMemoryMB {
		return request, 0, badRequest(fmt.Sprintf("memoryMb must be %d to %d", minMemoryMB, maxMemoryMB))
	}
	if err := validTools(request.Tools); err != nil {
		return request, 0, err
	}
	snapshot := request.Snapshot
	if snapshot == nil {
		return request, 0, badRequest("snapshot {get, put, key} is required")
	}
	if !httpURL(snapshot.Put) {
		return request, 0, badRequest("snapshot.put must be an http(s) URL")
	}
	if snapshot.Get != nil && *snapshot.Get != "" && !httpURL(*snapshot.Get) {
		return request, 0, badRequest("snapshot.get must be an http(s) URL or null")
	}
	if !hexKeyPattern.MatchString(snapshot.Key) {
		return request, 0, badRequest("snapshot.key must be 64 hex characters")
	}
	return request, memory, nil
}

func (a *API) putSandbox(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(w, r, 1<<20)
	if err != nil {
		writeError(w, err)
		return
	}
	request, memory, err := parsePut(body, a.m.cfg.MemoryMB)
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := a.m.put(r.Context(), r.PathValue("id"), request, memory)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) getSandbox(w http.ResponseWriter, r *http.Request) {
	view, err := a.m.status(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *API) deleteSandbox(w http.ResponseWriter, r *http.Request) {
	if err := a.m.remove(r.Context(), r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) killProc(w http.ResponseWriter, r *http.Request) {
	if err := a.m.killProc(r.PathValue("id"), r.PathValue("pid")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// network: the sandbox has no network but loopback (--network=none); deny-all is what it has already.
func (a *API) network(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(w, r, 64<<10)
	if err != nil {
		writeError(w, err)
		return
	}
	var request struct {
		Policy json.RawMessage `json:"policy"`
	}
	if err := json.Unmarshal(body, &request); err != nil || len(request.Policy) == 0 {
		writeError(w, badRequest(`body must be {"policy": …}`))
		return
	}
	if _, err := a.m.status(r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	if string(request.Policy) != `"deny-all"` {
		writeError(w, &apiError{http.StatusConflict, "unsupported_policy", "sandboxes have no network: only deny-all"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) snapshot(w http.ResponseWriter, r *http.Request) {
	result, err := a.m.snapshot(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) stop(w http.ResponseWriter, r *http.Request) {
	result, err := a.m.stop(r.Context(), r.PathValue("id"), "requested")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
