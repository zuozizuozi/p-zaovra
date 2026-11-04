// Python 3 stdlib runs inside the selected distro. No archive code is executed.
export const wslUpgradeProgram = String.raw`import os,sys,json,sqlite3,shutil,tempfile,time,stat
from contextlib import closing
from pathlib import Path
channel,profile,mode,shared,action=sys.argv[1:]
if channel not in ('dev','beta','prod') or len(profile)!=16 or any(c not in '0123456789abcdef' for c in profile): raise RuntimeError('Invalid WSL profile identity')
root=Path.home()/'.local/share/zaovra-desktop'/channel/profile
target=root/'backend'
def linked(path):
 try: return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
 except FileNotFoundError: return False
def links(path):
 return any(linked(p) for p in (path,*path.parents))
def exists(path): return os.path.lexists(str(path))
if links(root): raise RuntimeError('Linked WSL profile is not supported')
if exists(target):
 if links(target) or links(target/'upgrade.json'): raise RuntimeError('Linked upgrade destination')
 marker=json.loads((target/'upgrade.json').read_text())
 if type(marker.get('version')) is not int or marker != {'version':1,'channel':channel,'profile':profile,'action':marker.get('action')} or marker.get('action') not in ('import','empty'): raise RuntimeError('WSL upgrade identity mismatch')
 print(json.dumps({'completed':True,'action':marker['action']})); sys.exit(0)
private=(root/'data/zaovra',root/'config/zaovra')
def populated(paths): return any(exists(p) and not links(p) and p.is_dir() and any(p.iterdir()) for p in paths)
source=private if channel=='beta' or populated(private) or shared!='true' else (Path.home()/'.local/share/zaovra',Path.home()/'.config/zaovra')
available=channel!='beta' and populated(source)
if mode=='probe': print(json.dumps({'completed':False,'available':available})); sys.exit(0)
if mode!='migrate' or action not in ('import','empty'): raise RuntimeError('Invalid WSL migration action')
if action=='import' and not available: raise RuntimeError('Legacy WSL data is no longer available')
if channel=='beta' and action!='empty': raise RuntimeError('Beta must start empty')
root.mkdir(mode=0o700,parents=True,exist_ok=True)
stage=Path(tempfile.mkdtemp(prefix='.backend-upgrade-',dir=str(root)))
# Never follow a linked root, directory, database or configuration.
def copy_tree(src,dst,data):
 dst.mkdir(mode=0o700,parents=True,exist_ok=False)
 if not exists(src) or links(src): return
 for entry in src.iterdir():
  if linked(entry): continue
  name=entry.name.lower()
  if data and (name.endswith(('.db','.sqlite','.sqlite3','-wal','-shm','-journal'))): continue
  if entry.is_dir(): copy_tree(entry,dst/entry.name,data)
  elif stat.S_ISREG(entry.lstat().st_mode):
   with entry.open('rb') as r, (dst/entry.name).open('xb') as w: shutil.copyfileobj(r,w)
   os.chmod(str(dst/entry.name),0o600)
  else: raise RuntimeError('Unsupported legacy file type')
(stage/'data').mkdir(mode=0o700); (stage/'config').mkdir(mode=0o700)
if action=='import':
 copy_tree(source[0],stage/'data/zaovra',True); copy_tree(source[1],stage/'config/zaovra',False)
 candidates=['zaovra.db'] if source==private or channel!='dev' else ['zaovra-dev.db','zaovra.db']
 database=next((source[0]/name for name in candidates if exists(source[0]/name)),None)
 if database and not links(database):
  if not database.is_file(): raise RuntimeError('Legacy database is not a regular file')
  output=stage/'data/zaovra/zaovra.db'
  deadline=time.monotonic()+15
  def progress(status,remaining,total):
   if time.monotonic()>deadline: raise RuntimeError('WSL database backup timed out')
  with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)) as old, closing(sqlite3.connect(str(output))) as new:
   old.backup(new,pages=256,progress=progress,sleep=0.05)
   if new.execute('PRAGMA quick_check').fetchall()!=[('ok',)]: raise RuntimeError('Imported WSL database failed integrity validation')
  os.chmod(str(output),0o600)
else:
 (stage/'data/zaovra').mkdir(mode=0o700); (stage/'config/zaovra').mkdir(mode=0o700)
with (stage/'upgrade.json').open('x') as f: json.dump({'version':1,'channel':channel,'profile':profile,'action':action},f); f.flush(); os.fsync(f.fileno())
os.chmod(str(stage/'upgrade.json'),0o600)
if exists(target): raise RuntimeError('WSL upgrade destination appeared during staging')
os.rename(str(stage),str(target))
print(json.dumps({'completed':True,'action':action}))
`
