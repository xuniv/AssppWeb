#ifndef ASSPP_STORE_RUNTIME_H
#define ASSPP_STORE_RUNTIME_H
#ifdef __cplusplus
extern "C" {
#endif
// Configure once with the absolute directory containing verified public .zlib assets.
// Returns 0 on success, 1 for an invalid directory, 2 if configured differently.
int asspp_runtime_configure(const char *asset_directory);
// Serialized blocking call; invoke from a background queue. UTF-8 JSON input and output.
// The returned allocation belongs to the caller and must be freed with the function below.
char *asspp_runtime_call(const char *request_json);
void asspp_runtime_free(char *response_json);
#ifdef __cplusplus
}
#endif
#endif
