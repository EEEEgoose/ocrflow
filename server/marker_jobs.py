"""Durable whole-PDF jobs around the official Marker conversion pipeline."""
import asyncio
import base64
import io
import json
import multiprocessing
import os
import re
import signal
import time
import traceback
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from marker_progress import Progress, ProgressManager, read_state, write_state

ROOT = Path(os.environ.get('MARKER_JOBS_DIR', '/data/jobs'))
TERMINAL = {'completed', 'failed', 'canceled'}
queue = None
active = None


def render_document(converter, filepath, include_layout):
    if not include_layout:
        return converter(filepath), None
    from marker.renderers.json import JSONRenderer
    document = converter.build_document(filepath)
    converter.page_count = len(document.pages)
    rendered = converter.resolve_dependencies(converter.renderer)(document)
    layout = converter.resolve_dependencies(JSONRenderer)(document)
    return rendered, layout.model_dump(mode='json', exclude={'metadata'})


def directory(job_id):
    path = ROOT / job_id
    if not re.fullmatch('[a-f0-9]{32}', job_id) or not (path / 'status.json').exists():
        raise HTTPException(404, '找不到此 Marker 任务')
    return path


def run_job(folder):
    os.setsid()
    progress = Progress(folder)
    try:
        import pypdfium2
        pdf = pypdfium2.PdfDocument(str(Path(folder) / 'input.pdf'))
        total = len(pdf)
        pdf.close()
        progress.update(status='running', stage='loading', detail='读取整份 PDF 并加载 Marker',
                        progress={'completed': 0, 'total': total, 'unit': '页'})
        from marker.builders.layout import LayoutBuilder
        from marker.builders.line import LineBuilder
        from marker.builders.ocr import OcrBuilder
        from marker.config.parser import ConfigParser
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.output import text_from_rendered
        from marker.renderers.markdown import MarkdownRenderer
        from marker.settings import settings
        from surya.inference.prompts import PROMPT_TYPE_HIGH_ACCURACY_BBOX

        class Layout(LayoutBuilder):
            def __call__(self, document, provider):
                progress.update(stage='layout', detail='正在分析整份文档版面')
                return super().__call__(document, provider)

        class Lines(LineBuilder):
            def __call__(self, document, provider):
                progress.update(stage='text', detail='正在读取文字层与判断 OCR 页面')
                return super().__call__(document, provider)

        class OCR(OcrBuilder):
            def __call__(self, document, provider):
                progress.begin_ocr(document)
                result = super().__call__(document, provider)
                progress.update(stage='structure', detail='页面正文已读取，正在整理全文结构',
                                progress={'completed': total, 'total': total, 'unit': '页'})
                return result

        class Markdown(MarkdownRenderer):
            def __call__(self, document):
                progress.update(stage='rendering', detail='正在生成完整 Markdown 与图片')
                return super().__call__(document)

        class Converter(PdfConverter):
            def resolve_dependencies(self, cls):
                cls = {LayoutBuilder: Layout, LineBuilder: Lines, OcrBuilder: OCR, MarkdownRenderer: Markdown}.get(cls, cls)
                return super().resolve_dependencies(cls)

            def initialize_processors(self, processor_list):
                processors = super().initialize_processors(processor_list)
                def observed(processor):
                    def apply(document):
                        progress.update(stage='structure', detail='正在整理全文结构：' + type(processor).__name__)
                        return processor(document)
                    return apply
                return [observed(processor) for processor in processors]

        request = json.loads((Path(folder) / 'request.json').read_text())
        include_layout = request.pop('include_layout', False)
        parser = ConfigParser(request)
        config = parser.generate_config_dict()
        config['pdftext_workers'] = 1
        models = create_model_dict()
        model = models['recognition_model']
        model.manager = ProgressManager(model.manager, progress, PROMPT_TYPE_HIGH_ACCURACY_BBOX)
        converter = Converter(artifact_dict=models, config=config, processor_list=parser.get_processors(),
                              renderer=parser.get_renderer(), llm_service=parser.get_llm_service())
        rendered, layout = render_document(converter, str(Path(folder) / 'input.pdf'), include_layout)
        text, _, images = text_from_rendered(rendered)
        progress.update(stage='saving', detail='正在保存整份文档结果')
        encoded = {}
        for name, image in images.items():
            buffer = io.BytesIO()
            image.save(buffer, format=settings.OUTPUT_IMAGE_FORMAT)
            encoded[name] = base64.b64encode(buffer.getvalue()).decode()
        result = {'success': True, 'format': request['output_format'], 'output': text,
                  'images': encoded, 'metadata': rendered.metadata}
        if layout is not None:
            result['layout'] = layout
        target = Path(folder) / 'result.json'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False))
        temporary.replace(target)
        progress.update(status='completed', stage='completed', detail='整份文档处理完成',
                        progress={'completed': total, 'total': total, 'unit': '页'})
    except Exception as error:
        traceback.print_exc()
        progress.update(status='failed', stage='failed', error=str(error), detail='Marker 处理失败')


