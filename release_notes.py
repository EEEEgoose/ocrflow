"""Generate a Release body from changes added since the preceding published tag."""
import argparse
from pathlib import Path
import re
import subprocess


def entries(text):
    version, category = None, None
    result = []
    for line in text.splitlines():
        if line.startswith('## '):
            version, category = line[3:].strip(), None
        elif line.startswith('### '):
            category = line[4:].strip()
        elif line.startswith('- ') and version:
            result.append((version, category, line[2:].strip()))
    return result


def render(current, previous, version, previous_ref=None):
    old = {(v, text) for v, _, text in entries(previous)}
    added = [(v, category, text) for v, category, text in entries(current) if (v, text) not in old]
    if not added:
        raise ValueError('没有新增更新记录；请先在 CHANGELOG.md 记录本次新增功能与修复问题')
    groups = {'新增功能': [], '修复问题': []}
    for _, category, text in added:
        if category not in groups:
            raise ValueError('新增更新记录必须放在 ### 新增功能 或 ### 修复问题 下：' + text)
        groups[category].append('- ' + text)
    lines = [f'OCRFlow {version}', '', '## 新增功能', '', *(groups['新增功能'] or ['- 本次未新增功能。']),
             '', '## 修复问题', '', *(groups['修复问题'] or ['- 本次未包含独立的问题修复。']), '', '## 安装与文档', '',
             '- 下载本页 `.xpi`，在 Zotero 的“工具 → 插件 → 从文件安装插件”中安装。',
             '- [使用手册](https://github.com/EEEEgoose/ocrflow/blob/main/README.zh-CN.md) · '
             '[进度部署指南](https://github.com/EEEEgoose/ocrflow/blob/main/docs/OCR-PROGRESS-DEPLOYMENT.zh-CN.md)', '']
    if previous_ref:
        lines += [f'[完整改动](https://github.com/EEEEgoose/ocrflow/compare/{previous_ref}...v{version})', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--previous-ref')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+){0,2}', args.version):
        parser.error('无效版本号')
    previous = subprocess.check_output(['git', 'show', f'{args.previous_ref}:CHANGELOG.md'], text=True) if args.previous_ref else ''
    notes = render(Path('CHANGELOG.md').read_text(), previous, args.version, args.previous_ref)
    args.output.write_text(notes)
