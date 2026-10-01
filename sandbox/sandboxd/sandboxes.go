package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	stateStarting = "starting"
	stateRunning  = "running"
	stateStopped  = "stopped"
	// absent: deleted, or a stopped record pruned; kept in memory only, never written to state.json.
	stateAbsent = "absent"

	startTimeout = 15 * time.Minute
)

// record is what sandboxd keeps of a sandbox in state.json. Tools and Snapshot hold secrets (the router
// token, the snapshot key, a presigned PUT): state.json is 0600 under a 0700 directory, and they are
// dropped once the sandbox stops.
type record struct {
	ID            string          `json:"id"`
	Workspace     string          `json:"workspace"`
	State         string          `json:"state"`
	MemoryMB      int             `json:"memoryMb"`
	RootfsVersion string          `json:"rootfsVersion"`
	CreatedAt     time.Time       `json:"createdAt"`
	LastUsedAt    time.Time       `json:"lastUsedAt"`
	StoppedAt     time.Time       `json:"stoppedAt,omitzero"`
	StopReason    string          `json:"stopReason,omitempty"`
	Tools         *toolsConfig    `json:"tools,omitempty"`
	Snapshot      *snapshotTarget `json:"snapshot,omitempty"`
}

type toolsConfig struct {
	URL     string            `json:"url"`
	Token   string            `json:"token"`
	Headers map[string]string `json:"headers,omitempty"`
}

type snapshotTarget struct {
	Put string `json:"put"`
	Key string `json:"key"`
}

// Sandbox is one id's entry. Entries are never removed from Manager.sandboxes while sandboxd runs, so a
// pointer to one stays the only one for its id.
type Sandbox struct {
	id string
	// op serializes what changes the container: create, snapshot, stop, delete.
	op sync.Mutex

	// Guarded by Manager.mu.
	rec    record
	broker *broker
	procs  map[string]*proc
	active int // requests running in it (exec streams, file operations): an active sandbox is not idle
}

type Manager struct {
	cfg      Config
	rt       Runtime
	log      *slog.Logger
	s3       *http.Client
	upstream *http.Client
	// memTotalMB is MemTotal of /proc/meminfo; a test puts its own in.
	memTotalMB func() (int, error)
	idleAfter  time.Duration
	instance   string // per process: exec markers of an earlier sandboxd never match
	seq        atomic.Uint64
	pids       atomic.Uint64
	runsc      string // runsc --version, for /v1/health

	mu        sync.Mutex
	sandboxes map[string]*Sandbox
	dirty     bool // lastUsedAt moved since state.json was written
	saveMu    sync.Mutex
}

func newManager(config Config, runtime Runtime, log *slog.Logger) *Manager {
	instance := make([]byte, 6)
	rand.Read(instance)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 2 * time.Minute
	return &Manager{
		cfg:        config,
		rt:         runtime,
		log:        log,
		s3:         &http.Client{Transport: transport},
		upstream:   brokerClient(),
		memTotalMB: memTotalMB,
		idleAfter:  time.Duration(config.IdleMinutes) * time.Minute,
		instance:   hex.EncodeToString(instance),
		sandboxes:  map[string]*Sandbox{},
	}
}

// apiError is an answer other than success: {"error": code, "message": message}.
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func badRequest(message string) *apiError {
	return &apiError{http.StatusBadRequest, "bad_request", message}
}

func notFound(id string) *apiError {
	return &apiError{http.StatusNotFound, "not_found", "no running sandbox " + id}
}

// entry is the sandbox's entry, made (absent) when the id is new.
func (m *Manager) entry(id string) *Sandbox {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb := m.sandboxes[id]
	if sb == nil {
		sb = &Sandbox{id: id, rec: record{ID: id, State: stateAbsent}}
		m.sandboxes[id] = sb
	}
	return sb
}

func (m *Manager) lookup(id string) *Sandbox {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sandboxes[id]
}

// begin marks a request in a running sandbox (it is not idle while one runs); end undoes it.
func (m *Manager) begin(id string) (*Sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb := m.sandboxes[id]
	if sb == nil || sb.rec.State != stateRunning {
		return nil, notFound(id)
	}
	sb.active++
	sb.rec.LastUsedAt, m.dirty = time.Now().UTC(), true
	return sb, nil
}

