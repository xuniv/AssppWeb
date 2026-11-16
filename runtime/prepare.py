#!/usr/bin/env python3
"""Apply the browser-only adapters to an exact, unmodified ipatool checkout."""
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
for name in ['internal/sap/unicorn', 'pkg/keychain']:
    shutil.rmtree(destination / name)
    (destination / name).mkdir(parents=True)
assets = destination / 'internal/sap/assets'
shutil.copytree(assets, destination / 'internal/assppassetsource', dirs_exist_ok=True)
for path in assets.iterdir():
    if path.name != 'assets.go' and path.is_file():
        path.unlink()
(assets / 'remote.go').write_text('''package assets
import ("context";"errors")
func resolveRemoteImage(context.Context)(Bundle,error){return Bundle{},errors.New("verified public Apple assets must be installed before starting the runtime")}
''')
path = assets / 'assets.go'
text = path.read_text()
needle = 'var reader io.Reader = file'
assert text.count(needle) == 1
text = text.replace(needle, 'var reader io.Reader = boundedReader{file}')
text = text.replace('io.TeeReader(file, digest)', 'io.TeeReader(reader, digest)')
text += '''
// Bound syscall/js's Uint8Array staging allocation, even for io.ReadFull(image).
type boundedReader struct { io.Reader }
func (r boundedReader) Read(p []byte) (int,error) { return r.Reader.Read(p[:min(len(p),64<<10)]) }
'''
path.write_text(text)
path = destination / 'internal/sap/machine/machine.go'
text = path.read_text()
text = text.replace('"math"', '"math"\n"sort"')
for mapping in ['functions', 'slots']:
    needle = 'for address, name := range '+mapping+' {'
    assert text.count(needle) == 1
    text = text.replace(needle, '''addresses := make([]uint64, 0, len('''+mapping+'''))
    for address := range '''+mapping+''' { addresses = append(addresses, address) }
    sort.Slice(addresses, func(i,j int)bool{return addresses[i]<addresses[j]})
    for _, address := range addresses { name := '''+mapping+'''[address]''')
needle = '\tready = true\n\n\treturn machine, exports, nil'
assert text.count(needle) == 1
text = text.replace(needle, '''// Intern immutable image pages before loading another ADI guest, rather
    // than retaining four complete private image copies until first execution.
    if err := engine.SealSharedPages(); err != nil { return nil, nil, err }
'''+needle)
path.write_text(text)
(destination / 'pkg/keychain/keychain.go').write_text('package keychain\ntype Keychain interface { Get(string)([]byte,error);Set(string,[]byte)error;Remove(string)error }\n')
path = destination / 'pkg/appstore/appstore_revoke.go'
text = path.read_text().replace('"github.com/byteness/keyring"', '').replace('errors.Is(cacheErr, keyring.ErrKeyNotFound) || ', '')
path.write_text(text)
shutil.copytree(root / 'overlay', destination, dirs_exist_ok=True)
path = destination / 'internal/storeauth/http_client.go'
text = path.read_text()
needle = 'transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}'
assert text.count(needle) == 1
text = text.replace(needle, 'transport.TLSClientConfig = transport.TLSClientConfig.Clone()\ntransport.TLSClientConfig.MinVersion = tls.VersionTLS12')
path.write_text(text)
path = destination / 'internal/store/emulator/runtime.go'
text = path.read_text()
needle = 'r.hook, err = engine.AddCodeHook(0, ^uint64(0), r.step)'
assert text.count(needle) == 1
text = text.replace(needle, '''engine.SetDispatchSource(func() ([]uint64, [][2]uint64) {
        points := make([]uint64, 0, len(r.calls)+len(r.callbacks)+len(r.entries))
        for address := range r.calls { points = append(points, address) }
        for address := range r.callbacks { points = append(points, address) }
        for address := range r.entries { points = append(points, address) }
        return points, r.codeRanges
    })
    '''+needle)
path.write_text(text)
