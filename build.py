"""Build the OCRFlow installation package and a source archive."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import json
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path, default=root / "dist", help="Output directory (default: project dist/)")
parser.add_argument("--version", help="Release version override (does not modify source files)")
args = parser.parse_args()
manifest = json.loads((root / "manifest.json").read_text())
for field in ("id", "update_url", "strict_max_version"):
    if not manifest.get("applications", {}).get("zotero", {}).get(field):
        raise ValueError(f"Zotero requires applications.zotero.{field}")
version = args.version or manifest["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
    parser.error("Version must contain three or four numeric components")
manifest["version"] = version
manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
out = args.output_dir.resolve()
out.mkdir(parents=True, exist_ok=True)
assets = [
    "manifest.json", "bootstrap.js", "prompts.js", "docflow.js", "markitdown.js", "metadata.js", "workflow.js",
    "outline.js", "preferences.js", "preferences.xhtml",
    "task-queue.xhtml", "task-queue.js", "task-queue.css", "prefs.js",
    "icon16.png", "icon48.png", "icon96.png", "LICENSE", "THIRD_PARTY.md",
    "locale/en-US/docflow.ftl", "locale/zh-CN/docflow.ftl",
    "vendor/katex/katex.min.js", "vendor/katex/LICENSE",
    "vendor/pdf-lib/pdf-lib.min.js", "vendor/pdf-lib/LICENSE.md", "vendor/paper-outline/LICENSE",
]
for name in ("preferences.xhtml", "task-queue.xhtml"):
    ET.parse(root / name)
package = out / f"ocrflow-{version}.xpi"
with ZipFile(package, "w", ZIP_DEFLATED) as archive:
    for name in assets:
        if name == "manifest.json":
            archive.writestr(name, manifest_bytes)
        else:
            archive.write(root / name, name)
source = out / f"ocrflow-{version}-source.zip"
source_assets = assets + [
    "icon.svg", "icon16.svg", "vendor/katex/README.md", "vendor/pdf-lib/README.md", "vendor/paper-outline/README.md",
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
            if file.name == ".DS_Store" or file.name.startswith(".env") or file.suffix == ".log":
                continue
            target = "ocrflow/" + relative.as_posix()
            if relative.as_posix() == "manifest.json":
                archive.writestr(target, manifest_bytes)
            else:
                archive.write(file, target)
zotero = manifest["applications"]["zotero"]
release_base = zotero["update_url"].removesuffix("/latest/download/updates.json")
updates = {"addons": {zotero["id"]: {"updates": [{
    "version": version,
    "update_link": f"{release_base}/download/v{version}/{package.name}",
    "applications": {"zotero": {key: zotero[key] for key in ("strict_min_version", "strict_max_version")}},
}]}}}
(out / "updates.json").write_text(json.dumps(updates, indent=2) + "\n", encoding="utf-8")
print(f"Installer: {package}")
print(f"Source: {source}")
print(f"Updates: {out / 'updates.json'}")