async def scheduler():
    global active
    context = multiprocessing.get_context('spawn')
    while True:
        job_id = await queue.get()
        path = directory(job_id)
        if read_state(path)['status'] != 'queued':
            continue
        process = context.Process(target=run_job, args=(str(path),))
        process.start()
        active = (job_id, process)
        try:
            while process.is_alive():
                await asyncio.sleep(0.2)
            process.join()
            state = read_state(path)
            if state['status'] not in TERMINAL:
                state.update(status='failed', stage='failed', error='Marker worker exited before completing')
                write_state(path, state)
        finally:
            if process.is_alive():
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                await asyncio.to_thread(process.join, 5)
                if process.is_alive():
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    await asyncio.to_thread(process.join)
            active = None


@asynccontextmanager
async def lifespan(app):
    global queue
    ROOT.mkdir(parents=True, exist_ok=True)
    queue = asyncio.Queue()
    for status_file in sorted(ROOT.glob('*/status.json')):
        state = json.loads(status_file.read_text())
        if state['status'] == 'running':
            state.update(status='failed', stage='failed', error='服务重启，原任务已中断；请重新提交。')
            write_state(status_file.parent, state)
        elif state['status'] == 'queued':
            queue.put_nowait(state['job_id'])
    task = asyncio.create_task(scheduler())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title='OCRFlow Marker Jobs', lifespan=lifespan)


async def submit(file, mode, force_ocr, output_format, paginate_output, include_layout=False):
    job_id = uuid.uuid4().hex
    path = ROOT / job_id
    path.mkdir(parents=True)
    with (path / 'input.pdf').open('wb') as target:
        while chunk := await file.read(1024 * 1024):
            target.write(chunk)
    await file.close()
    (path / 'request.json').write_text(json.dumps({'mode': mode, 'force_ocr': force_ocr,
                                                  'output_format': output_format, 'paginate_output': paginate_output,
                                                  'include_layout': include_layout}))
    state = {'job_id': job_id, 'status': 'queued', 'stage': 'queued', 'filename': file.filename,
             'created_at': time.time(), 'detail': '等待 Marker 处理整份 PDF', 'error': '',
             'progress': {'completed': 0, 'total': 0, 'unit': '页'}}
    write_state(path, state)
    queue.put_nowait(job_id)
    return state


@app.post('/v1/parse/jobs', status_code=202)
async def create_job(file: UploadFile = File(...), mode: str = Form('balanced'), force_ocr: bool = Form(False),
                     output_format: str = Form('markdown'), paginate_output: bool = Form(True), include_layout: bool = Form(False)):
    if mode not in {'balanced', 'fast'} or output_format not in {'markdown', 'json', 'html'}:
        raise HTTPException(400, '无效的 Marker 模式或输出格式')
    return await submit(file, mode, force_ocr, output_format, paginate_output, include_layout)


@app.get('/v1/parse/jobs/{job_id}')
async def status(job_id: str):
    return read_state(directory(job_id))


@app.get('/v1/parse/jobs/{job_id}/result')
async def result(job_id: str):
    path = directory(job_id)
    state = read_state(path)
    if state['status'] != 'completed':
        raise HTTPException(409, state.get('error') or '任务尚未完成')
    return FileResponse(path / 'result.json', media_type='application/json')


@app.delete('/v1/parse/jobs/{job_id}')
async def cancel(job_id: str):
    path = directory(job_id)
    state = read_state(path)
    if state['status'] in TERMINAL:
        return state
    if active and active[0] == job_id:
        process = active[1]
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        await asyncio.to_thread(process.join, 5)
        if process.is_alive():
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await asyncio.to_thread(process.join)
    state = read_state(path)
    state.update(status='canceled', stage='canceled', detail='任务已终止')
    write_state(path, state)
    return state


@app.post('/marker/upload')
async def official_upload(request: Request, file: UploadFile = File(...), mode: str = Form('balanced'), force_ocr: bool = Form(False),
                          output_format: str = Form('markdown'), paginate_output: bool = Form(True), include_layout: bool = Form(False)):
    state = await create_job(file, mode, force_ocr, output_format, paginate_output, include_layout)
    try:
        while state['status'] not in TERMINAL:
            if await request.is_disconnected():
                await cancel(state['job_id'])
                raise HTTPException(499, '同步请求已断开，Marker 任务已取消')
            await asyncio.sleep(0.5)
            state = read_state(directory(state['job_id']))
    except asyncio.CancelledError:
        await asyncio.shield(cancel(state['job_id']))
        raise
    if state['status'] != 'completed':
        raise HTTPException(500, state.get('error') or state['detail'])
    return FileResponse(directory(state['job_id']) / 'result.json', media_type='application/json')
