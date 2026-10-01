package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultExecTimeout = 10 * time.Minute
	maxExecTimeout     = time.Hour
	maxExecBody        = 32 << 20
	maxExecEnv         = 256
	// markerEnv is in the environment of every process sandboxd starts in a sandbox, with a value of its
	// own per exec. Killing an exec kills every process of the sandbox that carries its value: the command,
	// its children and whatever they left running in the background, also after a double fork or setsid.
	markerEnv = "BRO_EXEC_ID"
	// runscFailed is runsc's exit status when it fails itself (no such container, a dead sandbox).
	runscFailed = 128
)

var (
	envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	errTimedOut    = errors.New("the command timed out")
	errKilled      = errors.New("the command was killed")
	errClientGone  = errors.New("the client went away")
)

// killScript runs in the sandbox as the sandbox user with the marker as $1. It reads /proc/<pid>/environ
// (gVisor has it) with bash builtins only, and goes round again until a round finds no marked process: a
// process may fork while a round runs. Zombies are dead already and skipped; killMarked's timeout bounds
// the rounds.
const killScript = `m="` + markerEnv + `=$1"
while :; do
  hit=
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    [ "$p" = "$$" ] && continue
    s=
    read -r s 2>/dev/null < "$d/stat" || continue
    s=${s##*) }
    [ "${s%% *}" = Z ] && continue
    while IFS= read -r -d '' e; do
      if [ "$e" = "$m" ]; then kill -9 "$p" 2>/dev/null && hit=1; break; fi
    done 2>/dev/null < "$d/environ"
  done
  [ -n "$hit" ] || exit 0
done`

// command prepares a process in the sandbox with a marker of its own; when ctx ends before the process
// does, every process carrying the marker is killed in the sandbox and then the runsc exec client.
func (m *Manager) command(ctx context.Context, id string, spec ExecSpec) *exec.Cmd {
	marker := m.newMarker()
	spec.Env = append(append([]string{}, spec.Env...), markerEnv+"="+marker)
	cmd := m.rt.Exec(ctx, id, spec)
	cmd.Cancel = func() error {
		m.killMarked(id, marker)
		return cmd.Process.Kill()
	}
	// Background processes may keep stdout open after the command ends: two seconds, then the pipes close.
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func (m *Manager) newMarker() string {
	return fmt.Sprintf("%s-%d", m.instance, m.seq.Add(1))
}

// killMarked kills every process in the sandbox that carries the marker.
func (m *Manager) killMarked(id, marker string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := m.rt.Exec(ctx, id, ExecSpec{User: sandboxUser, Cwd: "/", Argv: []string{"/bin/bash", "-c", killScript, "bash", marker}})
	cmd.WaitDelay = time.Second
	if out, err := cmd.CombinedOutput(); err != nil {
		m.log.Warn("kill in sandbox failed", "sandbox", id, "error", err.Error(), "output", lastLine(string(out)))
	}
}

// exitCode is the exit status of a process as a shell reports it: 128+n when signal n ended it.
func exitCode(state *os.ProcessState) (int, bool) {
	if state == nil {
		return 0, false
	}
	if state.Exited() {
		return state.ExitCode(), true
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal()), true
	}
	return 0, false
}

type execRequest struct {
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMS *int64            `json:"timeoutMs"`
	Stdin     *string           `json:"stdin"`
}

