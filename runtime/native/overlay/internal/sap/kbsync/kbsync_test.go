package kbsync

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
)

func TestNativeCPPVector(t *testing.T) {
	entropy := make([]byte, 1024)
	for i := range entropy {
		entropy[i] = byte(1 + i%255)
	}
	hw := []byte{2, 0, 0, 0, 0, 1}
	packet, err := GenerateWithReader(1, hw, bytes.NewReader(entropy))
	if err != nil {
		t.Fatal(err)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(packet))
	if sum != "064978c74ce16d4130a6c70c3f3da2a109d8cac95f370596fdcc935fcdbecb02" {
		t.Fatalf("native C++ deterministic vector mismatch: %s", sum)
	}
	if err = Validate(1, hw, packet); err != nil {
		t.Fatal(err)
	}
}

func TestIndependentCPPVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/cpp-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		DSID                      string
		Hardware, Entropy, Packet string
	}
	if err = json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		t.Run(row.DSID+"/"+row.Hardware, func(t *testing.T) {
			var dsid uint64
			if _, err := fmt.Sscan(row.DSID, &dsid); err != nil {
				t.Fatal(err)
			}
			hardware, err := hex.DecodeString(row.Hardware)
			if err != nil {
				t.Fatal(err)
			}
			entropy, err := hex.DecodeString(row.Entropy)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := hex.DecodeString(row.Packet)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := GenerateWithReader(dsid, hardware, bytes.NewReader(entropy))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(actual, expected) {
				t.Fatal("exact independent C++ packet differs")
			}
			if err = Validate(dsid, hardware, actual); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInputAndEntropyBounds(t *testing.T) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	if _, err := Generate(0, hardware); !errors.Is(err, ErrInput) {
		t.Fatalf("zero DSID: %v", err)
	}
	for n := 0; n <= 20; n++ {
		if n == 6 {
			continue
		}
		if _, err := Generate(1, make([]byte, n)); !errors.Is(err, ErrInput) {
			t.Fatalf("hardware length %d: %v", n, err)
		}
	}
	if _, err := GenerateWithReader(1, hardware, bytes.NewReader(make([]byte, 1024))); !errors.Is(err, ErrEntropy) {
		t.Fatalf("zero entropy: %v", err)
	}
	if _, err := GenerateWithReader(1, hardware, nil); !errors.Is(err, ErrEntropy) {
		t.Fatalf("nil entropy: %v", err)
	}
	if _, err := GenerateWithReader(1, hardware, bytes.NewReader(make([]byte, 1023))); err == nil {
		t.Fatal("short entropy accepted")
	}
	for n := 0; n <= 213; n++ {
		if n != 212 && Validate(1, hardware, make([]byte, n)) == nil {
			t.Fatalf("packet length %d accepted", n)
		}
	}
}

func TestFreshRandomPacketsAndConcurrentCalls(t *testing.T) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	var wg sync.WaitGroup
	packets := make(chan []byte, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			packet, err := Generate(1, hardware)
			if err != nil {
				t.Error(err)
				return
			}
			if err = Validate(1, hardware, packet); err != nil {
				t.Error(err)
				return
			}
			packets <- packet
		}()
	}
	wg.Wait()
	close(packets)
	seen := make(map[string]bool)
	for packet := range packets {
		key := string(packet)
		if seen[key] {
			t.Fatal("reused random packet")
		}
		seen[key] = true
	}
	if len(seen) != 64 {
		t.Fatalf("only %d packets completed", len(seen))
	}
}

func TestAllPacketBytesAuthenticated(t *testing.T) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	packet, err := Generate(1, hardware)
	if err != nil {
		t.Fatal(err)
	}
	for i := range packet {
		packet[i] ^= 1
		if Validate(1, hardware, packet) == nil {
			t.Fatalf("changed byte %d accepted", i)
		}
		packet[i] ^= 1
	}
}

func FuzzValidateNeverPanics(f *testing.F) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	p, err := Generate(1, hardware)
	if err != nil {
		f.Fatal(err)
	}
	f.Add(uint64(1), hardware, p)
	f.Add(^uint64(1), []byte{255, 255, 255, 255, 255, 255}, make([]byte, 212))
	f.Fuzz(func(t *testing.T, dsid uint64, hw, packet []byte) { _ = Validate(dsid, hw, packet) })
}

func TestPinnedTCICorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/tci-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Name, DSID, Hardware, Packet string }
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			packet, err := hex.DecodeString(c.Packet)
			if err != nil {
				t.Fatal(err)
			}
			hw, err := hex.DecodeString(c.Hardware)
			if err != nil {
				t.Fatal(err)
			}
			var dsid uint64
			if _, err := fmt.Sscan(c.DSID, &dsid); err != nil {
				t.Fatal(err)
			}
			if err = Validate(dsid, hw, packet); err != nil {
				t.Fatal(err)
			}
			bad := append([]byte(nil), packet...)
			bad[99] ^= 1
			if Validate(dsid, hw, bad) == nil {
				t.Fatal("changed ciphertext accepted")
			}
			if Validate(dsid^7, hw, packet) == nil {
				t.Fatal("changed DSID accepted")
			}
			hw[0] ^= 1
			if Validate(dsid, hw, packet) == nil {
				t.Fatal("changed hardware accepted")
			}
		})
	}
}

func BenchmarkGenerate(b *testing.B) {
	hw := []byte{2, 0, 0, 0, 0, 1}
	for i := 0; i < b.N; i++ {
		if _, err := Generate(1, hw); err != nil {
			b.Fatal(err)
		}
	}
}