func (m *Manager) end(sb *Sandbox) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb.active--
	sb.rec.LastUsedAt, m.dirty = time.Now().UTC(), true
}

func (m *Manager) touch(sb *Sandbox) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb.rec.LastUsedAt, m.dirty = time.Now().UTC(), true
}

type putRequest struct {
	Workspace string       `json:"workspace"`
	MemoryMB  *int         `json:"memoryMb"`
	Tools     *toolsConfig `json:"tools"`
	Snapshot  *struct {
		Get *string `json:"get"`
		Put string  `json:"put"`
		Key string  `json:"key"`
	} `json:"snapshot"`
}

type putResult struct {
	ID       string `json:"id"`
	State    string `json:"state"`
	Created  bool   `json:"created"`
	Restored bool   `json:"restored"`
	MS       int64  `json:"ms"`
}

// put creates the sandbox or, when it runs, takes the fresh tools and snapshot settings.
func (m *Manager) put(ctx context.Context, id string, request putRequest, memoryMB int) (putResult, error) {
	started := time.Now()
	sb := m.entry(id)
	sb.op.Lock()
	defer sb.op.Unlock()
	target := &snapshotTarget{Put: request.Snapshot.Put, Key: strings.ToLower(request.Snapshot.Key)}
	now := time.Now().UTC()
	m.mu.Lock()
	if sb.rec.State == stateRunning {
		if sb.rec.Workspace != request.Workspace {
			m.mu.Unlock()
			return putResult{}, &apiError{http.StatusConflict, "workspace_mismatch", "the sandbox belongs to another workspace"}
		}
		sb.rec.Tools, sb.rec.Snapshot, sb.rec.LastUsedAt = request.Tools, target, now
		m.mu.Unlock()
		m.save()
		return putResult{ID: id, State: stateRunning, MS: time.Since(started).Milliseconds()}, nil
	}
	if err := m.admit(id, memoryMB); err != nil {
		m.mu.Unlock()
		return putResult{}, err
	}
	sb.rec = record{ID: id, Workspace: request.Workspace, State: stateStarting, MemoryMB: memoryMB,
		RootfsVersion: m.cfg.RootfsVersion, CreatedAt: now, LastUsedAt: now, Tools: request.Tools, Snapshot: target}
	m.mu.Unlock()
	m.save()

	get := ""
	if request.Snapshot.Get != nil {
		get = *request.Snapshot.Get
	}
	// A start is finished even when the caller hangs up: half a restore would only be torn down.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), startTimeout)
	defer cancel()
	restored, err := m.start(ctx, sb, get, target.Key)
	if err != nil {
		if teardownErr := m.teardown(ctx, sb); teardownErr != nil {
			m.log.Error("cleanup after a failed start failed", "sandbox", id, "error", teardownErr.Error())
		}
		m.markStopped(sb, "start failed")
		m.log.Warn("sandbox did not start", "sandbox", id, "error", err.Error())
		return putResult{}, err
	}
	m.mu.Lock()
	sb.rec.State, sb.rec.LastUsedAt = stateRunning, time.Now().UTC()
	m.mu.Unlock()
	m.save()
	elapsed := time.Since(started).Milliseconds()
	m.log.Info("sandbox started", "sandbox", id, "memoryMb", memoryMB, "restored", restored, "ms", elapsed)
	return putResult{ID: id, State: stateRunning, Created: true, Restored: restored, MS: elapsed}, nil
}

