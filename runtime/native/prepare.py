#!/usr/bin/env python3
"""Prepare the pinned Store engine with native static Unicorn and C ABI adapters."""
import pathlib
import shutil
import subprocess
import sys

REVISION = 'b352566155a667d8aaeabaa7ecec4966080f92ab'
root = pathlib.Path(__file__).resolve().parent
source, destination = map(pathlib.Path, sys.argv[1:])
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if revision != REVISION:
    raise SystemExit('ipatool source does not match the pinned revision')
destination.mkdir(parents=True, exist_ok=True)
for name in ['internal', 'pkg', 'go.mod', 'go.sum', 'LICENSE']:
    src, dst = source / name, destination / name
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copyfile(src, dst)
shutil.copytree(destination / 'internal/sap/assets', destination / 'internal/assppassetsource', dirs_exist_ok=True)
shutil.rmtree(destination / 'pkg/keychain')
(destination / 'pkg/keychain').mkdir()
(destination / 'pkg/keychain/keychain.go').write_text('package keychain\ntype Keychain interface { Get(string)([]byte,error);Set(string,[]byte)error;Remove(string)error }\n')
p = destination / 'pkg/appstore/appstore_revoke.go'
p.write_text(p.read_text().replace('"github.com/byteness/keyring"', '').replace('errors.Is(cacheErr, keyring.ErrKeyNotFound) || ', ''))

# Use only verified packaged images. Never download/extract restore images in the app.
assets = destination / 'internal/sap/assets'
for p in assets.iterdir():
    if p.name != 'assets.go' and p.is_file():
        p.unlink()
(assets / 'remote.go').write_text('package assets\nimport("context";"errors")\nfunc resolveRemoteImage(context.Context)(Bundle,error){return Bundle{},errors.New("packaged Apple assets are required")}\n')
p = assets / 'assets.go'
s = p.read_text().replace('"context"', '"context"\n"compress/zlib"')
start = s.index('func loadBundle(ctx context.Context) (Bundle, error) {')
end = s.index('// Keep only the architecture', start)
s = s[:start]+'''func loadBundle(ctx context.Context) (Bundle,error) {
    if err:=ctx.Err();err!=nil{return Bundle{},err}
    if publicDirectory=="" {return Bundle{},errors.New("public image directory is not configured")}
    return readCache(publicDirectory)
}
var publicDirectory string
func ConfigurePublicDirectory(directory string) error {
    info,err:=os.Stat(directory)
    if err!=nil || !info.IsDir() || !filepath.IsAbs(directory) {return errors.New("invalid public image directory")}
    publicDirectory=filepath.Clean(directory)
    return nil
}
func PublicDirectory() string {return publicDirectory}

'''+s[end:]
needle='file, err := os.Open(path)'
assert s.count(needle)==1
s=s.replace(needle,'''file, err := os.Open(path)
    compressed:=false
    if errors.Is(err,fs.ErrNotExist) {file,err=os.Open(path+".zlib");compressed=true}''')
s=s.replace('if info.Size() != int64(expectedSize) {','if !compressed && info.Size() != int64(expectedSize) {')
s=s.replace('var reader io.Reader = file','''var reader io.Reader = file
    if compressed {
        decoder,decodeErr:=zlib.NewReader(file)
        if decodeErr!=nil{return nil,decodeErr}
        defer decoder.Close()
        reader=decoder
    }
    rawReader:=reader''')
s=s.replace('io.TeeReader(file, digest)','io.TeeReader(reader, digest)')
s=s.replace('io.ReadFull(file, extra[:])','io.ReadFull(rawReader, extra[:])')
p.write_text(s)

# Static libraries are part of the signed host binary on every native platform.
unicorn = destination / 'internal/sap/unicorn'
for name in ['library_unix.go','library_ios.go']:
    (unicorn / name).unlink()
(unicorn / 'library_static.go').write_text('''//go:build darwin || ios || linux
package unicorn
import("context";"fmt";"github.com/ebitengine/purego")
func openLibrary(ctx context.Context)(library,error){
 if err:=ctx.Err();err!=nil{return library{},err}
 if _,err:=purego.Dlsym(purego.RTLD_DEFAULT,"uc_version");err!=nil{return library{},fmt.Errorf("statically linked Unicorn is unavailable: %w",err)}
 return library{handle:purego.RTLD_DEFAULT,close:func()error{return nil}},nil
}
''')
(unicorn / 'shared_native.go').write_text('''package unicorn
// Native guests already have private mappings; sealing is unnecessary for isolation.
func(e *Engine) SealSharedPages()error{return nil}
''')

# Keep the same protocol dispatch and error mapping as the browser adapter.
cmd=destination / 'cmd/asspp-runtime'
cmd.mkdir(parents=True,exist_ok=True)
s=(root.parent / 'overlay/cmd/asspp-runtime/main.go').read_text()
s=s[:s.index('func main() {')]
for unused in ['runtime','runtime/debug','syscall/js','github.com/rs/zerolog']:
    s=s.replace('\t"'+unused+'"\n','')
s=s.replace('result.Error = err.Error()', 'result.Error = failureCode(err)')
(cmd / 'core.go').write_text(s)
for name in ['bridge_preflight.go','memory_preflight.go']:
    shutil.copyfile(root.parent / 'overlay/cmd/asspp-runtime' / name, cmd / name)
shutil.copytree(root.parent / 'overlay/pkg',destination / 'pkg',dirs_exist_ok=True)
shutil.copytree(root / 'overlay',destination,dirs_exist_ok=True)
assetcmd=destination / 'cmd/asspp-assets'
assetcmd.mkdir(parents=True,exist_ok=True)
shutil.copyfile(root.parent / 'overlay/cmd/asspp-assets/main.go',assetcmd / 'main.go')
p=destination / 'internal/storeauth/http_client.go'
s=p.read_text()
needle='transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}'
assert s.count(needle)==1
s=s.replace(needle,'transport.TLSClientConfig = transport.TLSClientConfig.Clone()\ntransport.TLSClientConfig.MinVersion = tls.VersionTLS12')
p.write_text(s)

# Public Apple Root CA is already pinned. A TLS failure must never install
# environment/system roots or create a second transport outside the host policy.
p=destination / 'internal/storeauth/anisette.go'
s=p.read_text()
start=s.index('\tif isUnknownAuthority(err) {')
end=s.index('\tif err != nil {',start)
s=s[:start]+s[end:]
p.write_text(s)
