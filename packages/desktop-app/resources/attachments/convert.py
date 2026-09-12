"""Local attachment conversion. Receives only a private temporary file, never a URL."""
import base64
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

MAX_EXPANDED = 100 * 1024 * 1024
MAX_OUTPUT = 200_000
OFFICE = {".docx", ".xlsx", ".pptx"}
AUDIO = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"}
VIDEO = {".mp4", ".webm", ".mov", ".mkv"}
TEXT = {".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".js", ".ts", ".tsx", ".py", ".html", ".css"}


def check_archive(data):
    archive = zipfile.ZipFile(io.BytesIO(data))
    entries = archive.infolist()
    if len(entries) > 500 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
        raise ValueError("压缩内容过大：最多 500 个文件、展开后 100 MB。")
    for entry in entries:
        path = pathlib.PurePosixPath(entry.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts or ":" in entry.filename:
            raise ValueError("压缩包包含不安全路径，未处理。")
        if entry.flag_bits & 1:
            raise ValueError("暂不支持加密文件，请解密后重新添加。")
        if entry.file_size > max(entry.compress_size, 1) * 200:
            raise ValueError("压缩比例异常，请解压后选择所需文件。")
    return archive


def document(data, suffix):
    from markitdown import MarkItDown, StreamInfo
    if suffix in OFFICE:
        with check_archive(data):
            pass
    result = MarkItDown(enable_plugins=False).convert_stream(io.BytesIO(data), stream_info=StreamInfo(extension=suffix))
    return result.markdown


def convert(path):
    suffix = path.suffix.lower()
    warnings = []
    images = []
    if suffix == ".zip":
        parts = []
        with check_archive(path.read_bytes()) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                ext = pathlib.PurePosixPath(entry.filename).suffix.lower()
                if ext not in OFFICE | TEXT | {".pdf"}:
                    warnings.append(f"未读取：{entry.filename}（不支持的成员类型）")
                    continue
                try:
                    text = document(archive.read(entry), ext)
                    if not text.strip():
                        warnings.append(f"未提取到文字：{entry.filename}")
                    parts.append(f"## 文件：{entry.filename}\n\n{text}")
                    if sum(map(len, parts)) > MAX_OUTPUT:
                        raise ValueError("解析内容过长，请选择压缩包中的部分文件。")
                except ValueError:
                    raise
                except Exception:
                    warnings.append(f"读取失败：{entry.filename}")
        text = "\n\n".join(parts)
        warnings.append("压缩包按文字和表格提取；其中扫描 PDF 请单独添加以识别图片中的文字。")
    elif suffix in AUDIO | VIDEO:
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], check=True, timeout=30, capture_output=True)
        metadata = json.loads(probe.stdout)
        duration = float(metadata.get("format", {}).get("duration", 0))
        if duration <= 0 or duration > 900:
            raise ValueError("音视频需在 15 分钟以内，请截取片段后重试。")
        parts = []
        if any(stream.get("codec_type") == "audio" for stream in metadata["streams"]):
            from faster_whisper import WhisperModel
            model = pathlib.Path(os.environ["ZAOVRA_ATTACHMENT_MODELS"]) / "whisper-small"
            if not (model / "model.bin").is_file():
                raise ValueError("音视频模型未安装，请运行附件高级组件安装脚本后重试。")
            segments, _ = WhisperModel(str(model), device="cpu", compute_type="int8").transcribe(str(path), vad_filter=True)
            for segment in segments:
                parts.append(f"[{segment.start:.1f}s – {segment.end:.1f}s] {segment.text}")
                if sum(map(len, parts)) > MAX_OUTPUT:
                    raise ValueError("转录内容过长，请截取较短片段。")
        text = "# 音轨转录\n\n" + "\n".join(parts) if parts else ""
        if not parts:
            warnings.append("未识别到语音，可能没有音轨或只有静音、音乐。")
        if suffix in VIDEO:
            with tempfile.TemporaryDirectory(prefix="zaovra-frames-") as directory:
                count = min(8, max(1, int(duration / 15) + 1))
                for index in range(count):
                    second = duration * index / count
                    frame = pathlib.Path(directory) / f"{index}.jpg"
                    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(second), "-i", str(path), "-vf", "scale=960:-2", "-frames:v", "1", str(frame)], check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    if frame.is_file():
                        images.append({"name": f"frame-{second:.1f}s.jpg", "mime": "image/jpeg", "data": base64.b64encode(frame.read_bytes()).decode()})
            warnings.append("视频在全片均匀抽取最多 8 帧；只包含识别出的语音和抽样画面，不代表完整视频。")
        if not text and not images:
            raise ValueError("未识别到语音，请检查音轨或选择包含清晰讲话的片段。")
    elif suffix == ".pdf":
        artifacts = pathlib.Path(os.environ.get("ZAOVRA_ATTACHMENT_MODELS", "")) / "docling"
        if artifacts.is_dir():
            from docling.document_converter import DocumentConverter, PdfFormatOption
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
            options = PdfPipelineOptions(artifacts_path=artifacts, enable_remote_services=False, ocr_options=RapidOcrOptions())
            result = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}).convert(path, max_num_pages=100)
            text = result.document.export_to_markdown()
            warnings.append("已进行版面解析和文字识别；识别文字、表格及阅读顺序请对照原件核对。")
        else:
            text = document(path.read_bytes(), suffix)
            warnings.append("当前仅提取 PDF 文字层；扫描页和图片内容需要安装高级附件组件。")
    elif suffix in OFFICE | TEXT:
        text = document(path.read_bytes(), suffix)
        if suffix in OFFICE:
            warnings.append("已提取文字和表格；嵌入图片、图表的视觉内容请另行添加截图。")
        if suffix == ".xlsx":
            warnings.append("表格按已保存内容提取，不会重新计算公式；涉及公式的结果请核对原表。")
    else:
        raise ValueError("暂不支持此文件类型。")
    if not text.strip() and not images:
        raise ValueError("没有提取到可读内容，请检查文件是否为空或加密。")
    if len(text) > MAX_OUTPUT:
        raise ValueError("解析内容超过 20 万字符，请拆分文件后重试。")
    return {"text": text, "warnings": warnings, "images": images}


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = convert(pathlib.Path(sys.argv[1]))
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    except ImportError:
        print(json.dumps({"ok": False, "error": "附件解析组件未安装完整，请运行附件组件安装脚本后重试。"}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
