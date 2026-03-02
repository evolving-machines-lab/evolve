#!/usr/bin/env python3
"""Integration Test 26: Full Storage Surface (Python SDK)

End-to-end test for ALL storage and checkpointing features with real agents,
real sandboxes, and real files — mirrors the TypeScript integration test 26
assertion-for-assertion.

Tests:
  1. Checkpoint lifecycle: auto-checkpoint, explicit, lineage (parentId)
  2. Content-addressed dedup (same hash = skip upload)
  3. Restore from checkpoint — verify real file contents
  4. from: "latest" — global resolution
  5. Standalone storage() client — listCheckpoints, getCheckpoint,
     downloadCheckpoint, downloadFiles (all options)
  6. Evolve.storage() accessor — bound client equivalence
  7. Parallel scale — 3 concurrent Evolve instances, tag isolation
  8. Error cases

Requires:
  EVOLVE_API_KEY -- LLM gateway
  E2B_API_KEY -- sandbox provider
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY -- S3 credentials (BYOK only)
"""

import asyncio
import os
import re
import tempfile
import shutil
import pytest

from evolve import (
    Evolve,
    CheckpointInfo,
    StorageConfig,
    StorageClient,
    storage as create_storage,
)
from tests.utils.agent_config import get_agent_config, validate_agent_config
from tests.utils.test_helpers import (
    create_sandbox_provider,
    log_section,
    log_result,
    log_info,
    assert_true,
)

# =============================================================================
# CONFIG
# =============================================================================

PROVIDER_NAME = os.getenv('TEST_SANDBOX_PROVIDER', 'e2b')
STORAGE_MODE = os.getenv('TEST_STORAGE_MODE', 'byok')
IS_GATEWAY = STORAGE_MODE == 'gateway'
STORAGE_URL = f's3://swarmkit-test-checkpoints-905418019965/py-integration-test-26-{PROVIDER_NAME}/'
STORAGE_REGION = 'us-west-2'
TIMEOUT = 180000  # 3 min per run

agent_config = get_agent_config()
validate_agent_config(agent_config)


def get_storage_config() -> StorageConfig:
    if IS_GATEWAY:
        return StorageConfig()
    return StorageConfig(url=STORAGE_URL, region=STORAGE_REGION)


# =============================================================================
# FILE SEEDING — create real files inside sandbox
# =============================================================================

