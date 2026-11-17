// Package kbsync implements the 212-byte Store hardware6 KBSync packet in pure Go.
//
// Recovered arithmetic is ported from MIT apple-auth v0.1.3, commit
// 98c862f7bebc8283a9b87f1578e703f0765dc81d. See NOTICE and LICENSE.
// This isolated implementation has offline interoperability evidence only;
// packet generation does not establish Apple server acceptance.
package kbsync

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"io"
	"math/bits"
)

const PacketSize = 212
const entropySize = 1024

var (
	ErrInput   = errors.New("kbsync: expected nonzero DSID and six-byte hardware")
	ErrEntropy = errors.New("kbsync: entropy exhausted")
	ErrPacket  = errors.New("kbsync: packet authentication or format mismatch")
)

// Generate uses fresh cryptographic randomness. It performs no network or file IO.
func Generate(dsid uint64, hardware []byte) ([]byte, error) {
	return GenerateWithReader(dsid, hardware, rand.Reader)
}

// GenerateWithReader accepts a cryptographic random source. Tests may supply
// synthetic entropy; production callers should normally use Generate.
// It reads exactly 1024 bytes, providing a bounded failure for a broken source.
func GenerateWithReader(dsid uint64, hardware []byte, random io.Reader) ([]byte, error) {
	if dsid == 0 || len(hardware) != 6 {
		return nil, ErrInput
	}
	if random == nil {
		return nil, ErrEntropy
	}
	var entropy [entropySize]byte
	if _, err := io.ReadFull(random, entropy[:]); err != nil {
		return nil, err
	}
	defer clear(entropy[:])
	return generate(dsid, hardware, entropy[:])
}

func sampleNonzero(entropy []byte, n int) ([]byte, int, error) {
	out := make([]byte, 0, n)
	for i, b := range entropy {
		if b != 0 {
			out = append(out, b)
		}
		if len(out) == n {
			return out, i + 1, nil
		}
	}
	return nil, 0, ErrEntropy
}

func generate(dsid uint64, hardware, entropy []byte) ([]byte, error) {
	state, used, err := sampleNonzero(entropy, 144)
	if err != nil {
		return nil, err
	}
	defer clear(state)
	payload, n, err := sampleNonzero(entropy[used:], 48)
	if err != nil {
		return nil, err
	}
	defer clear(payload)
	used += n
	if len(entropy)-used < 32 {
		return nil, ErrEntropy
	}
	record := makeRecord(state, payload, entropy[used:used+32])
	used += 32
	defer clear(record[:])
	context, _, err := sampleNonzero(entropy[used:], 12)
	if err != nil {
		return nil, err
	}
	key := deriveInnerKey(dsid, hardware, context)
	defer clear(key[:])
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	packet := make([]byte, PacketSize)
	packet[1] = 4
	packet[3] = 3
	copy(packet[4:16], context)
	// Upstream's record/input/output storage codecs each use 0xed and cancel.
	// The resulting wire payload is ordinary AES-128-CBC over the logical record.
	cipher.NewCBCEncrypter(block, packetIv[:]).CryptBlocks(packet[16:192], record[:])
	tag := packetMAC(key, packet[:192])
	copy(packet[192:], tag)
	return packet, nil
}

func makeRecord(state, payload, randomness []byte) (logical [176]byte) {
	logical[3] = 156
	for _, offset := range recordWordOffsets {
		var word uint32
		for j, fixed := range fixedRecordOffsets {
			if fixed == offset {
				word = fixedRecordWords[j]
			}
		}
		for j, padded := range paddedRecordOffsets {
			if padded == offset {
				value := paddedRecordValues[j]
				width := uint32(bits.Len32(value))
				if width == 0 {
					width = 1
				}
				random := binary.BigEndian.Uint32(randomness[4*j : 4*j+4])
				word = ((random << width) & freshValues[0]) | (width << 27) | value
			}
		}
		if offset == 50 {
			word = binary.BigEndian.Uint32(randomness[28:32])
		}
		binary.BigEndian.PutUint32(logical[offset:offset+4], word)
	}
	logical[28] = 1
	logical[41] = 2
	logical[110] = 1
	logical[119] = 1
	copy(logical[54:102], payload)
	start := int(state[0]) % 111
	copy(logical[144:160], state[start:start+16])
	return
}

func packetMAC(key [16]byte, packet []byte) []byte {
	var macKey [16]byte
	for i := range macKey {
		macKey[i] = key[i] ^ macKeyMask[i]
	}
	defer clear(macKey[:])
	mac := hmac.New(sha1.New, macKey[:])
	_, _ = mac.Write(packet)
	return mac.Sum(nil)
}

func deriveInnerKey(dsid uint64, hardware, context []byte) (key [16]byte) {
	body := prehashTemplate
	for i, b := range hardware {
		body[i] ^= b
	}
	for i, b := range context {
		body[len(hardware)+i] ^= b
	}
	for i := 0; i < len(hardware)+8; i++ {
		body[i] = scrambleByte(uint32(i), body[i])
	}
	prefix := prehashBytes(body[:len(hardware)+20])
	copy(body[:16], prefix[:])
	for i := range body {
		body[i] ^= byte(prehashValues[1])
	}
	var message [263]byte
	binary.BigEndian.PutUint64(message[:8], dsid)
	copy(message[8:], body[:])
	digest := md5.Sum(message[:])
	defer clear(message[:])
	defer clear(body[:])
	for i := range digest {
		digest[i] ^= posthashInputMask[i]
	}
	block, err := aes.NewCipher(posthashKey[:])
	if err != nil {
		panic("kbsync: fixed AES key dimensions")
	}
	block.Encrypt(key[:], digest[:])
	for i := range key {
		key[i] ^= posthashOutputMask[i]
	}
	clear(digest[:])
	return
}

