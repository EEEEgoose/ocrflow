import asyncio
import io
import json
import multiprocessing
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

from fastapi.testclient import TestClient
import marker_jobs as jobs
import marker_progress as observed
from fastapi import HTTPException, UploadFile


def sleeper():
    os.setsid()
    time.sleep(30)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.object(jobs, 'ROOT', Path(self.temp.name))
        self.root.start()
        jobs.queue = asyncio.Queue()
        jobs.active = None
        self.client = TestClient(jobs.app)

    def tearDown(self):
        self.client.close()
        self.root.stop()
        self.temp.cleanup()

    def submit(self):
        response = self.client.post('/v1/parse/jobs', files={'file': ('book.pdf', b'whole PDF body')},
                                    data={'mode': 'balanced', 'paginate_output': 'true'})
        self.assertEqual(response.status_code, 202)
        return response.json()

    def test_upload_once_and_queued_status(self):
        state = self.submit()
        directory = jobs.directory(state['job_id'])
        self.assertEqual((directory / 'input.pdf').read_bytes(), b'whole PDF body')
        self.assertEqual(self.client.get('/v1/parse/jobs/' + state['job_id']).json()['status'], 'queued')
        self.assertEqual(self.client.get('/v1/parse/jobs/' + state['job_id'] + '/result').status_code, 409)
        self.assertEqual(json.loads((directory / 'request.json').read_text())['paginate_output'], True)

    def test_layout_request_is_saved_with_the_original_job(self):
        response = self.client.post('/v1/parse/jobs', files={'file': ('book.pdf', b'PDF')},
                                    data={'include_layout': 'true'})
        self.assertEqual(response.status_code, 202)
        request = json.loads((jobs.directory(response.json()['job_id']) / 'request.json').read_text())
        self.assertTrue(request['include_layout'])
        self.assertEqual(request['output_format'], 'markdown')

    def test_layout_and_markdown_render_the_same_document_after_one_conversion(self):
        document = NS(pages=[1, 2])
        calls = []
        class JSONRenderer:
            pass
        class Converter:
            renderer = 'markdown'
            def build_document(self, filepath):
                calls.append(('build', filepath))
                return document
            def resolve_dependencies(self, renderer):
                def render(value):
                    self_test.assertIs(value, document)
                    calls.append(('render', renderer))
                    return 'markdown output' if renderer == 'markdown' else NS(model_dump=lambda **kwargs: {'children': []})
                return render
        self_test = self
        converter = Converter()
        with patch.dict(sys.modules, {'marker.renderers.json': NS(JSONRenderer=JSONRenderer)}):
            rendered, layout = jobs.render_document(converter, 'book.pdf', True)
        self.assertEqual(rendered, 'markdown output')
        self.assertEqual(layout, {'children': []})
        self.assertEqual(calls, [('build', 'book.pdf'), ('render', 'markdown'), ('render', JSONRenderer)])
        self.assertEqual(converter.page_count, 2)
        self.assertEqual(jobs.render_document(lambda path: path, 'book.pdf', False), ('book.pdf', None))

    def test_result_and_cancel_queued(self):
        state = self.submit()
        path = jobs.directory(state['job_id'])
        state.update(status='completed')
        jobs.write_state(path, state)
        (path / 'result.json').write_text('{"success":true,"output":"whole document"}')
        self.assertEqual(self.client.get('/v1/parse/jobs/' + state['job_id'] + '/result').json()['output'], 'whole document')
        self.assertEqual(self.client.delete('/v1/parse/jobs/' + state['job_id']).json()['status'], 'completed')
        other = self.submit()
        self.assertEqual(self.client.delete('/v1/parse/jobs/' + other['job_id']).json()['status'], 'canceled')
        self.assertEqual(self.client.get('/v1/parse/jobs/not-a-job').status_code, 404)

    def test_running_cancel_stops_only_that_worker(self):
        state = self.submit()
        process = multiprocessing.get_context('spawn').Process(target=sleeper)
        process.start()
        time.sleep(0.4)
        jobs.active = (state['job_id'], process)
        try:
            response = self.client.delete('/v1/parse/jobs/' + state['job_id'])
            self.assertEqual(response.json()['status'], 'canceled')
            self.assertFalse(process.is_alive())
        finally:
            if process.is_alive():
                process.kill()
            process.join()
            jobs.active = None

    def test_progress_preserves_batch_order_and_does_not_double_count(self):
        state = self.submit()
        path = jobs.directory(state['job_id'])
        progress = observed.Progress(path)
        progress.begin_ocr(NS(pages=[NS(page_id=4, text_extraction_method='surya'), NS(page_id=5, text_extraction_method='surya'), NS(page_id=6, text_extraction_method='pdftext')]))
        class Base:
            def start(self): pass
            def capacity(self): return 2
            def generate(self, batch):
                if batch[0].metadata['page_idx'] == 0:
                    time.sleep(0.04)
                return [NS(error=False, value=item.metadata['page_idx']) for item in batch]
        manager = observed.ProgressManager(Base(), progress, 'full')
        batch = [NS(prompt_type='full', metadata={'page_idx': index}) for index in [0, 1]]
        result = manager.generate(batch)
        self.assertEqual([item.value for item in result], [0, 1])
        self.assertEqual(jobs.read_state(path)['progress'], {'completed': 3, 'total': 3, 'unit': '页'})
        progress.page_response(batch[0], result[0])
        self.assertEqual(jobs.read_state(path)['progress']['completed'], 3)
        progress.begin_ocr(NS(pages=[NS(page_id=4, text_extraction_method='surya')]))
        progress.received.clear()
        progress.page_response(batch[0], NS(error=True))
        self.assertEqual(jobs.read_state(path)['progress']['completed'], 0)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_sync_disconnect_cancels_its_queued_job_and_preserves_other_jobs(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(jobs, 'ROOT', Path(folder)):
            jobs.queue = asyncio.Queue()
            other = await jobs.submit(UploadFile(io.BytesIO(b'other'), filename='other.pdf'), 'balanced', False, 'markdown', True)
            async def disconnected(): return True
            with self.assertRaises(HTTPException) as caught:
                await jobs.official_upload(NS(is_disconnected=disconnected), UploadFile(io.BytesIO(b'pdf'), filename='sync.pdf'), 'balanced', False, 'markdown', True, False)
            self.assertEqual(caught.exception.status_code, 499)
            states = [json.loads(p.read_text()) for p in Path(folder).glob('*/status.json')]
            self.assertEqual(sorted(s['status'] for s in states), ['canceled', 'queued'])
            self.assertEqual(jobs.read_state(jobs.directory(other['job_id']))['status'], 'queued')

    async def test_sync_disconnect_stops_the_active_worker(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(jobs, 'ROOT', Path(folder)):
            jobs.queue = asyncio.Queue()
            process = multiprocessing.get_context('spawn').Process(target=sleeper)
            process.start()
            await asyncio.sleep(0.4)
            async def disconnected():
                job_id = next(Path(folder).glob('*/status.json')).parent.name
                jobs.active = (job_id, process)
                return True
            try:
                with self.assertRaises(HTTPException):
                    await jobs.official_upload(NS(is_disconnected=disconnected), UploadFile(io.BytesIO(b'pdf'), filename='sync.pdf'), 'balanced', False, 'markdown', True, False)
                self.assertFalse(process.is_alive())
                self.assertEqual(json.loads(next(Path(folder).glob('*/status.json')).read_text())['status'], 'canceled')
            finally:
                if process.is_alive(): process.kill()
                process.join()
                jobs.active = None

    async def test_cancelled_sync_handler_cleans_up_its_job(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(jobs, 'ROOT', Path(folder)):
            jobs.queue = asyncio.Queue()
            async def interrupted(): raise asyncio.CancelledError()
            with self.assertRaises(asyncio.CancelledError):
                await jobs.official_upload(NS(is_disconnected=interrupted), UploadFile(io.BytesIO(b'pdf'), filename='sync.pdf'), 'balanced', False, 'markdown', True, False)
            self.assertEqual(json.loads(next(Path(folder).glob('*/status.json')).read_text())['status'], 'canceled')

    async def test_restart_keeps_results_and_marks_interrupted_jobs(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(jobs, 'ROOT', Path(folder)):
            for name, status in [('a' * 32, 'running'), ('b' * 32, 'queued'), ('c' * 32, 'completed')]:
                path = Path(folder) / name
                path.mkdir()
                jobs.write_state(path, {'job_id': name, 'status': status, 'created_at': time.time()})
            async def idle():
                await asyncio.Event().wait()
            with patch.object(jobs, 'scheduler', idle):
                async with jobs.lifespan(jobs.app):
                    self.assertEqual(jobs.read_state(Path(folder) / ('a' * 32))['status'], 'failed')
                    self.assertEqual(jobs.queue.get_nowait(), 'b' * 32)
                    self.assertEqual(jobs.read_state(Path(folder) / ('c' * 32))['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
