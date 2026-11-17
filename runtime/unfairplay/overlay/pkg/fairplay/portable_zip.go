package fairplay

import (
	"archive/zip"
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
)

const maximumPortableCentralDirectoryBytes uint64 = 32 << 20

// OpenPortableArchive bounds central-directory allocations before archive/zip
// constructs its member and filename tables. A declared count alone is not
// sufficient: the actual central records are checked within the bounded extent.
func OpenPortableArchive(input io.ReaderAt, size int64) (*zip.Reader, error) {
	if size < 22 || size > MaximumPortableArchiveBytes {
		return nil, fmt.Errorf("invalid IPA size")
	}
	tailBytes := min(size, int64(65535+22))
	tail := make([]byte, int(tailBytes))
	if _, err := input.ReadAt(tail, size-tailBytes); err != nil {
		return nil, err
	}
	end := -1
	for i := len(tail) - 22; i >= 0; i-- {
		if binary.LittleEndian.Uint32(tail[i:i+4]) == 0x06054b50 && int(binary.LittleEndian.Uint16(tail[i+20:i+22])) == len(tail)-i-22 {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, fmt.Errorf("ZIP end record is unavailable")
	}
	e := tail[end:]
	endAt := uint64(size - tailBytes + int64(end))
	if binary.LittleEndian.Uint16(e[4:6]) != 0 || binary.LittleEndian.Uint16(e[6:8]) != 0 {
		return nil, fmt.Errorf("multi-disk ZIP is unsupported")
	}
	count := uint64(binary.LittleEndian.Uint16(e[10:12]))
	diskCount := uint64(binary.LittleEndian.Uint16(e[8:10]))
	centralBytes := uint64(binary.LittleEndian.Uint32(e[12:16]))
	centralAt := uint64(binary.LittleEndian.Uint32(e[16:20]))
	centralEnd := endAt
	if count == 65535 || diskCount == 65535 || centralBytes == 0xffffffff || centralAt == 0xffffffff {
		if endAt < 20 {
			return nil, fmt.Errorf("ZIP64 locator is truncated")
		}
		var locator [20]byte
		if _, err := input.ReadAt(locator[:], int64(endAt-20)); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(locator[:4]) != 0x07064b50 || binary.LittleEndian.Uint32(locator[4:8]) != 0 || binary.LittleEndian.Uint32(locator[16:20]) != 1 {
			return nil, fmt.Errorf("invalid ZIP64 locator")
		}
		recordAt := binary.LittleEndian.Uint64(locator[8:16])
		if recordAt > endAt-20 || endAt-20-recordAt < 56 {
			return nil, fmt.Errorf("invalid ZIP64 extent")
		}
		var record [56]byte
		if _, err := input.ReadAt(record[:], int64(recordAt)); err != nil {
			return nil, err
		}
		recordBytes := binary.LittleEndian.Uint64(record[4:12])
		if binary.LittleEndian.Uint32(record[:4]) != 0x06064b50 || recordBytes < 44 || recordBytes > maximumPortableCentralDirectoryBytes || recordAt+12+recordBytes != endAt-20 || binary.LittleEndian.Uint32(record[16:20]) != 0 || binary.LittleEndian.Uint32(record[20:24]) != 0 {
			return nil, fmt.Errorf("invalid ZIP64 end record")
		}
		diskCount = binary.LittleEndian.Uint64(record[24:32])
		count = binary.LittleEndian.Uint64(record[32:40])
		centralBytes = binary.LittleEndian.Uint64(record[40:48])
		centralAt = binary.LittleEndian.Uint64(record[48:56])
		centralEnd = recordAt
	}
	if count > MaximumPortableArchiveEntries || count != diskCount || centralBytes > maximumPortableCentralDirectoryBytes || centralAt > centralEnd || centralBytes != centralEnd-centralAt {
		return nil, fmt.Errorf("ZIP central directory exceeds portable bounds")
	}
	reader := bufio.NewReaderSize(io.NewSectionReader(input, int64(centralAt), int64(centralBytes)), 65536)
	var used uint64
	for i := uint64(0); i < count; i++ {
		var header [46]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(header[:4]) != 0x02014b50 || binary.LittleEndian.Uint16(header[34:36]) != 0 {
			return nil, fmt.Errorf("invalid central directory record")
		}
		skip := uint64(binary.LittleEndian.Uint16(header[28:30])) + uint64(binary.LittleEndian.Uint16(header[30:32])) + uint64(binary.LittleEndian.Uint16(header[32:34]))
		used += 46
		if used > centralBytes || skip > centralBytes-used {
			return nil, fmt.Errorf("invalid central directory extent")
		}
		if _, err := reader.Discard(int(skip)); err != nil {
			return nil, err
		}
		used += skip
	}
	if used != centralBytes {
		return nil, fmt.Errorf("central directory count differs from its records")
	}
	return zip.NewReader(input, size)
}
