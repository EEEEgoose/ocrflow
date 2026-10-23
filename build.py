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
out = args.output_dir.resolve()
version = args.version
if not version:
    base = manifest["version"]
    if base.count(".") == 2:
        prefix, patch = base.rsplit(".", 1)
        initial = int(patch) - 1
    else:
        prefix, initial = (base.rsplit(".", 1)[0], int(base.rsplit(".", 1)[1])) if base.count(".") == 3 else (base, 0)
    builds = [initial]
    for package in out.glob("ocrflow-*.xpi"):
        match = re.fullmatch(re.escape("ocrflow-" + prefix + ".") + r"(\d+)\.xpi", package.name)
        if match:
            builds.append(int(match.group(1)))
    version = f"{prefix}.{max(builds) + 1}"
if not re.fullmatch(r"\d+\.\d+(?:\.\d+){0,2}", version):
    parser.error("Version must contain two to four numeric components")
manifest["version"] = version
manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
out.mkdir(parents=True, exist_ok=True)
assets = [
    "manifest.json", "bootstrap.js", "config.js", "config-preferences.js", "datalab.js", "prompts.js", "docflow.js", "markitdown.js", "marker.js", "metadata.js", "workflow.js",
    "translation-services.js", "title-translation.js",
    "outline.js", "preferences.js", "preferences.xhtml", "document.js", "paddleocr.js", "translation.js",
    "collation.js", "collation-dialog.js", "collation.xhtml", "ocr-sources.js",
    "task-queue.xhtml", "task-queue.js", "task-queue.css", "task-sidebar.js", "task-sidebar.css", "sidebar-icon.svg", "prefs.js",
    "icon16.png", "icon48.png", "icon96.png", "LICENSE", "THIRD_PARTY.md",
    *[f"menu-icons/{name}.svg" for name in ("ocr", "organize", "parent", "metadata", "summary", "translate", "outline", "review", "changes")],
    "locale/en-US/docflow.ftl", "locale/zh-CN/docflow.ftl",
    "vendor/katex/katex.min.js", "vendor/katex/LICENSE",
    "vendor/pdf-lib/pdf-lib.min.js", "vendor/pdf-lib/LICENSE.md", "vendor/paper-outline/LICENSE",
]
for name in ("preferences.xhtml", "task-queue.xhtml", "collation.xhtml"):
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
    "build.py", "build-xpi.sh", "release_notes.py", "README.md", "README.en.md", "README.zh-CN.md", "CHANGELOG.md",
    "VALIDATION.md", "docs", "tests", "server", ".gitignore", ".github",
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
