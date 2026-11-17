package assppunfair

import (
	"context"
	"os"

	"github.com/DrWhax/unfairplay/pkg/fairplay"
)

type scratchFactory struct {
	ctx       context.Context
	directory string
	files     []*scratchFile
}

func newScratchFactory(ctx context.Context) *scratchFactory {
	return &scratchFactory{ctx: ctx}
}
func (s *scratchFactory) create(size int64) (fairplay.StreamFile, error) {
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	if size < 0 || size > fairplay.MaximumPortableArchiveBytes {
		return nil, ErrOutputLimit
	}
	if s.directory == "" {
		directory, err := os.MkdirTemp("", "asspp-unfairplay-")
		if err != nil {
			return nil, err
		}
		s.directory = directory
	}
	file, err := os.CreateTemp(s.directory, "image-")
	if err != nil {
		return nil, err
	}
	// All native targets are POSIX. Unlink before any image data is written:
	// the descriptor remains usable and process exit cannot retain plaintext.
	if err := os.Remove(file.Name()); err != nil {
		_ = file.Close()
		return nil, err
	}
	result := &scratchFile{File: file, ctx: s.ctx}
	s.files = append(s.files, result)
	if err = file.Truncate(size); err != nil {
		result.Close()
		return nil, err
	}
	return result, nil
}
func (s *scratchFactory) clear() {
	for _, file := range s.files {
		_ = file.Close()
	}
	if s.directory != "" {
		_ = os.RemoveAll(s.directory)
	}
}

type scratchFile struct {
	*os.File
	ctx context.Context
}

func (f *scratchFile) ReadAt(data []byte, offset int64) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.File.ReadAt(data, offset)
}
func (f *scratchFile) Write(data []byte) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.File.Write(data)
}
func (f *scratchFile) WriteAt(data []byte, offset int64) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	if offset < 0 || int64(len(data)) > fairplay.MaximumPortableArchiveBytes-offset {
		return 0, ErrOutputLimit
	}
	return f.File.WriteAt(data, offset)
}
func (f *scratchFile) Truncate(size int64) error {
	if size < 0 || size > fairplay.MaximumPortableArchiveBytes {
		return ErrOutputLimit
	}
	return f.File.Truncate(size)
}
func (f *scratchFile) Close() error { return f.File.Close() }
