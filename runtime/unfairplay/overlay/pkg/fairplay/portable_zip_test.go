package fairplay

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestPortableCentralDirectoryBounds(t *testing.T) {
	original := portableTestArchive(t, map[string][]byte{"Payload/Test.app/one": []byte("one"), "Payload/Test.app/two": []byte("two")})
	if _, err := OpenPortableArchive(bytes.NewReader(original), int64(len(original))); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"count", "size"} {
		bad := append([]byte(nil), original...)
		end := bad[len(bad)-22:]
		if kind == "count" {
			binary.LittleEndian.PutUint16(end[8:10], 1)
			binary.LittleEndian.PutUint16(end[10:12], 1)
		} else {
			binary.LittleEndian.PutUint32(end[12:16], uint32(maximumPortableCentralDirectoryBytes+1))
		}
		if _, err := OpenPortableArchive(bytes.NewReader(bad), int64(len(bad))); err == nil {
			t.Fatalf("accepted invalid central %s", kind)
		}
	}
}

func TestPortableZIP64DirectoryEnvelope(t *testing.T) {
	original := portableTestArchive(t, map[string][]byte{"Payload/Test.app/file": []byte("synthetic")})
	end := original[len(original)-22:]
	output := append([]byte(nil), original[:len(original)-22]...)
	recordAt := len(output)
	var record [56]byte
	binary.LittleEndian.PutUint32(record[:4], 0x06064b50)
	binary.LittleEndian.PutUint64(record[4:12], 44)
	binary.LittleEndian.PutUint16(record[12:14], 45)
	binary.LittleEndian.PutUint16(record[14:16], 45)
	binary.LittleEndian.PutUint64(record[24:32], 1)
	binary.LittleEndian.PutUint64(record[32:40], 1)
	binary.LittleEndian.PutUint64(record[40:48], uint64(binary.LittleEndian.Uint32(end[12:16])))
	binary.LittleEndian.PutUint64(record[48:56], uint64(binary.LittleEndian.Uint32(end[16:20])))
	output = append(output, record[:]...)
	var locator [20]byte
	binary.LittleEndian.PutUint32(locator[:4], 0x07064b50)
	binary.LittleEndian.PutUint64(locator[8:16], uint64(recordAt))
	binary.LittleEndian.PutUint32(locator[16:20], 1)
	output = append(output, locator[:]...)
	tail := append([]byte(nil), end...)
	binary.LittleEndian.PutUint16(tail[8:10], 65535)
	binary.LittleEndian.PutUint16(tail[10:12], 65535)
	binary.LittleEndian.PutUint32(tail[12:16], 0xffffffff)
	binary.LittleEndian.PutUint32(tail[16:20], 0xffffffff)
	output = append(output, tail...)
	archive, err := OpenPortableArchive(bytes.NewReader(output), int64(len(output)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 {
		t.Fatal("ZIP64 member lost")
	}
}
