#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "AssppStoreRuntime.h"
static int error_code(char *value,const char *code) {
 int match=value && strstr(value,code)!=0;
 asspp_runtime_free(value);return match;
}
int main(int argc,char **argv) {
 if(argc!=3)return 2;
 if(!error_code(asspp_runtime_call("{}"),"runtime_not_configured"))return 3;
 if(asspp_runtime_configure(0)!=1 || asspp_runtime_configure("relative")!=1)return 4;
 if(asspp_runtime_configure(argv[1])!=0 || asspp_runtime_configure(argv[1])!=0)return 5;
 if(asspp_runtime_configure("/another-public-image-directory")!=2)return 6;
 if(!error_code(asspp_runtime_call(0),"invalid_request"))return 7;
 if(!error_code(asspp_runtime_call("{"),"invalid_request"))return 8;
 char *large=malloc((8<<20)+2);if(!large)return 9;
 memset(large,'x',(8<<20)+1);large[(8<<20)+1]=0;
 int bounded=error_code(asspp_runtime_call(large),"invalid_request");free(large);if(!bounded)return 10;
 char request[256];snprintf(request,sizeof(request),"{\"operation\":\"%s\",\"deviceID\":\"020000000001\",\"state\":{}}",argv[2]);
 char *out=asspp_runtime_call(request);if(!out)return 11;
 int ok=strstr(out,"\"ok\":true")!=0;
 puts(out);asspp_runtime_free(out);return ok?0:12;
}
