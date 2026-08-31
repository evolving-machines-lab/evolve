"""
Unit tests for datasets().preflight() — the dry-run check before publish.

Coverage:
- _collect_preflight_payload: the corpus walk mirrors the import's own
  reading (single-task root / tasks/ subdir / root of task dirs; sorted
  entries; the ambiguity refusal; a child without task.toml refuses by name;
  dataset.toml from the root or beside the task dirs)
- _map_dataset_preflight: the wire body maps into the typed answer, provider
  verdicts included
- DatasetsClient.preflight posts the payload to /api/datasets/preflight
"""

import asyncio
from pathlib import Path

import pytest

from evolve.hosted import (
    DatasetPreflight,
    DatasetsClient,
    HostedClientConfig,
    _collect_preflight_payload,
    _map_dataset_preflight,
)


def _make_corpus(root: Path) -> None:
    (root / 'tasks' / 'b-task').mkdir(parents=True)
    (root / 'tasks' / 'a-task').mkdir(parents=True)
    (root / 'tasks' / 'a-task' / 'task.toml').write_text('schema_version = "1.4"\n')
    (root / 'tasks' / 'b-task' / 'task.toml').write_text('[environment]\n')
    (root / 'dataset.toml').write_text('[dataset]\nname = "evolve/demo"\n')


def test_collect_payload_corpus_shape(tmp_path: Path) -> None:
    _make_corpus(tmp_path)
    payload = _collect_preflight_payload(str(tmp_path))
    assert [t['name'] for t in payload['tasks']] == ['a-task', 'b-task']
    assert payload['tasks'][0]['task_toml'] == 'schema_version = "1.4"\n'
    assert payload['dataset_toml'] == '[dataset]\nname = "evolve/demo"\n'


def test_collect_payload_single_task_shape(tmp_path: Path) -> None:
    (tmp_path / 'task.toml').write_text('[environment]\n')
    payload = _collect_preflight_payload(str(tmp_path))
    assert [t['name'] for t in payload['tasks']] == [tmp_path.name]
    assert 'dataset_toml' not in payload


def test_collect_payload_refuses_ambiguous_root(tmp_path: Path) -> None:
    (tmp_path / 'task.toml').write_text('[environment]\n')
    (tmp_path / 'tasks').mkdir()
    with pytest.raises(ValueError, match='ambiguous'):
        _collect_preflight_payload(str(tmp_path))


def test_collect_payload_refuses_child_without_task_toml(tmp_path: Path) -> None:
    (tmp_path / 'tasks' / 'empty-dir').mkdir(parents=True)
    with pytest.raises(ValueError, match='has no task.toml'):
        _collect_preflight_payload(str(tmp_path))


def test_map_dataset_preflight() -> None:
    answer = _map_dataset_preflight(
        {
            'importer_version': 'harbor-import/14',
            'checks': ['toml_syntax'],
            'deferred': [{'name': 'environment_layout', 'reads': 'environment/Dockerfile'}],
            'manifest': {'ok': True, 'name': 'evolve/demo', 'short_name': 'demo', 'version': '0.1', 'task_count': 2},
            'tasks': [
                {'name': 'a', 'ok': True, 'task_key': 'a', 'schema_version': '1.4',
                 'providers': {'e2b': {'ok': True}, 'daytona': {'ok': False, 'reason': 'too big'}}},
                {'name': 'b', 'ok': False, 'task_key': 'b', 'reason': 'mutable :latest tag'},
            ],
            'tasks_total': 2,
            'tasks_ok': 1,
            'tasks_refused': 1,
        }
    )
    assert isinstance(answer, DatasetPreflight)
    assert answer.importer_version == 'harbor-import/14'
    assert answer.deferred[0].name == 'environment_layout'
    assert answer.manifest is not None and answer.manifest.short_name == 'demo'
    assert answer.tasks[0].providers is not None
    assert answer.tasks[0].providers['daytona'].reason == 'too big'
    assert answer.tasks[1].reason == 'mutable :latest tag'
    assert (answer.tasks_total, answer.tasks_ok, answer.tasks_refused) == (2, 1, 1)


def test_preflight_posts_payload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_corpus(tmp_path)
    client = DatasetsClient(HostedClientConfig(api_key='k', base_url='http://x'))
    calls = {}

    async def fake_request_json(path, method='GET', body=None, headers=None):
        calls['path'] = path
        calls['method'] = method
        calls['body'] = body
        return {
            'importer_version': 'harbor-import/14',
            'checks': [],
            'deferred': [],
            'manifest': None,
            'tasks': [],
            'tasks_total': 0,
            'tasks_ok': 0,
            'tasks_refused': 0,
        }

    monkeypatch.setattr(client._http, 'request_json', fake_request_json)
    answer = asyncio.run(client.preflight(directory=str(tmp_path)))
    assert calls['path'] == '/api/datasets/preflight'
    assert calls['method'] == 'POST'
    assert [t['name'] for t in calls['body']['tasks']] == ['a-task', 'b-task']
    assert answer.tasks_total == 0
