import pathlib
import sys
import os
os.environ["HF_HUB_OFFLINE"] = "0"
from docling.utils.model_downloader import download_models
from faster_whisper.utils import download_model

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
download_models(output_dir=root / "docling", with_code_formula=False, with_picture_classifier=False, progress=True)
download_model("small", output_dir=str(root / "whisper-small"))
