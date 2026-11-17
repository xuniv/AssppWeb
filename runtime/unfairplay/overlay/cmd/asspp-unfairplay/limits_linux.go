//go:build linux

package main

import "syscall"

func applyOutputLimit() error {
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		return err
	}
	const ceiling = 4 << 30
	if limit.Cur > ceiling {
		limit.Cur = ceiling
	}
	if limit.Max > ceiling {
		limit.Max = ceiling
	}
	return syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit)
}
