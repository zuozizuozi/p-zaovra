"""Read bounded report JSON from an artifact ZIP without extracting or executing it."""
import io
import json
import re
import stat
import sys
import zipfile
from pathlib import PurePosixPath

def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result

def invalid_constant(value):
    raise ValueError("Invalid JSON constant")

body = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
if len(body) > 8 * 1024 * 1024:
    raise ValueError("Archive too large")
with zipfile.ZipFile(io.BytesIO(body)) as archive:
    entries = archive.infolist()
    if not entries or len(entries) > 512 or sum(item.file_size for item in entries) > 16 * 1024 * 1024:
        raise ValueError("Archive limits")
    names = []
    for item in entries:
        path = PurePosixPath(item.filename)
        if (item.filename.startswith("/") or "\\" in item.filename or ":" in item.filename or
                any(part in ["", ".", ".."] for part in item.filename.rstrip("/").split("/")) or
                len(path.parts) != (1 if item.is_dir() else 2) or
                not re.fullmatch(r"zaovra-tests-[0-9a-f-]{36}", path.parts[0]) or
                stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
            raise ValueError("Unsafe archive entry")
        names.append(item.filename)
    if len(set(names)) != len(names) or len(set(PurePosixPath(name).parts[0] for name in names)) != 1:
        raise ValueError("Ambiguous report archive")
    prefix = PurePosixPath(names[0]).parts[0] + "/"
    def read(name):
        return json.loads(archive.read(prefix + name), object_pairs_hook=unique, parse_constant=invalid_constant)
    print(json.dumps({
        "plan": read("plan.json"),
        "results": read("results.json"),
        "scrollbackManifest": read("scrollback-manifest.json"),
        "files": [PurePosixPath(item.filename).name for item in entries if not item.is_dir()],
    }, allow_nan=False))
