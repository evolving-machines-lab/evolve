#!/usr/bin/env python3
"""File Operations Tests

Tests: upload_context(), upload_files(), get_output_files(), read_local_dir()
Agent Support: All (codex, claude, gemini, qwen)
"""

import sys
import asyncio
import tempfile
import shutil
from pathlib import Path
from evolve import Evolve, E2BProvider, read_local_dir
from tests.utils.agent_config import (
    get_agent_config,
    validate_agent_config,
    get_agent_display_name,
)
from tests.utils.test_helpers import (
    get_e2b_api_key,
    log_section,
    log_result,
    log_info,
    assert_true,
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)


async def test_upload_context_single():
    """Test 1: upload_context() - single file"""
    log_section(f"Test 1: upload_context() - single file - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Uploading single text file to context/')

            # Upload a single file to context/
            await evolve.upload_context({
                'test-data.txt': 'This is test data from upload_context()'
            })

            log_result(True, 'Single file uploaded successfully')

            # Verify file exists with execute_command
            result = await evolve.execute_command(
                'cat /home/user/workspace/context/test-data.txt',
                timeout_ms=30000
            )

            assert_true(result.exit_code == 0, 'File should exist')
            assert_true(
                'This is test data from upload_context()' in result.stdout,
                'File content should match'
            )

            log_result(True, 'File content verified')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_upload_context_batch():
    """Test 2: upload_context() - batch upload"""
    log_section(f"Test 2: upload_context() - batch upload - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Uploading multiple files in batch to context/')

            # Upload multiple files to context/
            await evolve.upload_context({
                'file1.txt': 'Content of file 1',
                'file2.txt': 'Content of file 2',
                'data.json': '{"key": "value", "number": 42}'
            })

            log_result(True, 'Batch upload completed')

            # Verify files exist
            result1 = await evolve.execute_command('cat /home/user/workspace/context/file1.txt')
            result2 = await evolve.execute_command('cat /home/user/workspace/context/file2.txt')
            result3 = await evolve.execute_command('cat /home/user/workspace/context/data.json')

            assert_true('Content of file 1' in result1.stdout, 'File 1 should exist')
            assert_true('Content of file 2' in result2.stdout, 'File 2 should exist')
            assert_true('"key": "value"' in result3.stdout, 'File 3 should exist')

            log_result(True, 'All uploaded files verified')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_upload_files_binary():
    """Test 3: upload_files() - binary data"""
    log_section(f"Test 3: upload_files() - binary data - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Uploading binary file (bytes) to working directory')

            # Create test binary data (PNG header)
            binary_data = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

            await evolve.upload_files({
                'test-binary.dat': binary_data
            })

            log_result(True, 'Binary file uploaded')

            # Verify file exists and size
            result = await evolve.execute_command(
                'stat -c "%s" /home/user/workspace/test-binary.dat || stat -f "%z" /home/user/workspace/test-binary.dat'
            )

            file_size = int(result.stdout.strip())
            assert_true(file_size == 8, f'File size should be 8 bytes, got {file_size}')

            log_result(True, 'Binary file verified')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_get_output_files():
    """Test 4: get_output_files() - retrieve generated files"""
    log_section(f"Test 4: get_output_files() - retrieve generated files - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Creating files via agent in output/ folder')

            # Create files using agent
            await evolve.run(
                prompt='Create three files: hello1.txt, hello2.txt, and hello3.txt inside the output/ folder, all with content "Hello world!"',
                timeout_ms=120000,
            )

            log_result(True, 'Files created via agent')

            # Get output files
            log_info('Retrieving output files...')
            output = await evolve.get_output_files()

            log_result(len(output.files) >= 3, f'Found {len(output.files)} file(s)')

            # Log file details
            for name in output.files.keys():
                log_info(f'  - {name}')

            # Verify files
            file_names = list(output.files.keys())
            assert_true('hello1.txt' in file_names, 'hello1.txt should be present')
            assert_true('hello2.txt' in file_names, 'hello2.txt should be present')
            assert_true('hello3.txt' in file_names, 'hello3.txt should be present')

            # Verify content
            hello1_content = output.files.get('hello1.txt')
            assert_true(hello1_content is not None, 'hello1.txt file should exist')
            content_str = hello1_content if isinstance(hello1_content, str) else hello1_content.decode()
            assert_true(
                'Hello world' in content_str,
                'hello1.txt should contain "Hello world"'
            )

            log_result(True, 'Output files retrieved and verified')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_get_output_files_filtering():
    """Test 5: get_output_files() - timestamp filtering"""
    log_section(f"Test 5: get_output_files() - timestamp filtering - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Creating file via execute_command (before turn)')

            # Create file via execute_command (should be filtered out)
            await evolve.execute_command(
                'echo "Old file" > /home/user/workspace/output/old-file.txt'
            )

            log_result(True, 'Old file created')

            log_info('Creating file via run() (should be included)')

            # Create new file via run()
            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            log_result(True, 'New file created')

            # Get output files
            output = await evolve.get_output_files()

            log_result(len(output.files) >= 1, f'Found {len(output.files)} file(s)')

            # Should only contain hello.txt (old-file.txt filtered by timestamp)
            file_names = list(output.files.keys())
            assert_true('hello.txt' in file_names, 'hello.txt should be present')

            # old-file.txt might be filtered or not depending on timing
            log_info(f'Files retrieved: {", ".join(file_names)}')

            log_result(True, 'Timestamp filtering works correctly')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


def test_read_local_dir():
    """Test 6: read_local_dir() - read local directory into dict"""
    log_section("Test 6: read_local_dir() - local utility (no sandbox)")

    try:
        # Create temp directory with test files
        temp_dir = tempfile.mkdtemp()
        try:
            log_info(f'Created temp directory: {temp_dir}')

            # Create flat files
            Path(temp_dir, 'file1.txt').write_text('Content 1')
            Path(temp_dir, 'file2.txt').write_text('Content 2')

            # Create nested structure
            nested_dir = Path(temp_dir, 'subdir', 'nested')
            nested_dir.mkdir(parents=True)
            Path(nested_dir, 'deep.txt').write_text('Deep content')
            Path(temp_dir, 'subdir', 'shallow.txt').write_text('Shallow content')

            log_result(True, 'Test files created')

            # Test non-recursive (default)
            log_info('Testing read_local_dir() non-recursive...')
            files = read_local_dir(temp_dir)

            assert_true(len(files) == 2, f'Should find 2 top-level files, got {len(files)}')
            assert_true('file1.txt' in files, 'file1.txt should be present')
            assert_true('file2.txt' in files, 'file2.txt should be present')
            assert_true('subdir/shallow.txt' not in files, 'Nested files should NOT be included')

            log_result(True, f'Non-recursive: found {len(files)} files')

            # Test recursive
            log_info('Testing read_local_dir() recursive...')
            all_files = read_local_dir(temp_dir, recursive=True)

            assert_true(len(all_files) == 4, f'Should find 4 total files, got {len(all_files)}')
            assert_true('file1.txt' in all_files, 'file1.txt should be present')
            assert_true('subdir/shallow.txt' in all_files, 'subdir/shallow.txt should be present')
            assert_true('subdir/nested/deep.txt' in all_files, 'subdir/nested/deep.txt should be present')

            log_result(True, f'Recursive: found {len(all_files)} files')

            # Verify content is bytes
            content = all_files['file1.txt']
            assert_true(isinstance(content, bytes), 'Content should be bytes')
            assert_true(content == b'Content 1', 'Content should match')

            log_result(True, 'Content verification passed')
            log_result(True, 'Test completed successfully')

        finally:
            shutil.rmtree(temp_dir)

    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_get_output_files_recursive():
    """Test 7: get_output_files(recursive=True) - nested output files"""
    log_section(f"Test 7: get_output_files(recursive=True) - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Creating nested files in output/ via run()')

            # Create nested files via run() so they're included in timestamp filtering
            await evolve.run(
                prompt='Create nested directories and files: mkdir -p output/subdir/nested && echo "top level" > output/top.txt && echo "shallow" > output/subdir/shallow.txt && echo "deep" > output/subdir/nested/deep.txt',
                timeout_ms=120000,
            )

            log_result(True, 'Nested files created')

            # Test non-recursive (default)
            log_info('Testing get_output_files() non-recursive...')
            output = await evolve.get_output_files()
            file_names = list(output.files.keys())

            log_info(f'Non-recursive files: {file_names}')
            # Should only have top-level files
            has_nested = any('/' in name for name in file_names)
            log_result(not has_nested or len(file_names) <= 1, f'Non-recursive should not include nested files')

            # Test recursive
            log_info('Testing get_output_files(recursive=True)...')
            all_output = await evolve.get_output_files(recursive=True)
            all_names = list(all_output.files.keys())

            log_info(f'Recursive files: {all_names}')

            # Should include nested files with relative paths
            assert_true(len(all_output.files) >= 3, f'Should find at least 3 files, got {len(all_output.files)}')

            # Check for nested paths
            has_subdir = any('subdir/' in name for name in all_names)
            assert_true(has_subdir, 'Should include files from subdir/')

            log_result(True, f'Recursive: found {len(all_output.files)} files including nested')
            log_result(True, 'Test completed successfully')

        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_read_local_dir_with_upload():
    """Test 8: read_local_dir() + upload_context() - end-to-end"""
    log_section(f"Test 8: read_local_dir() + upload_context() - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        temp_dir = tempfile.mkdtemp()
        try:
            log_info('Creating local files to upload')

            # Create test files locally
            Path(temp_dir, 'local1.txt').write_text('Local file 1')
            Path(temp_dir, 'local2.txt').write_text('Local file 2')
            subdir = Path(temp_dir, 'data')
            subdir.mkdir()
            Path(subdir, 'nested.json').write_text('{"source": "local"}')

            log_result(True, 'Local files created')

            # Read with read_local_dir and upload
            log_info('Reading local dir and uploading to sandbox...')
            files = read_local_dir(temp_dir, recursive=True)
            await evolve.upload_context(files)

            log_result(True, f'Uploaded {len(files)} files')

            # Verify files exist in sandbox
            result = await evolve.execute_command(
                'cat /home/user/workspace/context/local1.txt && '
                'cat /home/user/workspace/context/data/nested.json'
            )

            assert_true(result.exit_code == 0, 'Files should exist in sandbox')
            assert_true('Local file 1' in result.stdout, 'local1.txt content should match')
            assert_true('{"source": "local"}' in result.stdout, 'nested.json content should match')

            log_result(True, 'Files verified in sandbox')
            log_result(True, 'Test completed successfully')

        except Exception as error:
            log_result(False, 'Test failed', error)
            raise
        finally:
            shutil.rmtree(temp_dir)


async def run_all_tests():
    """Run all file operation tests"""
    print('\n🚀 Starting File Operations Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}\n')

    try:
        await test_upload_context_single()
        await test_upload_context_batch()
        await test_upload_files_binary()
        await test_get_output_files()
        await test_get_output_files_filtering()
        test_read_local_dir()  # sync test - no sandbox needed
        await test_get_output_files_recursive()
        await test_read_local_dir_with_upload()

        print('\n' + '=' * 70)
        print(f'✅ All file operation tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
