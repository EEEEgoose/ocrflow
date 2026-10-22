# OCRFlow

<img src="icon96.png" width="64" alt="OCRFlow icon" />

[简体中文](README.md) · **English**

A document workflow plugin for **Zotero 10.0.***. Work with the selected document from the right sidebar or the context menu. Importing or selecting an item does not automatically submit it for recognition.

[Download](https://github.com/EEEEgoose/ocrflow/releases/latest) · [User guide (Chinese)](README.zh-CN.md) · [Page progress deployment (Chinese)](docs/OCR-PROGRESS-DEPLOYMENT.zh-CN.md) · [Changelog (Chinese)](CHANGELOG.md)

## Features

| Action | Result |
| --- | --- |
| Organize document | Recognize document → Create parent item → Complete item → Generate outline → Summarize → Translate |
| Recognize document | OCR PDFs and images, or convert documents to Markdown; optionally generate HTML |
| Create parent item | Create preliminary bibliographic metadata from the filename alone |
| Complete item | Extract bibliographic metadata from the full text; store a Chinese translation of a non-Chinese title in Zotero’s Short Title field |
| Summarize document | Save an academic summary as a child note |
| Translate document | Translate by paragraph, with aligned original and translated text in two-column HTML; join unfinished paragraphs across page boundaries before translation |
| Generate outline | Create a navigable reader outline for the associated PDF |

Organize document reuses existing full text and parent items, filling missing metadata. It skips outline generation for non-PDF files. An outline or summary failure does not prevent subsequent stages from running; retries process only unfinished stages. Each action can also run independently.

## Recognition and proofreading

- Supports **MinerU local / cloud, PaddleOCR official / self-hosted APIs, Marker (self-hosted or Datalab hosted API), MarkItDown, and vision models**. Marker currently accepts PDFs; EPUB, Office, and other document formats use MarkItDown.
- Preserves raw responses, document structure, footnotes, captions, physical page references, and available coordinates. Cross-page joins retain their source fragments, and a change report records document processing changes.
- Optional dual-engine recognition uses engine A as the base text and engine B for comparison. The same engine cannot occupy both slots. Optional AI proofreading uses the source images and automatically saves clear suggestions as a new edition, retaining the base text, evidence, and change history. Uncertain readings remain unchanged.
- Stores up to five AI provider configurations, each with two models. Assign models, prompts, and request parameters independently to each task; configure context windows, output limits, and concurrency per model.
- Shows execution steps and actual progress in the sidebar, with the complete queue in Settings. Supports cancellation, retries, translation recovery, and opening results. Marker reconnects to the existing job after a brief network interruption without uploading the document again.
- Encrypts configuration locally and supports encrypted import/export and transport through Zotero file syncing. See the [configuration and sync guide (Chinese)](docs/CONFIGURATION-SYNC.zh-CN.md).
- Schedules independent documents concurrently across operations, services, and models. AI requests share each configured model’s concurrency limit; conflicting operations on the same bibliographic item wait. Server-side queues and resource limits still apply.

## Installation and quick start

1. Download the `.xpi` from the [latest release](https://github.com/EEEEgoose/ocrflow/releases/latest).
2. In Zotero, open **Tools → Plugins → Install Plugin From File**. Fully restart Zotero after the initial installation.
3. Open **Settings → OCRFlow → Configuration & Sync** (配置与同步), create a configuration password or import an encrypted configuration, then configure your services and AI models.
4. Select a file or bibliographic item and use the OCRFlow panel on the right. If the item has multiple source files, first choose the attachment to process.

Wait for active tasks to finish before updating the plugin so that the current session’s queue and job IDs remain available. The client queue and unfinished translation cache do not survive a Zotero restart. Server jobs and saved attachments are stored separately from the client session.

You can install over an earlier DocFlow / OCRFlow version. If you also use other automatic recognition plugins, check their settings to avoid submitting the same document twice. Zotero checks `updates.json` in the latest release for updates. Versions with the old placeholder update URL require one manual installation first.

## Server-side page progress

The Marker job API and the MinerU 4.0.10 page progress patch are documented together:

**[Marker and MinerU page progress deployment guide (Chinese)](docs/OCR-PROGRESS-DEPLOYMENT.zh-CN.md)**

The guide covers prerequisites, files, deployment commands, plugin settings, progress fields, cancellation, recovery, and troubleshooting. Updating the plugin does not automatically update the server.

## Documentation and releases

The following detailed documents are currently in Chinese:

- [User guide](README.zh-CN.md): configuration, everyday workflows, dual-engine proofreading, translation, and troubleshooting.
- [Changelog](CHANGELOG.md): features and fixes by version.
- [Development guide](docs/DEVELOPMENT.md): builds, tests, and release publishing.
- [Validation scope](VALIDATION.md): automated tests, isolated Zotero checks, and live service verification.
- [Sources and third-party components](THIRD_PARTY.md): inherited code, bundled dependencies, external services, and licenses.

Local builds require Node.js 24+ and Python 3.12+:

```sh
node --test tests/*.test.cjs
python3 build.py
```

Builds produce `dist/ocrflow-<version>.xpi`, a matching source archive, and `updates.json`. Release patch numbers increment automatically from existing versions. GitHub release notes list new features and fixes based on changes since the preceding published tag; see the development guide for details.

## Data and licensing

When you run an action, the relevant filename, full text, original file, or page images are sent to the service you selected. Viewing or selecting an item does not start a task. API keys and other settings are stored in a local encrypted vault and are not distributed with the source.

This project retains its [MIT license](LICENSE), along with third-party notices and component licenses. OCRFlow was developed with assistance from LLMs. Check OCR and model-generated results against the source document; the user guide and validation notes describe the supported behavior and verification scope.
