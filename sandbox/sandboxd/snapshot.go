package main

import (
	"bufio"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"time"
)

// A snapshot is /workspace as `tar -cz`, encrypted in frames and uploaded with one PUT:
//
//	"BROSNAP1"                                  8 bytes, the magic
//	frame*                                      at least one; the last one is marked final
//	  length                                    4 bytes big-endian: the ciphertext's length (tag included)
//	  nonce                                     12 bytes: the snapshot's 8 random bytes + the frame number
//	                                            (4 bytes big-endian, from 0)
//	  ciphertext                                AES-256-GCM of up to 1 MiB of the tar.gz, 16-byte tag
//
// The additional data of each frame is the magic and one byte, 1 on the final frame and 0 on the others,
// so a snapshot cut at a frame boundary does not decrypt. The frame number in the nonce keeps frames in
// order and the random part keeps frames of different snapshots apart; with 8 random bytes a key may
// seal some 2^24 snapshots before a nonce repeats with a chance of 2^-17 (4 bytes, as first drafted, gave
// a 1-in-10^4 chance after ~1000 snapshots under one long-lived key).
const (
	snapshotMagic     = "BROSNAP1"
	frameSize         = 1 << 20
	frameTag          = 16
	nonceRandom       = 8
	maxSnapshotBytes  = 512 << 20 // the object, as uploaded or downloaded
	snapshotTimeout   = 20 * time.Minute
	snapshotWorkspace = "/workspace"
)

var (
	errSnapshotCorrupt  = errors.New("snapshot is corrupt or was sealed with another key")
	errSnapshotTooLarge = fmt.Errorf("the workspace snapshot exceeds %d MiB", maxSnapshotBytes>>20)
)

func snapshotAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("snapshot key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func frameAAD(final bool) []byte {
	aad := []byte(snapshotMagic + "\x00")
	if final {
		aad[len(aad)-1] = 1
	}
	return aad
}

// sealer encrypts what is written to it into the frame format; Close writes the final frame.
type sealer struct {
	w      io.Writer
	aead   cipher.AEAD
	nonce  [12]byte
	frame  uint32
	buffer []byte
	out    []byte
	err    error
}

func newSealer(w io.Writer, key []byte) (*sealer, error) {
	aead, err := snapshotAEAD(key)
	if err != nil {
		return nil, err
	}
	s := &sealer{w: w, aead: aead, buffer: make([]byte, 0, frameSize), out: make([]byte, 0, frameSize+frameTag)}
	if _, err := rand.Read(s.nonce[:nonceRandom]); err != nil {
		return nil, err
	}
	if _, err := io.WriteString(w, snapshotMagic); err != nil {
		return nil, err
	}
	return s, nil
}

// Write buffers a frame's worth and seals it only once more data follows: the last frame must know it is
// the last one.
func (s *sealer) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		if s.err != nil {
			return written, s.err
		}
		if len(s.buffer) == frameSize {
			s.err = s.seal(false)
			continue
		}
		n := min(frameSize-len(s.buffer), len(p))
		s.buffer = append(s.buffer, p[:n]...)
		p, written = p[n:], written+n
	}
	return written, nil
}

func (s *sealer) Close() error {
	if s.err != nil {
		return s.err
	}
	s.err = s.seal(true)
	if s.err == nil {
		s.err = errors.New("sealer is closed")
		return nil
	}
	return s.err
}

func (s *sealer) seal(final bool) error {
	if s.frame == math.MaxUint32 {
		return errSnapshotTooLarge
	}
	binary.BigEndian.PutUint32(s.nonce[nonceRandom:], s.frame)
	s.out = s.aead.Seal(s.out[:0], s.nonce[:], s.buffer, frameAAD(final))
	var header [4 + 12]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(s.out)))
	copy(header[4:], s.nonce[:])
	if _, err := s.w.Write(header[:]); err != nil {
		return err
	}
	if _, err := s.w.Write(s.out); err != nil {
		return err
	}
	s.frame++
	s.buffer = s.buffer[:0]
	return nil
}

