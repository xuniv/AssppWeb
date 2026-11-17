//go:build linux && asspp_native_cli

package main

/*
#cgo LDFLAGS: -L${SRCDIR}/native-static -lunicorn -lpthread -lm
extern unsigned int uc_version(unsigned int *, unsigned int *);
// Retain the public API object so RTLD_DEFAULT can resolve its exported symbols.
__attribute__((constructor)) static void asspp_retain_unicorn(void) {
    (void)uc_version(0, 0);
}
*/
import "C"
