package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// A sandbox's memory, as it stands with runsc 20260928.0 (checked on cgroup v1 here, the same kernel
// mechanism as v2):
//
//   - gVisor does not keep the guest within its own total memory (`runsc boot --total-memory`, which runsc
//     takes from the container's cgroup limit and the guest sees as MemTotal), nor within RLIMIT_DATA. The
//     guest's pages live in the sentry's memory file and are charged to the container's cgroup; past the
//     limit the host's memory-cgroup OOM killer picks a victim, and the guest's pages are nobody's RSS, so
//     with default scores it picks gvisor_sentry and the whole sandbox, /workspace included, is gone.
//   - The host processes of guest processes are systrap stubs, all forked from one stub template that the
//     sentry starts. When the OOM killer kills a stub, gVisor kills that guest process (SIGKILL, exit 137)
//     and the sandbox lives on: what Linux itself does when a process takes too much.
//
// So: the guest's budget stays memoryMb (the spec's limit: MemTotal inside), the host cgroup gets
// headroom on top for the sentry, the gofer and page tables (`runsc update --memory` after the start),
// and every stub gets oom_score_adj 1000 (raising it needs no privilege; lowering the sentry's would), so
// the victim is always a guest process. Files in memory (the root overlay, /tmp, /dev/shm) have size
// limits that add up to memoryMb: a file can push nobody out, a write past them gets ENOSPC, and the
// sentry's own RSS (it maps the file pages it writes) stays below a stub's score.

// headroomMB is what the host cgroup allows a sandbox above its memoryMb.
func headroomMB(memoryMB int) int {
	return max(256, memoryMB/8)
}

// Sizes of the in-memory filesystems, in MiB: the root overlay's upper layer (/workspace, /home…), /tmp
// and /dev/shm.
func overlayMB(memoryMB int) int { return memoryMB / 2 }
func tmpMB(memoryMB int) int     { return memoryMB / 4 }
func shmMB(memoryMB int) int     { return memoryMB / 4 }

const guestOOMScoreAdj = "1000"

// procIdentity names a host process across pid reuse: its pid and start time (/proc/<pid>/stat field 22).
type procIdentity struct {
	pid   int
	start string
}

// procStat is the fields of /proc/<pid>/stat after the command name: state, ppid, … (proc(5) numbering
// minus 3).
func procStat(proc string, pid int) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(proc, strconv.Itoa(pid), "stat"))
	if err != nil {
		return nil, err
	}
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return nil, errors.New("malformed stat")
	}
	return strings.Fields(string(data[end+1:])), nil
}

func identify(proc string, pid int) procIdentity {
	if pid <= 1 {
		return procIdentity{}
	}
	fields, err := procStat(proc, pid)
	if err != nil || len(fields) < 20 {
		return procIdentity{}
	}
	return procIdentity{pid: pid, start: fields[19]}
}

// gone is true when the process is known and no longer runs (exited, a zombie, or its pid reused).
func (p procIdentity) gone(proc string) bool {
	if p.pid == 0 {
		return false
	}
	fields, err := procStat(proc, p.pid)
	return err != nil || len(fields) < 20 || fields[0] == "Z" || fields[0] == "X" || fields[19] != p.start
}

// preferGuestVictims gives every descendant of the sentry (the systrap stub template and the stubs of
// guest processes) oom_score_adj 1000; stubs forked later inherit it from the template. It returns how
// many it changed.
func preferGuestVictims(proc string, sentry int) (int, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return 0, err
	}
	children := map[int][]int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if fields, err := procStat(proc, pid); err == nil && len(fields) > 1 {
			if parent, err := strconv.Atoi(fields[1]); err == nil {
				children[parent] = append(children[parent], pid)
			}
		}
	}
	changed := 0
	var failures []error
	queue := append([]int{}, children[sentry]...)
	for len(queue) > 0 {
		pid := queue[0]
		queue = append(queue[1:], children[pid]...)
		if err := os.WriteFile(filepath.Join(proc, strconv.Itoa(pid), "oom_score_adj"), []byte(guestOOMScoreAdj), 0); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				failures = append(failures, err)
			}
			continue
		}
		changed++
	}
	return changed, errors.Join(failures...)
}