func prehashBytes(input []byte) (output [16]byte) {
	var state [319]byte
	for i := range state {
		state[i] = input[i%len(input)]
	}
	for i := uint32(0); i < 1276; i++ {
		one, two, three := state[(i-13)%319], state[(i-57)%319], state[(i-155)%319]
		mixed := state[i%319] ^ bits.RotateLeft8(one, 3) ^ byte(prehashValues[0])
		added := mixed + bits.RotateLeft8(two^byte(prehashValues[1]), 5) - bits.RotateLeft8(three^byte(prehashValues[1]), 7)
		state[i%319] = added ^ byte(prehashValues[1])
	}
	table, pad := prehashTable, prehashPad
	prehashByteKernel(&table, &state, &pad, &prehashSourcePad, &output)
	for i := 0; i < 64; i++ {
		output[i&15] ^= pad[i]
	}
	for i := 0; i < 64; i++ {
		output[i&15] ^= table[i] ^ byte(prehashValues[1])
	}
	for i := range state {
		output[i&15] ^= state[i] ^ byte(prehashValues[1])
	}
	for i := uint32(0); i < 256; i++ {
		output[i&15] ^= byte(prehashValues[2]) ^ bits.RotateLeft8(output[(i-7)&15], 1) ^ bits.RotateLeft8(output[(i-37)&15], 6) ^ bits.RotateLeft8(output[(i-177)&15], 5)
	}
	clear(state[:])
	clear(table[:])
	clear(pad[:])
	return
}

func scrambleByte(index uint32, value byte) byte {
	v := uint32(value)
	first := byte((v ^ prehashValues[3]) + prehashValues[4])
	second := byte((v ^ prehashValues[5]) - prehashValues[5])
	third := byte((v ^ prehashValues[6]) - prehashValues[6])
	temporary := byte((index ^ 1) - ((index + prehashValues[7]) ^ prehashValues[8]) + uint32(third^first^second))
	folded := byte(uint32(temporary) + prehashValues[9])
	temporary = byte(((prehashValues[10] - uint32(temporary)) & prehashValues[11]) | prehashValues[12])
	temporary ^= folded & byte(prehashValues[13])
	mixed := (folded & 6) ^ temporary
	mixed = ((folded ^ 4) & (mixed << 1)) ^ temporary
	for i := 0; i < 4; i++ {
		mixed = ((folded ^ byte(prehashValues[14])) & (mixed << 1)) ^ temporary
	}
	return folded ^ (mixed << 1) ^ byte(prehashValues[15])
}

// Validate authenticates the MAC and checks the recovered record structure.
// It does not send the packet, derive account credentials or contact Apple.
func Validate(dsid uint64, hardware, packet []byte) error {
	if dsid == 0 || len(hardware) != 6 {
		return ErrInput
	}
	if len(packet) != PacketSize || packet[0] != 0 || packet[1] != 4 || packet[2] != 0 || packet[3] != 3 {
		return ErrPacket
	}
	for _, b := range packet[4:16] {
		if b == 0 {
			return ErrPacket
		}
	}
	key := deriveInnerKey(dsid, hardware, packet[4:16])
	defer clear(key[:])
	if !hmac.Equal(packetMAC(key, packet[:192]), packet[192:]) {
		return ErrPacket
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return ErrPacket
	}
	var plain [176]byte
	defer clear(plain[:])
	cipher.NewCBCDecrypter(block, packetIv[:]).CryptBlocks(plain[:], packet[16:192])
	// Compare fixed/reserved bytes and the fixed bits of padded integers. Only
	// documented payload, trailer, padding and entropy-word fields may vary.
	nonzero := make([]byte, 144)
	for i := range nonzero {
		nonzero[i] = 1
	}
	expected := makeRecord(nonzero, nonzero[:48], make([]byte, 32))
	var mask [176]byte
	for i := range mask {
		mask[i] = 255
	}
	for i := 54; i < 102; i++ {
		mask[i] = 0
		if plain[i] == 0 {
			return ErrPacket
		}
	}
	for i := 144; i < 160; i++ {
		mask[i] = 0
		if plain[i] == 0 {
			return ErrPacket
		}
	}
	for i := 50; i < 54; i++ {
		mask[i] = 0
	}
	for j, offset := range paddedRecordOffsets {
		width := uint32(bits.Len32(paddedRecordValues[j]))
		if width == 0 {
			width = 1
		}
		fixedMask := uint32(0xf8000000) | ((uint32(1) << width) - 1)
		binary.BigEndian.PutUint32(mask[offset:offset+4], fixedMask)
	}
	for i := range plain {
		if plain[i]&mask[i] != expected[i]&mask[i] {
			return ErrPacket
		}
	}
	return nil
}
