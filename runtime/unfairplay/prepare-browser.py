#!/usr/bin/env python3
"""Prepare the pinned, pure-Go UnfairPlay package without native collection tools."""
import pathlib,shutil,subprocess,sys
REVISION='d7503082a59e3dcfdd3ea7a70434dcecaaaf07df'
root=pathlib.Path(__file__).resolve().parent
source,destination=map(pathlib.Path,sys.argv[1:])
if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=REVISION:raise SystemExit('UnfairPlay source revision mismatch')
destination.mkdir(parents=True,exist_ok=True)
for name in ['go.mod','go.sum','pkg/fairplay','internal/scinfo']:
 src,dst=source/name,destination/name
 dst.parent.mkdir(parents=True,exist_ok=True)
 if src.is_dir():shutil.copytree(src,dst,dirs_exist_ok=True)
 else:shutil.copyfile(src,dst)
shutil.copytree(root/'overlay',destination,dirs_exist_ok=True)
