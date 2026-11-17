// Server mode transfers credentials, so a remote HTTP origin is unsuitable.
export function serverRuntimeTransportAllowed(): boolean {
  return location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
}