async def seed_workspace_files(evolve_inst: Evolve, version: str) -> None:
    """Seed workspace with multi-format files via executeCommand."""
    log_info(f'  Seeding workspace files (version: {version})...')

    # 1. Large TXT (~2MB)
    txt_result = await evolve_inst.execute_command(
        ' && '.join([
            'mkdir -p /home/user/workspace/docs',
            f'echo "--- Report {version} ---" > /home/user/workspace/docs/report-{version}.txt',
            f'for i in $(seq 1 20000); do echo "Row $i: metric_a=$i.314, metric_b=$i.271, status=active, version={version}" >> /home/user/workspace/docs/report-{version}.txt; done',
            f'wc -c /home/user/workspace/docs/report-{version}.txt',
        ]),
        timeout_ms=60000,
    )
    log_info(f'    TXT: {txt_result.stdout.strip()}')

    # 2. PNG (~1MB) — binary via Python
    png_seed = '49' if version == 'v1' else '50'
    png_result = await evolve_inst.execute_command(
        '\n'.join([
            'mkdir -p /home/user/workspace/assets',
            f"python3 -c '",
            'import struct, zlib, os',
            'w, h = 512, 512',
            'raw = b""',
            'for y in range(h):',
            '    raw += b"\\x00"',
            '    for x in range(w):',
            f'        raw += bytes([(x*7+{png_seed})%256, (y*13)%256, (x+y)%256])',
            'compressed = zlib.compress(raw)',
            'def chunk(t, d):',
            '    c = t + d',
            '    return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)',
            'ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)',
            'png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")',
            f'with open("/home/user/workspace/assets/chart-{version}.png", "wb") as f:',
            '    f.write(png)',
            f"print(os.path.getsize(\"/home/user/workspace/assets/chart-{version}.png\"))'",
        ]),
        timeout_ms=30000,
    )
    log_info(f'    PNG: {png_result.stdout.strip()} bytes')

    # 3. PDF (~500KB)
    pdf_result = await evolve_inst.execute_command(
        '\n'.join([
            "python3 -c '",
            'import os',
            'os.makedirs("/home/user/workspace/docs", exist_ok=True)',
            'pdf = "%PDF-1.4\\n"',
            'pdf += "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n"',
            'pdf += "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n"',
            'pdf += "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\\n"',
            f'stream = "BT /F1 10 Tf 72 750 Td (Analysis Report {version}) Tj ET"',
            'pdf += "4 0 obj<</Length " + str(len(stream)) + ">>stream\\n" + stream + "\\nendstream endobj\\n"',
            'pdf += "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\n"',
            'xref_pos = len(pdf)',
            'pdf += "xref\\n0 6\\n0000000000 65535 f \\n"',
            'pdf += "trailer<</Size 6/Root 1 0 R>>\\nstartxref\\n" + str(xref_pos) + "\\n%%EOF\\n"',
            'pdf += ("% " + "x" * 998 + "\\n") * 500',
            f'with open("/home/user/workspace/docs/analysis-{version}.pdf", "wb") as f:',
            '    f.write(pdf.encode())',
            f"print(os.path.getsize(\"/home/user/workspace/docs/analysis-{version}.pdf\"))'",
        ]),
        timeout_ms=30000,
    )
    log_info(f'    PDF: {pdf_result.stdout.strip()} bytes')

    # 4. CSV (~1MB)
    csv_result = await evolve_inst.execute_command(
        ' && '.join([
            'mkdir -p /home/user/workspace/data',
            f'echo "ID,Name,Value,Score,Version,Notes" > /home/user/workspace/data/metrics-{version}.csv',
            f'for i in $(seq 1 10000); do echo "$i,item_$i,$i.314,$i.271,{version},Note for row $i with padding text to increase size" >> /home/user/workspace/data/metrics-{version}.csv; done',
            f'wc -c /home/user/workspace/data/metrics-{version}.csv',
        ]),
        timeout_ms=60000,
    )
    log_info(f'    CSV: {csv_result.stdout.strip()}')


# =============================================================================
# S3 CLEANUP
# =============================================================================

async def cleanup_s3_prefix() -> None:
    """Clean up S3 test objects."""
    log_info('-- Phase 9: Cleanup')
    if IS_GATEWAY:
        log_info('  Skipping S3 cleanup (gateway mode)')
        return
    try:
        import boto3
        client = boto3.client('s3', region_name=STORAGE_REGION)
        bucket = 'swarmkit-test-checkpoints-905418019965'
        prefix = f'py-integration-test-26-{PROVIDER_NAME}/'

        total_deleted = 0
        continuation_token = None

        while True:
            list_kwargs = {'Bucket': bucket, 'Prefix': prefix}
            if continuation_token:
                list_kwargs['ContinuationToken'] = continuation_token

            response = client.list_objects_v2(**list_kwargs)
            objects = response.get('Contents', [])

            if objects:
                client.delete_objects(
                    Bucket=bucket,
                    Delete={
                        'Objects': [{'Key': obj['Key']} for obj in objects],
                        'Quiet': True,
                    },
                )
                total_deleted += len(objects)

            if not response.get('IsTruncated'):
                break
            continuation_token = response.get('NextContinuationToken')

        log_result(True, f'Deleted {total_deleted} objects from s3://{bucket}/{prefix}')
    except Exception as e:
        log_info(f'  WARNING: S3 cleanup failed: {e}')


# =============================================================================
# TEST
# =============================================================================