// opener decrypts the frame format; it fails on the first frame that does not authenticate, comes out of
// order, belongs to another snapshot, or when the stream ends without its final frame.
type opener struct {
	r      *bufio.Reader
	aead   cipher.AEAD
	prefix [nonceRandom]byte
	frame  uint32
	buffer []byte
	plain  []byte
	done   bool
	err    error
}

func newOpener(r io.Reader, key []byte) (*opener, error) {
	aead, err := snapshotAEAD(key)
	if err != nil {
		return nil, err
	}
	o := &opener{r: bufio.NewReaderSize(r, 64<<10), aead: aead, buffer: make([]byte, frameSize+frameTag)}
	magic := make([]byte, len(snapshotMagic))
	if _, err := io.ReadFull(o.r, magic); err != nil || string(magic) != snapshotMagic {
		return nil, fmt.Errorf("%w: no %s magic", errSnapshotCorrupt, snapshotMagic)
	}
	return o, nil
}

func (o *opener) Read(p []byte) (int, error) {
	for len(o.plain) == 0 {
		if o.done {
			return 0, io.EOF
		}
		if o.err != nil {
			return 0, o.err
		}
		o.err = o.next()
	}
	n := copy(p, o.plain)
	o.plain = o.plain[n:]
	return n, nil
}

func (o *opener) next() error {
	var header [4 + 12]byte
	if _, err := io.ReadFull(o.r, header[:]); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return fmt.Errorf("%w: it ends before its final frame", errSnapshotCorrupt)
		}
		return err
	}
	length := binary.BigEndian.Uint32(header[:4])
	if length < frameTag || length > frameSize+frameTag {
		return fmt.Errorf("%w: frame %d has length %d", errSnapshotCorrupt, o.frame, length)
	}
	nonce := header[4:]
	if o.frame == 0 {
		copy(o.prefix[:], nonce[:nonceRandom])
	} else if string(nonce[:nonceRandom]) != string(o.prefix[:]) {
		return fmt.Errorf("%w: frame %d belongs to another snapshot", errSnapshotCorrupt, o.frame)
	}
	if binary.BigEndian.Uint32(nonce[nonceRandom:]) != o.frame {
		return fmt.Errorf("%w: frame %d is out of order", errSnapshotCorrupt, o.frame)
	}
	ciphertext := o.buffer[:length]
	if _, err := io.ReadFull(o.r, ciphertext); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return fmt.Errorf("%w: frame %d is cut short", errSnapshotCorrupt, o.frame)
		}
		return err
	}
	_, peek := o.r.Peek(1)
	final := errors.Is(peek, io.EOF)
	if peek != nil && !final {
		return peek
	}
	plain, err := o.aead.Open(ciphertext[:0], nonce, ciphertext, frameAAD(final))
	if err != nil {
		return fmt.Errorf("%w: frame %d does not authenticate", errSnapshotCorrupt, o.frame)
	}
	o.frame++
	o.plain, o.done = plain, final
	return nil
}

// cappedWriter fails once more than `left` bytes went through it, and says so through onExceed.
type cappedWriter struct {
	w        io.Writer
	left     int64
	written  int64
	onExceed func()
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > c.left {
		if c.onExceed != nil {
			c.onExceed()
		}
		return 0, errSnapshotTooLarge
	}
	n, err := c.w.Write(p)
	c.left -= int64(n)
	c.written += int64(n)
	return n, err
}

// cappedReader fails once the stream goes past `left` bytes.
type cappedReader struct {
	r    io.Reader
	left int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.left <= 0 {
		var probe [1]byte
		if n, _ := c.r.Read(probe[:]); n > 0 {
			return 0, errSnapshotTooLarge
		}
		return 0, io.EOF
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}

// firstError remembers the first failure of a reader os/exec copies from: Wait reports a process's exit
// status before a copy error, and a failed decryption must not pass for a tar error.
type firstError struct {
	r   io.Reader
	err error
}

func (f *firstError) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) && f.err == nil {
		f.err = err
	}
	return n, err
}

