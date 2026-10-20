"""Build the OCRFlow installation package and a source archive."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import json
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path, default=root / "dist", help="Output directory (default: project dist/)")
args = parser.parse_args()
manifest = json.loads((root / "manifest.json").read_text())
for field in ("id", "update_url", "strict_max_version"):
    if not manifest.get("applications", {}).get("zotero", {}).get(field):
        raise ValueError(f"Zotero requires applications.zotero.{field}")
version = manifest["version"]
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
assets = [
    "manifest.json", "bootstrap.js", "docflow.js", "markitdown.js", "metadata.js", "workflow.js",
    "outline.js", "preferences.js", "preferences.xhtml",
    "task-queue.xhtml", "task-queue.js", "task-queue.css", "prefs.js",
    "icon.svg", "icon16.svg", "icon16.png", "icon48.png", "icon96.png", "LICENSE", "THIRD_PARTY.md", "locale", "vendor",
]
for name in ("preferences.xhtml", "task-queue.xhtml"):
    ET.parse(root / name)
package = out / f"ocrflow-{version}.xpi"
with ZipFile(package, "w", ZIP_DEFLATED) as archive:
    for name in assets:
        asset = root / name
        for file in sorted(asset.rglob("*")) if asset.is_dir() else [asset]:
            if file.is_file():
                archive.write(file, file.relative_to(root).as_posix())
source = out / f"ocrflow-{version}-source.zip"
source_assets = assets + [
    "build.py", "build-xpi.sh", "README.md", "README.zh-CN.md", "CHANGELOG.md",
    "VALIDATION.md", "docs", "tests", ".gitignore", ".github",
]
with ZipFile(source, "w", ZIP_DEFLATED) as archive:
    for name in source_assets:
        asset = root / name
        for file in sorted(asset.rglob("*")) if asset.is_dir() else [asset]:
            if not file.is_file():
                continue
            relative = file.relative_to(root)
            if any(part in {".git", "__pycache__", "node_modules"} for part in relative.parts):
                continue
            if file.name == ".DS_Store" or file.name.startswith(".env"):
                continue
            archive.write(file, "ocrflow/" + relative.as_posix())
print(f"Installer: {package}")
print(f"Source: {source}")
