#!/usr/bin/env python3
"""Install the pinned portable source and inspectable adapters; never private data."""
import pathlib,shutil,subprocess,sys

REVISION='d7503082a59e3dcfdd3ea7a70434dcecaaaf07df'
ROOT=pathlib.Path(__file__).resolve().parent

def install(source,destination,combined=False):
    source,destination=map(pathlib.Path,(source,destination))
    actual=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if actual!=REVISION:raise SystemExit('UnfairPlay source revision mismatch')
    destination.mkdir(parents=True,exist_ok=True)
    if not combined:
        for name in ['go.mod','go.sum']:shutil.copyfile(source/name,destination/name)
    targets=[(source/'pkg/fairplay',destination/('internal/unfairplay' if combined else 'pkg/fairplay')),
             (source/'internal/scinfo',destination/('internal/unfairscinfo' if combined else 'internal/scinfo'))]
    for origin,target in targets:
        if target.exists():shutil.rmtree(target)
        target.mkdir(parents=True)
        for item in origin.glob('*.go'):shutil.copyfile(item,target/item.name)
    shutil.copytree(ROOT/'overlay',destination,dirs_exist_ok=True)
    if combined:
        target=destination/'internal/unfairplay'
        shutil.copytree(ROOT/'overlay/pkg/fairplay',target,dirs_exist_ok=True)
        shutil.rmtree(destination/'pkg/fairplay')
        # The standalone CLI is a separate executable, never another iOS archive.
        shutil.rmtree(destination/'cmd/asspp-unfairplay',ignore_errors=True)
    old='github.com/DrWhax/unfairplay/'
    new='github.com/majd/ipatool/v2/'
    if combined:
        for folder in ['internal/unfairplay','internal/unfairscinfo','internal/assppunfair']:
            for path in (destination/folder).rglob('*.go'):
                text=path.read_text().replace(old+'pkg/fairplay',new+'internal/unfairplay').replace(old+'internal/scinfo',new+'internal/unfairscinfo')
                path.write_text(text)

if __name__=='__main__':
    if len(sys.argv) not in [3,4]:raise SystemExit('source destination [--combined] required')
    install(sys.argv[1],sys.argv[2],len(sys.argv)==4 and sys.argv[3]=='--combined')