// Scripts run in the sandbox as the sandbox user, the directory in $W (never in the script text).
// tar exits 1 when a file changed or vanished while it was read: the archive is still whole. A file it
// cannot read (one its owner made unreadable) is exit 2 and fails the snapshot: a snapshot never leaves
// files out silently.
const (
	snapshotScript = `exec tar -cz -C "$W" .`
	restoreScript  = `exec tar -xpz --no-same-owner -C "$W"`
)

// takeSnapshot uploads /workspace to the sandbox's current snapshot.put without stopping it and returns
// the object's size. The caller holds the sandbox's op lock. The encrypted archive is staged on the host's
// disk, not in memory, so the PUT can carry a Content-Length.
func (m *Manager) takeSnapshot(ctx context.Context, sb *Sandbox) (int64, error) {
	m.mu.Lock()
	target := sb.rec.Snapshot
	m.mu.Unlock()
	if target == nil {
		return 0, errors.New("the sandbox has no snapshot target")
	}
	key, err := hex.DecodeString(target.Key)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	file, err := os.CreateTemp(m.cfg.stagingDir(), sb.id+"-*.snap")
	if err != nil {
		return 0, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	capped := &cappedWriter{w: file, left: maxSnapshotBytes, onExceed: func() { cancel(errSnapshotTooLarge) }}
	seal, err := newSealer(capped, key)
	if err != nil {
		return 0, err
	}
	cmd := m.command(ctx, sb.id, ExecSpec{User: sandboxUser, Cwd: "/", Env: []string{"W=" + snapshotWorkspace},
		Argv: []string{"/bin/bash", "-c", snapshotScript}})
	stderr := &tail{}
	cmd.Stdout, cmd.Stderr = seal, stderr
	runErr := cmd.Run()
	if errors.Is(context.Cause(ctx), errSnapshotTooLarge) {
		return 0, errSnapshotTooLarge
	}
	if code, ok := exitCode(cmd.ProcessState); !ok || code > 1 {
		return 0, fmt.Errorf("tar in the sandbox failed (%v): %s", runErr, stderr.text())
	}
	if err := seal.Close(); err != nil {
		return 0, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, target.Put, file)
	if err != nil {
		return 0, errors.New("snapshot.put is not a valid URL")
	}
	request.ContentLength = capped.written
	response, err := m.s3.Do(request)
	if err != nil {
		return 0, fmt.Errorf("snapshot upload to %s: %s", redact(target.Put), redactError(err))
	}
	defer response.Body.Close()
	io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode/100 != 2 {
		return 0, fmt.Errorf("snapshot upload to %s answered %d", redact(target.Put), response.StatusCode)
	}
	return capped.written, nil
}

// restoreSnapshot unpacks the snapshot behind a presigned GET into /workspace of a sandbox that has just
// started; false when there is none yet (404). The stream is decrypted on the way in: nothing is staged.
func (m *Manager) restoreSnapshot(ctx context.Context, sb *Sandbox, url, keyHex string) (bool, error) {
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return false, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, errors.New("snapshot.get is not a valid URL")
	}
	response, err := m.s3.Do(request)
	if err != nil {
		return false, fmt.Errorf("snapshot download from %s: %s", redact(url), redactError(err))
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("snapshot download from %s answered %d", redact(url), response.StatusCode)
	}
	if response.ContentLength > maxSnapshotBytes {
		return false, errSnapshotTooLarge
	}
	open, err := newOpener(&cappedReader{r: response.Body, left: maxSnapshotBytes}, key)
	if err != nil {
		return false, err
	}
	source := &firstError{r: open}
	cmd := m.command(ctx, sb.id, ExecSpec{User: sandboxUser, Cwd: "/", Env: []string{"W=" + snapshotWorkspace},
		Argv: []string{"/bin/bash", "-c", restoreScript}})
	stderr := &tail{}
	cmd.Stdin, cmd.Stderr = source, stderr
	runErr := cmd.Run()
	if source.err != nil {
		return false, source.err
	}
	if code, ok := exitCode(cmd.ProcessState); !ok || code != 0 || runErr != nil {
		return false, fmt.Errorf("tar in the sandbox failed (%v): %s", runErr, stderr.text())
	}
	return true, nil
}