// event is one NDJSON line of an exec stream.
type event struct {
	Type    string `json:"type"`
	PID     string `json:"pid,omitempty"`
	Data    []byte `json:"data,omitempty"` // base64 in JSON
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// proc is a running exec, for POST /procs/{pid}/kill.
type proc struct {
	cancel context.CancelCauseFunc
	done   chan struct{}
}

func parseExec(body []byte) (execRequest, []string, []byte, time.Duration, error) {
	var request execRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return request, nil, nil, 0, badRequest("body must be a JSON object: " + err.Error())
	}
	if strings.TrimSpace(request.Command) == "" || strings.IndexByte(request.Command, 0) >= 0 {
		return request, nil, nil, 0, badRequest("command must be a non-empty string without NUL bytes")
	}
	if request.Cwd == "" {
		request.Cwd = snapshotWorkspace
	}
	cwd, err := sandboxPath(request.Cwd)
	if err != nil {
		return request, nil, nil, 0, badRequest("cwd: " + err.Error())
	}
	request.Cwd = cwd
	if len(request.Env) > maxExecEnv {
		return request, nil, nil, 0, badRequest(fmt.Sprintf("env may have at most %d variables", maxExecEnv))
	}
	env := make([]string, 0, len(request.Env))
	for name, value := range request.Env {
		if !envNamePattern.MatchString(name) || strings.IndexByte(value, 0) >= 0 {
			return request, nil, nil, 0, badRequest("env names must match [A-Za-z_][A-Za-z0-9_]* and values have no NUL bytes")
		}
		if name != markerEnv {
			env = append(env, name+"="+value)
		}
	}
	timeout := defaultExecTimeout
	if request.TimeoutMS != nil {
		if *request.TimeoutMS <= 0 {
			return request, nil, nil, 0, badRequest("timeoutMs must be positive")
		}
		// Clamped in milliseconds: a huge value would overflow time.Duration and fire at once.
		timeout = time.Duration(min(*request.TimeoutMS, maxExecTimeout.Milliseconds())) * time.Millisecond
	}
	var stdin []byte
	if request.Stdin != nil {
		if stdin, err = base64.StdEncoding.DecodeString(*request.Stdin); err != nil {
			return request, nil, nil, 0, badRequest("stdin must be base64")
		}
	}
	return request, env, stdin, timeout, nil
}

// exec runs `bash -lc <command>` as the sandbox user and streams NDJSON events: start, stdout and stderr
// chunks as they come, then exit (124 on timeout) or error. The command dies with the stream.
func (a *API) exec(w http.ResponseWriter, r *http.Request) {
	m := a.m
	id := r.PathValue("id")
	body, err := readBody(w, r, maxExecBody)
	if err != nil {
		writeError(w, err)
		return
	}
	request, env, stdin, timeout, err := parseExec(body)
	if err != nil {
		writeError(w, err)
		return
	}
	sb, err := m.begin(id)
	if err != nil {
		writeError(w, err)
		return
	}
	defer m.end(sb)

	ctx, cancel := context.WithCancelCause(r.Context())
	defer cancel(nil)
	timer := time.AfterFunc(timeout, func() { cancel(errTimedOut) })
	defer timer.Stop()
	cmd := m.command(ctx, id, ExecSpec{User: sandboxUser, Cwd: request.Cwd, Env: env,
		Argv: []string{"/bin/bash", "-lc", request.Command}})
	// No stdin in the request: /dev/null, so a command that reads stdin sees its end at once.
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	stream := &eventStream{w: w, rc: http.NewResponseController(w), onFail: func() { cancel(errClientGone) }}
	cmd.Stdout = streamWriter{stream, "stdout"}
	cmd.Stderr = streamWriter{stream, "stderr"}
	// Output may come before the start line is out: os/exec copies from the moment the process starts, and
	// the copies wait on the stream's lock until the headers and the start event are written.
	stream.mu.Lock()
	if err := cmd.Start(); err != nil {
		stream.mu.Unlock()
		writeError(w, &apiError{http.StatusBadGateway, "exec_failed", "runsc exec did not start: " + err.Error()})
		return
	}
	pid := fmt.Sprintf("p%d", m.pids.Add(1))
	running := &proc{cancel: cancel, done: make(chan struct{})}
	m.register(sb, pid, running)
	defer func() {
		m.unregister(sb, pid)
		close(running.done)
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	stream.sendLocked(event{Type: "start", PID: pid})
	stream.keepAlive(m.pingEvery)
	stream.mu.Unlock()
	defer stream.finish(nil)
	started := time.Now()
	waitErr := cmd.Wait()
	cause := context.Cause(ctx)
	code, exited := exitCode(cmd.ProcessState)
	switch {
	case errors.Is(cause, errTimedOut):
		code, exited = 124, true
	case errors.Is(cause, errKilled) && !exited:
		code, exited = 137, true
	}
	logged := []any{"sandbox", id, "pid", pid, "ms", time.Since(started).Milliseconds()}
	// 128 is runsc's own failure (its message is in stderr): a container that died meanwhile is told as
	// such, not as a command that failed.
	died := exited && code == runscFailed && cause == nil && m.confirmDead(sb)
	switch {
	case died:
		stream.finish(&event{Type: "error", Message: "sandbox_stopped: " + m.stopped(sb).Message})
		m.log.Warn("exec ended: the sandbox died", logged...)
	case errors.Is(cause, errClientGone) || r.Context().Err() != nil:
		m.log.Info("exec ended: client went away", logged...)
	case exited:
		stream.finish(&event{Type: "exit", Code: &code})
		m.log.Info("exec ended", append(logged, "code", code)...)
	default:
		message := "the command ended without an exit status"
		if waitErr != nil {
			message = waitErr.Error()
		}
		stream.finish(&event{Type: "error", Message: message})
		m.log.Warn("exec failed", append(logged, "error", message)...)
	}
}

// eventStream writes NDJSON lines, flushing each one; once a write fails (the client is gone) it calls
// onFail and drops the rest. Between start and the last line it writes {"type":"ping"} whenever nothing
// else was written for `every`.
type eventStream struct {
	mu     sync.Mutex
	w      io.Writer
	rc     *http.ResponseController
	onFail func()
	failed bool
	done   bool
	every  time.Duration
	idle   *time.Timer
}

// keepAlive starts the pings; the caller holds the lock.
func (s *eventStream) keepAlive(every time.Duration) {
	s.every = every
	s.idle = time.AfterFunc(every, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.done {
			s.sendLocked(event{Type: "ping"})
		}
	})
}

