package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// state.json keeps the records across sandboxd restarts: sandboxes outlive sandboxd (their runsc processes
// sit in cgroups of their own, and the unit stops only sandboxd's main process), and a new sandboxd adopts
// the ones that still run.
type stateFile struct {
	Sandboxes []record `json:"sandboxes"`
}

var sandboxIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// save writes every record but the absent ones, atomically; the file holds secrets (0600).
func (m *Manager) save() {
	m.saveMu.Lock()
	defer m.saveMu.Unlock()
	m.mu.Lock()
	state := stateFile{Sandboxes: []record{}}
	for _, sb := range m.sandboxes {
		if sb.rec.State != stateAbsent {
			state.Sandboxes = append(state.Sandboxes, sb.rec)
		}
	}
	m.dirty = false
	m.mu.Unlock()
	sort.Slice(state.Sandboxes, func(i, j int) bool { return state.Sandboxes[i].ID < state.Sandboxes[j].ID })
	if err := writeFileAtomic(m.cfg.statePath(), state); err != nil {
		// The next reaper tick tries again: a stale state.json would have a restart delete a live container.
		m.mu.Lock()
		m.dirty = true
		m.mu.Unlock()
		m.log.Error("writing state.json failed: retrying on the next tick", "error", err.Error())
	}
}

func writeFileAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".state-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

// prepare makes sandboxd's directories and empties staging (snapshots a crash left behind).
func (m *Manager) prepare() error {
	if err := os.MkdirAll(m.cfg.Root, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(m.cfg.Root, 0o700); err != nil {
		return err
	}
	for _, dir := range []string{m.cfg.sandboxesDir(), m.cfg.stagingDir(), filepath.Dir(m.cfg.rootfsDir())} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(m.cfg.stagingDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		os.RemoveAll(filepath.Join(m.cfg.stagingDir(), entry.Name()))
	}
	return nil
}

// reconcile loads state.json and squares it with what runsc runs: records whose container runs are
// adopted (their broker socket made anew), records whose container is gone are marked stopped, a record
// that was starting when sandboxd died loses its container (its restore may be half done), and containers
// without a record are deleted (no key, no snapshot target: nothing can be saved of them).
func (m *Manager) reconcile(ctx context.Context) error {
	var state stateFile
	data, err := os.ReadFile(m.cfg.statePath())
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	default:
		if err := json.Unmarshal(data, &state); err != nil {
			return err
		}
	}
	running, err := m.rt.List(ctx)
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, rec := range state.Sandboxes {
		if !sandboxIDPattern.MatchString(rec.ID) {
			continue
		}
		known[rec.ID] = true
		sb := &Sandbox{id: rec.ID, rec: rec}
		m.mu.Lock()
		m.sandboxes[rec.ID] = sb
		m.mu.Unlock()
		status := running[rec.ID]
		switch {
		case rec.State == stateRunning && status == "running":
			// Without its broker the sandbox is still adopted: its /workspace lives only in its memory. The
			// next PUT, which Bro sends before it uses a sandbox, starts the broker again.
			b, err := m.startBroker(sb, m.cfg.paths(rec.ID).socket)
			if err != nil {
				m.log.Error("adopted sandbox has no broker until its next PUT", "sandbox", rec.ID, "error", err.Error())
			}
			state, _ := m.rt.State(ctx, rec.ID)
			m.mu.Lock()
			sb.broker = b
			sb.sentry = identify(m.procfs, state.PID)
			// Idle time counts from now: sandboxd itself was away.
			sb.rec.LastUsedAt = time.Now().UTC()
			m.mu.Unlock()
			m.log.Info("sandbox adopted", "sandbox", rec.ID)
		case rec.State == stateRunning || rec.State == stateStarting:
			reason := "the container was gone when sandboxd started"
			if rec.State == stateStarting {
				reason = "sandboxd stopped while the sandbox was starting"
			}
			if err := m.teardown(ctx, sb); err != nil {
				m.log.Error("cleanup of a lost sandbox failed", "sandbox", rec.ID, "error", err.Error())
				continue
			}
			m.markStopped(sb, reason)
			m.log.Warn("sandbox lost", "sandbox", rec.ID, "reason", reason)
		case status != "":
			// A stopped sandbox whose container outlived a failed delete.
			if err := m.teardown(ctx, sb); err != nil {
				m.log.Error("deleting a stopped sandbox's container failed", "sandbox", rec.ID, "error", err.Error())
			}
		}
	}
	for id := range running {
		if known[id] || !sandboxIDPattern.MatchString(id) {
			continue
		}
		m.log.Warn("deleting a container without a record", "sandbox", id)
		if err := m.teardown(ctx, &Sandbox{id: id}); err != nil {
			m.log.Error("deleting a container without a record failed", "sandbox", id, "error", err.Error())
		}
	}
	m.save()
	return nil
}
