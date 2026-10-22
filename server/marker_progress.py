"""Observe Marker 2 / Surya page responses without splitting the document."""
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def read_state(directory):
    return json.loads((Path(directory) / 'status.json').read_text())


def write_state(directory, state):
    state['updated_at'] = time.time()
    target = Path(directory) / 'status.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False))
    temporary.replace(target)


class Progress:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.state = read_state(directory)
        self.lock = threading.Lock()
        self.page_ids = []
        self.received = set()
        self.text_pages = 0

    def update(self, **fields):
        with self.lock:
            self.state.update(fields)
            write_state(self.directory, self.state)

    def begin_ocr(self, document):
        self.page_ids = [p.page_id for p in document.pages if p.text_extraction_method == 'surya']
        self.text_pages = len(document.pages) - len(self.page_ids)
        self.update(stage='ocr', detail='正在识别页面正文',
                    progress={'completed': self.text_pages, 'total': len(document.pages), 'unit': '页'})

    def page_response(self, item, result):
        index = item.metadata['page_idx']
        if result.error or index >= len(self.page_ids):
            return
        with self.lock:
            self.received.add(self.page_ids[index])
            completed = self.text_pages + len(self.received)
            self.state.update(stage='ocr', detail='页面识别响应已返回，等待全文校验与结构整理',
                              progress={'completed': completed, 'total': self.state['progress']['total'], 'unit': '页'})
            write_state(self.directory, self.state)


class ProgressManager:
    def __init__(self, base, progress, full_page_prompt):
        self.base = base
        self.progress = progress
        self.full_page_prompt = full_page_prompt

    def capacity(self):
        return self.base.capacity()

    def generate(self, batch):
        if not batch or any(item.prompt_type != self.full_page_prompt for item in batch):
            return self.base.generate(batch)
        self.base.start()
        results = [None] * len(batch)
        parallel = max(1, int(os.environ.get('SURYA_INFERENCE_PARALLEL', '2')))
        with ThreadPoolExecutor(max_workers=min(parallel, len(batch))) as pool:
            futures = {pool.submit(self.base.generate, [item]): index for index, item in enumerate(batch)}
            for future in as_completed(futures):
                index = futures[future]
                result = future.result()[0]
                results[index] = result
                self.progress.page_response(batch[index], result)
        return results