// admit keeps the sum of sandbox memory limits within the host (the caller holds m.mu): past it the
// kernel's OOM killer would pick some other person's sandbox.
func (m *Manager) admit(id string, memoryMB int) error {
	count, committed := 0, 0
	for _, other := range m.sandboxes {
		if other.id != id && (other.rec.State == stateRunning || other.rec.State == stateStarting) {
			count++
			committed += other.rec.MemoryMB
		}
	}
	if count >= m.cfg.MaxSandboxes {
		return &apiError{http.StatusInsufficientStorage, "host_full",
			fmt.Sprintf("the host runs %d sandboxes, its maximum", count)}
	}
	limit := m.cfg.MemoryLimitMB
	if limit == 0 {
		total, err := m.memTotalMB()
		if err != nil {
			return fmt.Errorf("reading MemTotal: %w", err)
		}
		limit = total - m.cfg.ReserveMB
	}
	if committed+memoryMB > limit {
		return &apiError{http.StatusInsufficientStorage, "host_full",
			fmt.Sprintf("%d MiB more would exceed the host's %d MiB (%d MiB committed)", memoryMB, limit, committed)}
	}
	return nil
}

// start brings a container up from the rootfs, with its broker, and restores /workspace when there is a
// snapshot.
func (m *Manager) start(ctx context.Context, sb *Sandbox, get, key string) (bool, error) {
	paths := m.cfg.paths(sb.id)
	if info, err := os.Stat(m.cfg.rootfsDir()); err != nil || !info.IsDir() {
		return false, &apiError{http.StatusInternalServerError, "rootfs_missing",
			"rootfs " + m.cfg.RootfsVersion + " is not on this host"}
	}
	// Leftovers of an earlier life of this id: a container sandboxd lost track of, its directory.
	if err := m.rt.Delete(ctx, sb.id); err != nil {
		return false, &apiError{http.StatusBadGateway, "runtime_failed", "an old container is in the way: " + err.Error()}
	}
	if err := os.RemoveAll(paths.dir); err != nil {
		return false, err
	}
	if err := os.MkdirAll(paths.dir, 0o700); err != nil {
		return false, err
	}
	// The bind mount's source: root's, 0755, so the sandbox can reach the socket but not put files here.
	if err := os.Mkdir(paths.run, 0o755); err != nil {
		return false, err
	}
	if err := os.Chmod(paths.run, 0o755); err != nil {
		return false, err
	}
	if err := writeBundle(m.cfg, paths, sb.id, sb.rec.MemoryMB); err != nil {
		return false, err
	}
	b, err := m.startBroker(sb, paths.socket)
	if err != nil {
		return false, fmt.Errorf("broker socket: %w", err)
	}
	m.mu.Lock()
	sb.broker = b
	m.mu.Unlock()
	if err := m.rt.Run(ctx, sb.id, paths.bundle, paths.log); err != nil {
		return false, &apiError{http.StatusBadGateway, "runtime_failed", err.Error()}
	}
	if get == "" {
		return false, nil
	}
	restored, err := m.restoreSnapshot(ctx, sb, get, key)
	if err != nil {
		return false, &apiError{http.StatusBadGateway, "restore_failed", err.Error()}
	}
	return restored, nil
}

// teardown stops the broker, deletes the container and wipes its host directory. A container runsc could
// not delete keeps its directory: the next attempt finds both.
func (m *Manager) teardown(ctx context.Context, sb *Sandbox) error {
	m.mu.Lock()
	b := sb.broker
	sb.broker = nil
	m.mu.Unlock()
	if b != nil {
		b.close()
	}
	if err := m.rt.Delete(ctx, sb.id); err != nil {
		return err
	}
	return os.RemoveAll(m.cfg.paths(sb.id).dir)
}

func (m *Manager) markStopped(sb *Sandbox, reason string) {
	m.mu.Lock()
	sb.rec.State, sb.rec.StopReason, sb.rec.StoppedAt = stateStopped, reason, time.Now().UTC()
	sb.rec.Tools, sb.rec.Snapshot = nil, nil
	m.mu.Unlock()
	m.save()
}

type snapshotResult struct {
	Bytes int64 `json:"bytes"`
	MS    int64 `json:"ms"`
}

func (m *Manager) runningLocked(sb *Sandbox) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return sb.rec.State == stateRunning
}

