package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
)

// Files are read, written and removed by processes in the sandbox (runsc exec as the sandbox user), never
// through the host's view of its directories: a symlink the sandbox made cannot lead sandboxd out of it.
// The path goes in $P and never into the script text.
const (
	maxFileBytes = 512 << 20
	fileTimeout  = 30 * time.Minute
	// exit status of the scripts for "no such file": cat and rm never exit with it.
	exitNotFound = 44

	readScript  = `if [ -f "$P" ]; then exec cat -- "$P"; else exit 44; fi`
	writeScript = `mkdir -p -- "$(dirname -- "$P")" && exec cat > "$P"`
)

func deleteScript(recursive, force bool) string {
	flags := ""
	if recursive {
		flags += "r"
	}
	if force {
		flags += "f"
	}
	rm := `exec rm -- "$P"`
	if flags != "" {
		rm = `exec rm -` + flags + ` -- "$P"`
	}
	if force {
		return rm
	}
	return `if [ ! -e "$P" ] && [ ! -L "$P" ]; then exit 44; fi; ` + rm
}

// sandboxPath validates a path inside the sandbox: absolute, no NUL bytes, cleaned.
func sandboxPath(value string) (string, error) {
	switch {
	case value == "":
		return "", errors.New("path is required")
	case !strings.HasPrefix(value, "/"):
		return "", errors.New("path must be absolute")
	case strings.IndexByte(value, 0) >= 0:
		return "", errors.New("path must not contain NUL bytes")
	case len(value) > 4096:
		return "", errors.New("path is too long")
	}
	return path.Clean(value), nil
}

func (a *API) filePath(r *http.Request, root bool) (string, error) {
	p, err := sandboxPath(r.URL.Query().Get("path"))
	if err != nil {
		return "", badRequest(err.Error())
	}
	if p == "/" && !root {
		return "", badRequest("path must not be /")
	}
	return p, nil
}

func (a *API) readFile(w http.ResponseWriter, r *http.Request) {
	m := a.m
	id := r.PathValue("id")
	p, err := a.filePath(r, true)
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
	ctx, cancel := context.WithTimeout(r.Context(), fileTimeout)
	defer cancel()
	cmd := m.command(ctx, id, ExecSpec{User: sandboxUser, Cwd: "/", Env: []string{"P=" + p},
		Argv: []string{"/bin/bash", "-c", readScript}})
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, err)
		return
	}
	stderr := &tail{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		writeError(w, &apiError{http.StatusBadGateway, "exec_failed", "runsc exec did not start: " + err.Error()})
		return
	}
	// The status line waits for the first byte or the end: an empty file, a missing one and a failure
	// differ only in the exit status.
	reader := bufio.NewReaderSize(stdout, 64<<10)
	if _, peek := reader.Peek(1); peek != nil {
		cmd.Wait()
		switch code, _ := exitCode(cmd.ProcessState); code {
		case 0:
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusOK)
		case exitNotFound:
			writeError(w, &apiError{http.StatusNotFound, "not_found", "no such file: " + p})
		default:
			writeError(w, m.failure(sb, code, &apiError{http.StatusInternalServerError, "read_failed", fallback(stderr.text(), "cat failed")}))
		}
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, copyErr := io.Copy(w, reader)
	cmd.Wait()
	if code, _ := exitCode(cmd.ProcessState); copyErr != nil || code != 0 {
		// The status is out already: break the chunked body off, so the client sees a failed transfer
		// rather than a short file.
		m.log.Warn("file read broke off", "sandbox", id, "code", code, "stderr", lastLine(stderr.text()))
		panic(http.ErrAbortHandler)
	}
}

func (a *API) writeFile(w http.ResponseWriter, r *http.Request) {
	m := a.m
	id := r.PathValue("id")
	p, err := a.filePath(r, false)
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
	ctx, cancel := context.WithTimeout(r.Context(), fileTimeout)
	defer cancel()
	cmd := m.command(ctx, id, ExecSpec{User: sandboxUser, Cwd: "/", Env: []string{"P=" + p},
		Argv: []string{"/bin/bash", "-c", writeScript}})
	body := &firstError{r: http.MaxBytesReader(w, r.Body, maxFileBytes)}
	stderr := &tail{}
	cmd.Stdin, cmd.Stderr = body, stderr
	cmd.Run()
	var tooLarge *http.MaxBytesError
	switch code, ok := exitCode(cmd.ProcessState); {
	case errors.As(body.err, &tooLarge):
		writeError(w, &apiError{http.StatusRequestEntityTooLarge, "too_large", "a file may have at most 512 MiB"})
	case body.err != nil:
		writeError(w, badRequest("the body did not arrive whole: "+body.err.Error()))
	case !ok:
		writeError(w, &apiError{http.StatusBadGateway, "exec_failed", "the write did not finish"})
	case code != 0:
		writeError(w, m.failure(sb, code, &apiError{http.StatusConflict, "write_failed", fallback(stderr.text(), "the write failed")}))
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *API) deleteFile(w http.ResponseWriter, r *http.Request) {
	m := a.m
	id := r.PathValue("id")
	p, err := a.filePath(r, false)
	if err != nil {
		writeError(w, err)
		return
	}
	query := r.URL.Query()
	recursive, force := queryFlag(query.Get("recursive")), queryFlag(query.Get("force"))
	sb, err := m.begin(id)
	if err != nil {
		writeError(w, err)
		return
	}
	defer m.end(sb)
	ctx, cancel := context.WithTimeout(r.Context(), fileTimeout)
	defer cancel()
	cmd := m.command(ctx, id, ExecSpec{User: sandboxUser, Cwd: "/", Env: []string{"P=" + p},
		Argv: []string{"/bin/bash", "-c", deleteScript(recursive, force)}})
	stderr := &tail{}
	cmd.Stderr = stderr
	cmd.Run()
	switch code, ok := exitCode(cmd.ProcessState); {
	case !ok:
		writeError(w, &apiError{http.StatusBadGateway, "exec_failed", "the removal did not finish"})
	case code == exitNotFound:
		writeError(w, &apiError{http.StatusNotFound, "not_found", "no such path: " + p})
	case code != 0:
		writeError(w, m.failure(sb, code, &apiError{http.StatusConflict, "delete_failed", fallback(stderr.text(), "rm failed")}))
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// failure is the answer to a file operation that exited with `code`: runsc's own failure in a container
// that died is sandbox_stopped, anything else the operation's error.
func (m *Manager) failure(sb *Sandbox, code int, otherwise *apiError) *apiError {
	if code == runscFailed && m.confirmDead(sb) {
		return m.stopped(sb)
	}
	return otherwise
}

func queryFlag(value string) bool {
	return value == "1" || value == "true"
}

func fallback(text, otherwise string) string {
	if text == "" {
		return otherwise
	}
	return lastLine(text)
}
