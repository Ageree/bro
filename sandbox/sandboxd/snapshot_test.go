package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func seal(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	s, err := newSealer(&out, key)
	if err != nil {
		t.Fatal(err)
	}
	// Uneven writes: frames must not follow the writer's chunks.
	for rest := plain; len(rest) > 0; {
		n := min(len(rest), 70_001)
		if _, err := s.Write(rest[:n]); err != nil {
			t.Fatal(err)
		}
		rest = rest[n:]
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func open(key, sealed []byte) ([]byte, error) {
	o, err := newOpener(bytes.NewReader(sealed), key)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(o)
}

// frames splits a sealed snapshot into its frames (header included), after the magic.
func frames(t *testing.T, sealed []byte) [][]byte {
	t.Helper()
	var result [][]byte
	for rest := sealed[len(snapshotMagic):]; len(rest) > 0; {
		length := int(binary.BigEndian.Uint32(rest[:4]))
		result = append(result, rest[:16+length])
		rest = rest[16+length:]
	}
	return result
}

func join(parts ...[]byte) []byte {
	return bytes.Join(append([][]byte{[]byte(snapshotMagic)}, parts...), nil)
}

func TestSnapshotRoundTrip(t *testing.T) {
	for _, size := range []int{0, 1, frameSize - 1, frameSize, frameSize + 1, 3*frameSize + 12345} {
		plain := make([]byte, size)
		rand.Read(plain)
		sealed := seal(t, testKey, plain)
		if !bytes.HasPrefix(sealed, []byte(snapshotMagic)) {
			t.Fatalf("%d: no magic", size)
		}
		wantFrames := max(1, (size+frameSize-1)/frameSize)
		if got := len(frames(t, sealed)); got != wantFrames {
			t.Fatalf("%d bytes: %d frames, want %d", size, got, wantFrames)
		}
		if want := len(snapshotMagic) + size + wantFrames*(16+frameTag); len(sealed) != want {
			t.Fatalf("%d bytes: sealed %d, want %d", size, len(sealed), want)
		}
		got, err := open(testKey, sealed)
		if err != nil {
			t.Fatalf("%d bytes: %v", size, err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("%d bytes: the round trip changed the data", size)
		}
	}
}

func TestSnapshotNoncesDiffer(t *testing.T) {
	a, b := frames(t, seal(t, testKey, []byte("x"))), frames(t, seal(t, testKey, []byte("x")))
	if bytes.Equal(a[0][4:16], b[0][4:16]) {
		t.Fatal("two snapshots under one key share a nonce")
	}
	parts := frames(t, seal(t, testKey, make([]byte, 2*frameSize+1)))
	for i, frame := range parts {
		if got := binary.BigEndian.Uint32(frame[4+nonceRandom : 16]); got != uint32(i) {
			t.Fatalf("frame %d carries number %d", i, got)
		}
	}
}

func TestSnapshotTamper(t *testing.T) {
	plain := make([]byte, 3*frameSize+100)
	rand.Read(plain)
	sealed := seal(t, testKey, plain)
	parts := frames(t, sealed)
	other := frames(t, seal(t, testKey, plain))
	flip := func(data []byte, at int) []byte {
		copied := append([]byte{}, data...)
		copied[at] ^= 0x01
		return copied
	}
	wrongKey := bytes.Repeat([]byte{7}, 32)
	cases := map[string]struct {
		key  []byte
		data []byte
	}{
		"ciphertext bit":          {testKey, flip(sealed, len(snapshotMagic)+16+100)},
		"tag bit":                 {testKey, flip(sealed, len(sealed)-1)},
		"nonce random":            {testKey, flip(sealed, len(snapshotMagic)+4)},
		"nonce counter":           {testKey, flip(sealed, len(snapshotMagic)+15)},
		"length":                  {testKey, flip(sealed, len(snapshotMagic)+3)},
		"magic":                   {testKey, flip(sealed, 0)},
		"wrong key":               {wrongKey, sealed},
		"cut at a frame boundary": {testKey, join(parts[:3]...)},
		"cut inside a frame":      {testKey, sealed[:len(sealed)-10]},
		"cut inside a header":     {testKey, append(join(parts[:3]...), parts[3][:7]...)},
		"only the magic":          {testKey, []byte(snapshotMagic)},
		"empty":                   {testKey, nil},
		"frame dropped":           {testKey, join(parts[0], parts[2], parts[3])},
		"frames swapped":          {testKey, join(parts[1], parts[0], parts[2], parts[3])},
		"frame of another":        {testKey, join(parts[0], other[1], parts[2], parts[3])},
		"trailing bytes":          {testKey, append(append([]byte{}, sealed...), 0)},
		"final frame repeated":    {testKey, join(parts[0], parts[1], parts[2], parts[3], parts[3])},
	}
	for name, c := range cases {
		got, err := open(c.key, c.data)
		if err == nil {
			t.Errorf("%s: opened (%d bytes)", name, len(got))
			continue
		}
		if !errors.Is(err, errSnapshotCorrupt) {
			t.Errorf("%s: %v is not errSnapshotCorrupt", name, err)
		}
	}
}

func TestSnapshotKeyLength(t *testing.T) {
	if _, err := newSealer(io.Discard, make([]byte, 16)); err == nil {
		t.Fatal("a 16-byte key was taken")
	}
}

func TestCappedReader(t *testing.T) {
	data, err := io.ReadAll(&cappedReader{r: bytes.NewReader(make([]byte, 10)), left: 10})
	if err != nil || len(data) != 10 {
		t.Fatalf("at the cap: %d bytes, %v", len(data), err)
	}
	if _, err := io.ReadAll(&cappedReader{r: bytes.NewReader(make([]byte, 11)), left: 10}); !errors.Is(err, errSnapshotTooLarge) {
		t.Fatalf("over the cap: %v", err)
	}
}
