#define _GNU_SOURCE
#include <stddef.h>
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <stdlib.h>
#include <unistd.h>
/* Deny anonymous executable mappings and every transition adding execute.
 * Existing file-backed executable libraries remain loadable. Linux fixture. */
__attribute__((constructor)) static void deny_jit(void) {
 struct sock_filter insn[] = {
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data,nr)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_mprotect, 0, 3),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data,args[2])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, PROT_EXEC, 0, 6),
  BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_mmap, 0, 4),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data,args[2])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, PROT_EXEC, 0, 2),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data,args[3])),
  BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, MAP_ANONYMOUS, 1, 0),
  BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
  BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
 };
 struct sock_fprog prog={.len=sizeof(insn)/sizeof(insn[0]),.filter=insn};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&prog)) _exit(125);
}
