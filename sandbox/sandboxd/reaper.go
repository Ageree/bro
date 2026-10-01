package main

import (
	"context"
	"time"
)

// How long a stopped record (without secrets) stays in state.json for the record.
const stoppedRecordTTL = 24 * time.Hour

// reaper runs reap every `every` until ctx ends.
func (m *Manager) reaper(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reap(ctx, time.Now())
		}
	}
}

// reap snapshots and stops sandboxes idle past idle_minutes (a failed snapshot leaves the sandbox running
// for the next tick), notices containers that died on their own (an OOM kill takes the whole sandbox),
// prunes old stopped records, forgets absent entries nobody holds (a DELETE of an unknown id makes one)
// and writes state.json when lastUsedAt moved or an earlier write failed.
func (m *Manager) reap(ctx context.Context, now time.Time) {
	m.notice(ctx)
	var idle []*Sandbox
	m.mu.Lock()
	for id, sb := range m.sandboxes {
		switch {
		case sb.rec.State == stateRunning && sb.active == 0 && now.Sub(sb.rec.LastUsedAt) > m.idleAfter:
			idle = append(idle, sb)
		case sb.rec.State == stateStopped && now.Sub(sb.rec.StoppedAt) > stoppedRecordTTL:
			sb.rec = record{ID: sb.id, State: stateAbsent}
			m.dirty = true
		case sb.rec.State == stateAbsent && sb.held == 0 && sb.active == 0 && len(sb.procs) == 0:
			delete(m.sandboxes, id)
		}
	}
	m.mu.Unlock()
	for _, sb := range idle {
		if !sb.op.TryLock() {
			continue // busy with a PUT, snapshot or stop: not idle
		}
		// Still idle, and from here on no request starts (stopping) until the stop is done.
		m.mu.Lock()
		still := sb.rec.State == stateRunning && sb.active == 0 && now.Sub(sb.rec.LastUsedAt) > m.idleAfter
		sb.stopping = still
		m.mu.Unlock()
		if still {
			if _, err := m.stopLocked(ctx, sb, "idle"); err != nil {
				m.log.Warn("idle sandbox not stopped: retrying next tick", "sandbox", sb.id, "error", err.Error())
			}
		}
		sb.op.Unlock()
	}
	m.mu.Lock()
	dirty := m.dirty
	m.mu.Unlock()
	if dirty {
		m.save()
	}
}

// notice marks running sandboxes whose container is no longer running as stopped.
func (m *Manager) notice(ctx context.Context) {
	statuses, err := m.rt.List(ctx)
	if err != nil {
		m.log.Warn("runsc list failed", "error", err.Error())
		return
	}
	var dead []*Sandbox
	m.mu.Lock()
	for id, sb := range m.sandboxes {
		if sb.rec.State == stateRunning && statuses[id] != "running" {
			dead = append(dead, sb)
		}
	}
	m.mu.Unlock()
	for _, sb := range dead {
		if !sb.op.TryLock() {
			continue
		}
		if m.runningLocked(sb) {
			m.deadLocked(ctx, sb)
		}
		sb.op.Unlock()
	}
}
