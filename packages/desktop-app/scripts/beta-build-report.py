import sys,io,zipfile,json,stat
body=sys.stdin.buffer.read(256*1024*1024+1)
if len(body)>256*1024*1024: raise ValueError('archive limit')
with zipfile.ZipFile(io.BytesIO(body)) as z:
 entries=z.infolist();names=[e.filename for e in entries]
 expected={'zaovra-desktop-win-x64.exe','zaovra-desktop-win-x64.exe.blockmap','beta.yml','notes.md','ci-gate.json'}
 if len(names)!=5 or set(names)!=expected: raise ValueError('build artifact inventory')
 if sum(e.file_size for e in entries)>512*1024*1024: raise ValueError('expansion limit')
 for e in entries:
  if e.flag_bits&1 or stat.S_ISLNK(e.external_attr>>16): raise ValueError('unsafe archive')
 e=z.getinfo('ci-gate.json')
 if e.file_size>65536: raise ValueError('metadata limit')
 def unique(pairs):
  out={}
  for k,v in pairs:
   if k in out: raise ValueError('duplicate JSON key')
   out[k]=v
  return out
 value=json.loads(z.read(e),object_pairs_hook=unique)
 print(json.dumps(value))
