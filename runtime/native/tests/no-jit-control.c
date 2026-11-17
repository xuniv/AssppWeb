#define _GNU_SOURCE
#include <errno.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void) {
 size_t n=(size_t)sysconf(_SC_PAGESIZE);
 errno=0;void *p=mmap(0,n,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 if(p!=MAP_FAILED || errno!=EPERM)return 1;
 p=mmap(0,n,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(p==MAP_FAILED)return 2;
 errno=0;if(mprotect(p,n,PROT_READ|PROT_EXEC)!=-1 || errno!=EPERM)return 3;
 return munmap(p,n)!=0;
}