// finish writes the last line, if any, and ends the pings with it: nothing follows it.
func (s *eventStream) finish(last *event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	if last != nil {
		s.sendLocked(*last)
	}
	s.done = true
	if s.idle != nil {
		s.idle.Stop()
	}
}

func (s *eventStream) send(e event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sendLocked(e)
}

func (s *eventStream) sendLocked(e event) error {
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if s.failed || s.done {
		return errClientGone
	}
	// A client that stops reading fails the write in time instead of blocking it (and the output copy,
	// and the command's end) forever.
	s.rc.SetWriteDeadline(time.Now().Add(writeStall))
	_, err = s.w.Write(append(line, '\n'))
	if err == nil {
		err = s.rc.Flush()
	}
	if err == nil && s.idle != nil {
		s.idle.Reset(s.every)
	}
	if err != nil {
		s.failed = true
		s.onFail()
		return errClientGone
	}
	return nil
}

type streamWriter struct {
	stream *eventStream
	kind   string
}

func (sw streamWriter) Write(p []byte) (int, error) {
	if err := sw.stream.send(event{Type: sw.kind, Data: p}); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (m *Manager) register(sb *Sandbox, pid string, p *proc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if sb.procs == nil {
		sb.procs = map[string]*proc{}
	}
	sb.procs[pid] = p
}

func (m *Manager) unregister(sb *Sandbox, pid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(sb.procs, pid)
}

// killProc kills a running exec and waits for its stream to end. Idempotent: an exec that has ended (or
// never was) is fine.
func (m *Manager) killProc(id, pid string) error {
	m.mu.Lock()
	sb := m.sandboxes[id]
	if sb == nil || sb.rec.State != stateRunning {
		m.mu.Unlock()
		return nil // no sandbox, no process
	}
	running := sb.procs[pid]
	m.mu.Unlock()
	if running == nil {
		return nil
	}
	running.cancel(errKilled)
	select {
	case <-running.done:
	case <-time.After(30 * time.Second):
		m.log.Warn("killed exec did not end", "sandbox", id, "pid", pid)
	}
	return nil
}

// tail keeps the last 4 KiB written to it: a process's stderr for an error message.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 4096 {
		t.buf = append([]byte{}, t.buf[len(t.buf)-4096:]...)
	}
	return len(p), nil
}

func (t *tail) text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.buf))
}
