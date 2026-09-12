param([switch]$Advanced, [string]$Python = "python")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$runtime = Join-Path $root ".cache/attachment-python"
if (-not $PSBoundParameters.ContainsKey("Python") -and (Test-Path (Join-Path $root ".cache/attachment-python-base/python.exe"))) {
  $Python = Join-Path $root ".cache/attachment-python-base/python.exe"
}
$resources = Join-Path $PSScriptRoot "../resources/attachments"
if (-not (Test-Path (Join-Path $runtime "Scripts/python.exe"))) {
  & $Python -c "import sys; assert sys.version_info >= (3,10), 'Python 3.10 or later is required'"
  if ($LASTEXITCODE -ne 0) { throw "请安装 Python 3.10 或更新版本，或使用 -Python 指定解释器。" }
  & $Python -m venv $runtime
  if ($LASTEXITCODE -ne 0) { throw "创建附件运行环境失败" }
}
$interpreter = Join-Path $runtime "Scripts/python.exe"
$requirements = if ($Advanced) { "requirements-advanced.txt" } else { "requirements.txt" }
& $interpreter -m pip install -r (Join-Path $resources $requirements)
if ($LASTEXITCODE -ne 0) { throw "安装附件依赖失败" }
if ($Advanced) {
  & $interpreter (Join-Path $resources "setup_models.py") (Join-Path $runtime "models")
  if ($LASTEXITCODE -ne 0) { throw "下载附件模型失败，可重新运行继续下载" }
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or -not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { throw "视频关键帧需要 FFmpeg，请安装后再使用视频解析" }
}
Write-Host "附件组件准备完成，下次启动造物后生效。"