// snapshot uploads /workspace and leaves the sandbox running.
func (m *Manager) snapshot(ctx context.Context, id string) (snapshotResult, error) {
	sb := m.lookup(id)
	if sb == nil {
		return snapshotResult{}, notFound(id)
	}
	sb.op.Lock()
	defer sb.op.Unlock()
	if !m.runningLocked(sb) {
		return snapshotResult{}, notFound(id)
	}
	m.touch(sb)
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), snapshotTimeout)
	defer cancel()
	size, err := m.takeSnapshot(ctx, sb)
	if err != nil {
		m.log.Warn("snapshot failed", "sandbox", id, "error", err.Error())
		return snapshotResult{}, snapshotError(err)
	}
	result := snapshotResult{Bytes: size, MS: time.Since(started).Milliseconds()}
	m.log.Info("snapshot taken", "sandbox", id, "bytes", size, "ms", result.MS)
	return result, nil
}

func snapshotError(err error) error {
	if errors.Is(err, errSnapshotTooLarge) {
		return &apiError{http.StatusRequestEntityTooLarge, "snapshot_too_large", err.Error()}
	}
	return &apiError{http.StatusBadGateway, "snapshot_failed", err.Error()}
}

// stop snapshots the sandbox and then stops it; a failed snapshot leaves it running.
func (m *Manager) stop(ctx context.Context, id, reason string) (snapshotResult, error) {
	sb := m.lookup(id)
	if sb == nil {
		return snapshotResult{}, notFound(id)
	}
	sb.op.Lock()
	defer sb.op.Unlock()
	return m.stopLocked(ctx, sb, reason)
}

func (m *Manager) stopLocked(ctx context.Context, sb *Sandbox, reason string) (snapshotResult, error) {
	if !m.runningLocked(sb) {
		return snapshotResult{}, notFound(sb.id)
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), snapshotTimeout)
	defer cancel()
	size, err := m.takeSnapshot(ctx, sb)
	if err != nil {
		m.log.Warn("snapshot before stop failed: the sandbox keeps running", "sandbox", sb.id, "reason", reason,
			"error", err.Error())
		return snapshotResult{}, snapshotError(err)
	}
	if err := m.teardown(ctx, sb); err != nil {
		m.log.Error("stop failed after the snapshot", "sandbox", sb.id, "error", err.Error())
		return snapshotResult{}, &apiError{http.StatusBadGateway, "runtime_failed", err.Error()}
	}
	m.markStopped(sb, reason)
	result := snapshotResult{Bytes: size, MS: time.Since(started).Milliseconds()}
	m.log.Info("sandbox stopped", "sandbox", sb.id, "reason", reason, "bytes", size, "ms", result.MS)
	return result, nil
}

// remove stops and wipes the sandbox without a snapshot. Idempotent: an unknown id still has its
// leftovers removed.
func (m *Manager) remove(ctx context.Context, id string) error {
	sb := m.entry(id)
	sb.op.Lock()
	defer sb.op.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	if err := m.teardown(ctx, sb); err != nil {
		m.log.Error("delete failed", "sandbox", id, "error", err.Error())
		return &apiError{http.StatusBadGateway, "runtime_failed", err.Error()}
	}
	m.mu.Lock()
	wasLive := sb.rec.State == stateRunning
	sb.rec = record{ID: id, State: stateAbsent}
	m.mu.Unlock()
	m.save()
	if wasLive {
		m.log.Info("sandbox deleted", "sandbox", id)
	}
	return nil
}

type statusView struct {
	ID         string `json:"id"`
	State      string `json:"state"`
	LastUsedAt string `json:"lastUsedAt"`
	MemoryMB   int    `json:"memoryMb"`
}

func (m *Manager) status(id string) (statusView, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sb := m.sandboxes[id]
	if sb == nil || (sb.rec.State != stateRunning && sb.rec.State != stateStarting) {
		return statusView{}, notFound(id)
	}
	return statusView{ID: id, State: sb.rec.State, LastUsedAt: sb.rec.LastUsedAt.UTC().Format(timeFormat),
		MemoryMB: sb.rec.MemoryMB}, nil
}

const timeFormat = "2006-01-02T15:04:05.000Z"

func (m *Manager) liveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, sb := range m.sandboxes {
		if sb.rec.State == stateRunning {
			count++
		}
	}
	return count
}

func memTotalMB() (int, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kib, err := strconv.Atoi(fields[1])
			return kib / 1024, err
		}
	}
	return 0, errors.New("no MemTotal in /proc/meminfo")
}