@pytest.mark.asyncio
async def test_storage_full_surface():
    """Full storage surface: 8 phases mirroring TS test 26."""
    log_section(f'Storage full surface ({STORAGE_MODE} mode)')

    provider = create_sandbox_provider(PROVIDER_NAME)
    storage_config = get_storage_config()

    log_info(f'Using provider: {PROVIDER_NAME}, storage: {STORAGE_MODE}')

    tmp_dir = tempfile.mkdtemp(prefix='evolve-py-test-26-')

    try:
        # =================================================================
        # Phase 1: Checkpoint Lifecycle — auto-checkpoint, explicit, lineage
        # =================================================================
        log_info('-- Phase 1: Checkpoint Lifecycle')

        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        ) as evolve1:
            # Init sandbox with throwaway run so we can seed files
            log_info('  [1a] Initializing sandbox...')
            seed_run = await evolve1.run(
                prompt='Say OK',
                timeout_ms=TIMEOUT,
            )

            # Seed real multi-MB files
            await seed_workspace_files(evolve1, 'v1')

            # --- Run 1: checkpoint with real files ---
            log_info('  [1b] Running agent over v1 files...')
            run1 = await evolve1.run(
                prompt='List all files in workspace/ recursively with sizes. Use: find workspace/ -type f -exec ls -lh {} \\;',
                timeout_ms=TIMEOUT,
                checkpoint_comment='initial v1 — multi-format files',
            )

            assert_true(run1.exit_code == 0, 'run1 exits 0')
            assert_true(run1.checkpoint is not None, 'run1.checkpoint is defined')

            checkpoint1 = run1.checkpoint
            assert_true(checkpoint1.id is not None, 'checkpoint1.id is defined')
            assert_true(checkpoint1.hash is not None, 'checkpoint1.hash is defined')
            assert_true(len(checkpoint1.hash) == 64, f'checkpoint1.hash is SHA-256 (64 hex chars, got {len(checkpoint1.hash)})')
            assert_true(bool(re.match(r'^[a-f0-9]{64}$', checkpoint1.hash)), 'checkpoint1.hash is valid hex')
            assert_true(checkpoint1.tag is not None, 'checkpoint1.tag is defined')
            assert_true(checkpoint1.timestamp is not None, 'checkpoint1.timestamp is defined')
            assert_true(
                checkpoint1.size_bytes is not None and checkpoint1.size_bytes > 0,
                f'checkpoint1.size_bytes > 0 (got {checkpoint1.size_bytes})',
            )
            assert_true(checkpoint1.agent_type == 'claude', 'checkpoint1.agent_type is claude')
            assert_true(checkpoint1.comment == 'initial v1 — multi-format files', 'checkpoint1.comment matches')
            assert_true(
                checkpoint1.parent_id is None or checkpoint1.parent_id == (seed_run.checkpoint.id if seed_run.checkpoint else None),
                'checkpoint1.parent_id is None or links to seed',
            )

            session_tag = checkpoint1.tag
            log_info(f'  Checkpoint 1: id={checkpoint1.id}, hash={checkpoint1.hash[:12]}..., size={checkpoint1.size_bytes} bytes')

            # --- Run 2: modify files (v2), verify parentId ---
            log_info('  [1c] Updating files to v2...')
            await seed_workspace_files(evolve1, 'v2')

            run2 = await evolve1.run(
                prompt='List all files in workspace/ recursively. Use: find workspace/ -type f',
                timeout_ms=TIMEOUT,
                checkpoint_comment='updated to v2',
            )

            assert_true(run2.exit_code == 0, 'run2 exits 0')
            assert_true(run2.checkpoint is not None, 'run2.checkpoint is defined')
            checkpoint2 = run2.checkpoint
            assert_true(checkpoint2.comment == 'updated to v2', 'checkpoint2.comment matches')
            assert_true(checkpoint2.parent_id is not None, 'checkpoint2.parent_id is defined (lineage chains)')

            log_info(f'  Checkpoint 2: id={checkpoint2.id}, parentId={checkpoint2.parent_id}')

            # --- Explicit checkpoint ---
            log_info('  [1d] Explicit checkpoint...')
            checkpoint3 = await evolve1.checkpoint(comment='manual snapshot after v2')
            assert_true(checkpoint3.id is not None, 'checkpoint3.id is defined')
            assert_true(checkpoint3.comment == 'manual snapshot after v2', 'checkpoint3.comment matches')
            assert_true(checkpoint3.parent_id == checkpoint2.id, 'checkpoint3.parentId === checkpoint2.id')

            log_info(f'  Checkpoint 3 (explicit): id={checkpoint3.id}, parentId={checkpoint3.parent_id}')

        log_result(True, 'Phase 1 complete')

        # =================================================================
        # Phase 2: Dedup — same content = same hash, different ID
        # =================================================================
        log_info('-- Phase 2: Content-Addressed Dedup')

        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        ) as evolve2:
            run3 = await evolve2.run(
                prompt='Read workspace/docs/report-v2.txt and tell me the first line only. Do NOT create or modify any files.',
                from_checkpoint=checkpoint3.id,
                timeout_ms=TIMEOUT,
                checkpoint_comment='read-only run for dedup test',
            )

            assert_true(run3.exit_code == 0, 'dedup run exits 0')
            assert_true(run3.checkpoint is not None, 'dedup run has checkpoint')
            checkpoint4 = run3.checkpoint

            if checkpoint4.hash == checkpoint3.hash:
                log_info('  Same hash — dedup skipped re-upload (workspace unchanged)')
            else:
                log_info(f'  Different hashes — agent likely modified workspace (cp3: {checkpoint3.hash[:16]}..., cp4: {checkpoint4.hash[:16]}...)')

            assert_true(checkpoint4.id != checkpoint3.id, 'checkpoint IDs are different despite potential dedup')

        log_result(True, 'Phase 2 complete')

        # =================================================================
        # Phase 3: Restore & Verify File Contents + Agent Environment
        # =================================================================
        log_info('-- Phase 3: Restore & Verify File Contents + Agent Environment')

        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        ) as evolve3:
            run4 = await evolve3.run(
                prompt='Read workspace/docs/report-v1.txt and tell me the FIRST line. Then check: does workspace/docs/report-v2.txt exist? Answer both.',
                from_checkpoint=checkpoint1.id,
                timeout_ms=TIMEOUT,
                checkpoint_comment='restored v1 verification',
            )

            assert_true(run4.exit_code == 0, 'restore run exits 0')
            assert_true('v1' in run4.stdout, 'stdout mentions v1 content from restored checkpoint')
            assert_true(run4.checkpoint is not None, 'restore run has checkpoint')
            checkpoint5 = run4.checkpoint
            assert_true(
                checkpoint5.parent_id == checkpoint1.id,
                'restored checkpoint parentId === checkpoint1.id (lineage tracks restore source)',
            )

            # Verify agent environment survived checkpoint + restore
            log_info('  [3b] Verifying agent environment after restore...')

            skills_check = await evolve3.execute_command(
                'ls ~/.claude/skills/ 2>/dev/null || echo "no skills dir"',
                timeout_ms=10000,
            )
            assert_true('no skills dir' not in skills_check.stdout, 'skills directory exists after restore')

            settings_check = await evolve3.execute_command(
                'cat ~/.claude/settings.json 2>/dev/null || echo "no settings config"',
                timeout_ms=10000,
            )
            assert_true('no settings config' not in settings_check.stdout, 'settings.json exists after restore')

            claude_md_check = await evolve3.execute_command(
                'head -5 ~/workspace/CLAUDE.md 2>/dev/null || echo "no CLAUDE.md"',
                timeout_ms=10000,
            )
            assert_true('no CLAUDE.md' not in claude_md_check.stdout, 'workspace CLAUDE.md exists after restore')

        log_result(True, 'Phase 3 complete')

        # =================================================================
        # Phase 4: from: "latest" — Global Resolution
        # =================================================================
        log_info('-- Phase 4: from: "latest"')

        # Small delay for S3 consistency
        await asyncio.sleep(3)

        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        ) as evolve4:
            run5 = await evolve4.run(
                prompt='List files in workspace/docs/. Use: ls -la workspace/docs/',
                from_checkpoint='latest',
                timeout_ms=TIMEOUT,
            )

            assert_true(run5.exit_code == 0, 'from:latest run exits 0')
            assert_true(run5.checkpoint is not None, 'from:latest run has checkpoint')
            assert_true(
                run5.checkpoint.parent_id is not None,
                'from:latest checkpoint has parentId (linked to most recent)',
            )

        log_result(True, 'Phase 4 complete')

        # =================================================================
        # Phase 5: Standalone storage() Client — Full Surface
        # =================================================================
        log_info('-- Phase 5: Standalone storage() client')

        store = create_storage(storage_config)

        try:
            # 5a. listCheckpoints() — all, newest first
            log_info('  [5a] listCheckpoints()...')
            all_checkpoints = await store.list_checkpoints()
            assert_true(len(all_checkpoints) >= 5, f'listCheckpoints() returned {len(all_checkpoints)} (expected >= 5)')
            assert_true(isinstance(all_checkpoints[0], CheckpointInfo), 'returns CheckpointInfo objects')
            for i in range(1, len(all_checkpoints)):
                assert_true(
                    all_checkpoints[i - 1].timestamp >= all_checkpoints[i].timestamp,
                    f'newest-first ordering: [{i - 1}] >= [{i}]',
                )
            log_result(True, f'listCheckpoints returned {len(all_checkpoints)} checkpoints, newest-first')

            # 5b. listCheckpoints(limit=2) — exact count
            log_info('  [5b] listCheckpoints(limit=2)...')
            limited = await store.list_checkpoints(limit=2)
            assert_true(len(limited) == 2, 'limit=2 returns exactly 2')
            assert_true(limited[0].id == all_checkpoints[0].id, 'limit=2 newest matches full list newest')
            log_result(True, 'limit works')

            # 5c. listCheckpoints(tag=...) — filters by tag
            log_info('  [5c] listCheckpoints(tag=...)...')
            by_tag = await store.list_checkpoints(tag=session_tag)
            assert_true(len(by_tag) >= 3, f'tag filter returned {len(by_tag)} (expected >= 3)')
            assert_true(
                all(cp.tag == session_tag for cp in by_tag),
                'all tag-filtered results have matching tag',
            )
            log_result(True, f'tag filter returned {len(by_tag)} checkpoints')

            # 5d. getCheckpoint(id) — correct metadata
            log_info('  [5d] getCheckpoint(id)...')
            cp = await store.get_checkpoint(checkpoint1.id)
            assert_true(cp.id == checkpoint1.id, 'getCheckpoint returns correct id')
            assert_true(cp.hash == checkpoint1.hash, 'getCheckpoint returns correct hash')
            assert_true(cp.comment == 'initial v1 — multi-format files', 'getCheckpoint returns correct comment')
            log_result(True, f'getCheckpoint returned id={cp.id}, hash={cp.hash[:12]}...')

            # 5e. getCheckpoint("nonexistent") — throws
            log_info('  [5e] getCheckpoint("nonexistent")...')
            try:
                await store.get_checkpoint('nonexistent-id-xyz-12345')
                raise AssertionError('getCheckpoint with nonexistent ID should throw')
            except AssertionError:
                raise
            except Exception as e:
                assert_true('not found' in str(e).lower(), f'error contains "not found": {e}')
            log_result(True, 'getCheckpoint with nonexistent ID throws')

            # 5f. downloadCheckpoint — extract to disk
            log_info('  [5f] downloadCheckpoint (extract=True)...')
            extract_dir = os.path.join(tmp_dir, 'extract-test')
            os.makedirs(extract_dir, exist_ok=True)
            path = await store.download_checkpoint(checkpoint1.id, to=extract_dir)
            assert_true(path is not None, 'downloadCheckpoint returns path')

            # Check that real files exist on disk
            txt_path = os.path.join(extract_dir, 'workspace/docs/report-v1.txt')
            assert_true(os.path.exists(txt_path), 'extracted TXT file exists on disk')
            with open(txt_path, 'r') as f:
                txt_content = f.read()
            assert_true('v1' in txt_content, 'extracted TXT contains v1 content')
            assert_true(
                os.path.getsize(txt_path) > 100000,
                f'extracted TXT is substantial ({os.path.getsize(txt_path)} bytes)',
            )

            # Check PNG exists
            png_path = os.path.join(extract_dir, 'workspace/assets/chart-v1.png')
            assert_true(os.path.exists(png_path), 'extracted PNG file exists on disk')
            assert_true(
                os.path.getsize(png_path) > 1000,
                f'extracted PNG is substantial ({os.path.getsize(png_path)} bytes)',
            )

            # Check PDF exists
            pdf_path = os.path.join(extract_dir, 'workspace/docs/analysis-v1.pdf')
            assert_true(os.path.exists(pdf_path), 'extracted PDF file exists on disk')

            # Check CSV exists
            csv_path = os.path.join(extract_dir, 'workspace/data/metrics-v1.csv')
            assert_true(os.path.exists(csv_path), 'extracted CSV file exists on disk')
            assert_true(
                os.path.getsize(csv_path) > 10000,
                f'extracted CSV is substantial ({os.path.getsize(csv_path)} bytes)',
            )

            log_result(True, 'downloadCheckpoint extracted with all file types verified')

            # 5g. downloadCheckpoint — raw archive
            log_info('  [5g] downloadCheckpoint (extract=False)...')
            raw_dir = os.path.join(tmp_dir, 'raw-test')
            os.makedirs(raw_dir, exist_ok=True)
            archive_path = await store.download_checkpoint(checkpoint1.id, to=raw_dir, extract=False)
            assert_true(archive_path.endswith('.tar.gz'), 'raw download ends with .tar.gz')
            assert_true(os.path.exists(archive_path), 'raw archive exists on disk')
            assert_true(
                os.path.getsize(archive_path) > 10000,
                f'raw archive is substantial ({os.path.getsize(archive_path)} bytes)',
            )
            log_result(True, f'downloadCheckpoint raw archive: {os.path.getsize(archive_path)} bytes')

            # 5h. downloadFiles — specific file
            log_info('  [5h] downloadFiles(files=[...])...')
            file_map = await store.download_files(checkpoint1.id, files=['workspace/docs/report-v1.txt'])
            assert_true(isinstance(file_map, dict), 'downloadFiles returns a dict')
            report_content = file_map.get('workspace/docs/report-v1.txt')
            assert_true(report_content is not None, 'FileMap has workspace/docs/report-v1.txt')
            report_text = report_content if isinstance(report_content, str) else report_content.decode('utf-8')
            assert_true('v1' in report_text, 'downloaded TXT contains v1 content')
            assert_true(len(report_text) > 100000, f'downloaded TXT is substantial ({len(report_text)} chars)')
            log_result(True, f'downloadFiles returned specific file ({len(report_text)} chars)')

            # 5i. downloadFiles — glob matching
            log_info('  [5i] downloadFiles(glob=[...])...')
            glob_map = await store.download_files(checkpoint1.id, glob=['workspace/docs/*.txt'])
            assert_true(isinstance(glob_map, dict), 'glob downloadFiles returns a dict')
            glob_keys = list(glob_map.keys())
            assert_true(len(glob_keys) > 0, 'glob matched at least one file')
            assert_true(
                any('report-v1.txt' in k for k in glob_keys),
                'glob matched report-v1.txt',
            )
            log_result(True, f'downloadFiles glob returned {len(glob_keys)} files')

            # 5j. downloadFiles("latest") — resolves to newest
            log_info('  [5j] downloadFiles("latest")...')
            latest_files = await store.download_files('latest')
            assert_true(isinstance(latest_files, dict), 'latest downloadFiles returns a dict')
            assert_true(len(latest_files) > 0, 'latest has files')
            log_result(True, f'downloadFiles("latest") returned {len(latest_files)} files')

            # 5k. downloadFiles with to= — writes to disk
            log_info('  [5k] downloadFiles(to=...)...')
            disk_dir = os.path.join(tmp_dir, 'disk-test')
            os.makedirs(disk_dir, exist_ok=True)
            await store.download_files(
                checkpoint1.id,
                files=['workspace/docs/report-v1.txt'],
                to=disk_dir,
            )
            assert_true(
                os.path.exists(os.path.join(disk_dir, 'workspace/docs/report-v1.txt')),
                'downloadFiles wrote file to disk',
            )
            log_result(True, 'downloadFiles(to=...) wrote file to disk')

        finally:
            await store.close()

        log_result(True, 'Phase 5 complete')

        # =================================================================
        # Phase 6: evolve.storage() Accessor
        # =================================================================
        log_info('-- Phase 6: evolve.storage() accessor')

        evolve6 = Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        )

        try:
            bound_client = evolve6.storage()
            assert_true(isinstance(bound_client, StorageClient), 'evolve.storage() returns StorageClient')

            # 6a. listCheckpoints — same as standalone
            bound_all = await bound_client.list_checkpoints()
            assert_true(
                len(bound_all) == len(all_checkpoints),
                f'evolve.storage().listCheckpoints() count matches standalone ({len(bound_all)})',
            )
            assert_true(
                bound_all[0].id == all_checkpoints[0].id,
                'evolve.storage() newest matches standalone newest',
            )

            # 6b. getCheckpoint — returns metadata
            bound_cp = await bound_client.get_checkpoint(checkpoint1.id)
            assert_true(bound_cp.id == checkpoint1.id, 'evolve.storage().getCheckpoint() returns correct id')
            assert_true(bound_cp.hash == checkpoint1.hash, 'evolve.storage().getCheckpoint() returns correct hash')

            # 6c. downloadFiles — returns file contents
            bound_files = await bound_client.download_files(checkpoint1.id, glob=['workspace/docs/*.txt'])
            assert_true(len(bound_files) > 0, 'evolve.storage().downloadFiles() returns files')

            # 6d. evolve.list_checkpoints() convenience
            conv_list = await evolve6.list_checkpoints()
            assert_true(
                len(conv_list) == len(all_checkpoints),
                f'evolve.list_checkpoints() count matches ({len(conv_list)})',
            )
            assert_true(conv_list[0].id == all_checkpoints[0].id, 'evolve.list_checkpoints() newest matches')

        finally:
            await evolve6.bridge.stop()

        log_result(True, 'Phase 6 complete')

        # =================================================================
        # Phase 7: Parallel Scale — 3 concurrent Evolve instances
        # =================================================================
        log_info('-- Phase 7: Parallel Scale (3 concurrent instances)')

        async def run_parallel_instance(label: str):
            """Run a parallel Evolve instance with unique files."""
            async with Evolve(
                config=agent_config,
                sandbox=provider,
                storage=storage_config,
            ) as e:
                # Init sandbox
                await e.run(prompt='Say OK', timeout_ms=TIMEOUT)

                # Seed unique files
                await e.execute_command(
                    ' && '.join([
                        'mkdir -p /home/user/workspace/parallel',
                        f'echo "Session: {label}" > /home/user/workspace/parallel/{label}-output.txt',
                        f'for i in $(seq 1 5000); do echo "data-row-$i-{label}-padding-text-for-size" >> /home/user/workspace/parallel/{label}-output.txt; done',
                        f'wc -c /home/user/workspace/parallel/{label}-output.txt',
                    ]),
                    timeout_ms=30000,
                )

                r = await e.run(
                    prompt=f'Read workspace/parallel/{label}-output.txt and tell me the first line.',
                    timeout_ms=TIMEOUT,
                    checkpoint_comment=f'parallel-{label}',
                )

                return {'checkpoint': r.checkpoint, 'tag': r.checkpoint.tag, 'label': label}

        parallel_results = await asyncio.gather(
            run_parallel_instance('alpha'),
            run_parallel_instance('beta'),
            run_parallel_instance('gamma'),
        )

        # All 3 produced checkpoints
        for r in parallel_results:
            assert_true(r['checkpoint'] is not None, f'parallel {r["label"]} has checkpoint')
            assert_true(
                r['checkpoint'].comment == f'parallel-{r["label"]}',
                f'parallel {r["label"]} comment matches',
            )

        # All 3 tags are different
        tags = [r['tag'] for r in parallel_results]
        assert_true(len(set(tags)) == 3, 'all 3 parallel sessions have unique tags')

        # listCheckpoints returns all (previous phases + parallel)
        store2 = create_storage(storage_config)
        try:
            all_after_parallel = await store2.list_checkpoints()
            assert_true(
                len(all_after_parallel) >= len(all_checkpoints) + 3,
                f'listCheckpoints after parallel: {len(all_after_parallel)} (expected >= {len(all_checkpoints) + 3})',
            )

            # Tag filtering isolates per-session
            for r in parallel_results:
                tag_filtered = await store2.list_checkpoints(tag=r['tag'])
                assert_true(
                    len(tag_filtered) >= 1,
                    f'tag filter for {r["label"]} returns >= 1 (got {len(tag_filtered)})',
                )
                assert_true(
                    all(cp.tag == r['tag'] for cp in tag_filtered),
                    f'tag filter for {r["label"]}: all results have correct tag',
                )

            # downloadFiles on parallel checkpoint returns the correct unique content
            for r in parallel_results:
                files = await store2.download_files(
                    r['checkpoint'].id,
                    files=[f'workspace/parallel/{r["label"]}-output.txt'],
                )
                raw_content = files.get(f'workspace/parallel/{r["label"]}-output.txt')
                content = raw_content if isinstance(raw_content, str) else (raw_content.decode('utf-8') if raw_content else None)
                assert_true(content is not None, f'parallel {r["label"]} file downloadable')
                assert_true(
                    f'Session: {r["label"]}' in content,
                    f'parallel {r["label"]} file has correct content',
                )
        finally:
            await store2.close()

        log_result(True, 'Phase 7 complete')

        # =================================================================
        # Phase 8: Error Cases
        # =================================================================
        log_info('-- Phase 8: Error cases')

        # 8a. from + sandbox_id conflict
        try:
            async with Evolve(
                config=agent_config,
                sandbox=provider,
                storage=storage_config,
                sandbox_id='some-sandbox-id',
            ) as e_conflict:
                await e_conflict.run(
                    prompt='test',
                    from_checkpoint=checkpoint1.id,
                    timeout_ms=30000,
                )
            raise AssertionError('from + sandbox_id should throw')
        except AssertionError:
            raise
        except Exception as e:
            assert_true('withsession' in str(e).lower() or 'mutually exclusive' in str(e).lower(),
                        f'from + sandbox_id throws mutual exclusivity error: {e}')
        log_result(True, 'from + sandbox_id throws mutual exclusivity error')

        # 8b. getCheckpoint nonexistent
        store3 = create_storage(storage_config)
        try:
            try:
                await store3.get_checkpoint('nonexistent_id_12345')
                raise AssertionError('should throw')
            except AssertionError:
                raise
            except Exception as e:
                assert_true('not found' in str(e).lower(), f'getCheckpoint nonexistent throws: {e}')
            log_result(True, 'getCheckpoint nonexistent throws')

            # 8c. downloadFiles nonexistent
            try:
                await store3.download_files('nonexistent_id_12345')
                raise AssertionError('should throw')
            except AssertionError:
                raise
            except Exception as e:
                assert_true('not found' in str(e).lower(), f'downloadFiles nonexistent throws: {e}')
            log_result(True, 'downloadFiles nonexistent throws')

            # 8d. downloadCheckpoint nonexistent
            try:
                await store3.download_checkpoint('nonexistent_id_12345')
                raise AssertionError('should throw')
            except AssertionError:
                raise
            except Exception as e:
                assert_true('not found' in str(e).lower(), f'downloadCheckpoint nonexistent throws: {e}')
            log_result(True, 'downloadCheckpoint nonexistent throws')

        finally:
            await store3.close()

        # 8e. storage() without config raises
        evolve_no_storage = Evolve(config=agent_config, sandbox=provider)
        try:
            evolve_no_storage.storage()
            raise AssertionError('storage() without config should raise')
        except RuntimeError as e:
            assert_true('not configured' in str(e).lower(), f'storage() raises RuntimeError: {e}')
        log_result(True, 'storage() without config raises RuntimeError')

        log_result(True, 'Phase 8 complete')

        # =================================================================
        # Phase 9: Cleanup
        # =================================================================
        await cleanup_s3_prefix()

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    log_result(True, 'All storage full surface tests passed')
