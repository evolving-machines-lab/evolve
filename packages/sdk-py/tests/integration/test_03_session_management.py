#!/usr/bin/env python3
"""Session Management Tests

Tests: get_session(), set_session(), status(), interrupt(), pause(), resume(), kill()
Agent Support: All (codex, claude, gemini, qwen)
"""

import os
import sys
import asyncio
from typing import cast
from evolve import Evolve
from tests.utils.agent_config import (
    get_agent_config,
    validate_agent_config,
    get_agent_display_name,
)
from tests.utils.test_helpers import (
    ProviderName,
    create_sandbox_provider,
    get_available_providers,
    supports_pause_resume,
    supports_interrupt,
    log_section,
    log_result,
    log_info,
    assert_true,
    wait_for,
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)
HELLO_PATH = '/home/user/workspace/output/hello.txt'
CREATE_HELLO_COMMAND = f'mkdir -p /home/user/workspace/output && printf "Hello world!" > {HELLO_PATH}'


def get_test_providers() -> list[ProviderName]:
    """Resolve provider matrix for this test run.

    Use EVOLVE_TEST_PROVIDER=<e2b|daytona|modal|all> to narrow test scope.
    """
    available = get_available_providers()
    requested = os.getenv('EVOLVE_TEST_PROVIDER', 'all').strip().lower()

    if requested != 'all':
        if requested not in ('e2b', 'daytona', 'modal'):
            raise ValueError(
                f"Invalid EVOLVE_TEST_PROVIDER='{requested}'. Expected one of: e2b, daytona, modal, all"
            )
        provider = cast(ProviderName, requested)
        if provider not in available:
            raise ValueError(
                f"Requested provider '{provider}' is not configured. Available: {available or 'none'}"
            )
        return [provider]

    if not available:
        raise ValueError('No sandbox providers configured (set E2B_API_KEY and/or DAYTONA_API_KEY and/or MODAL_TOKEN_ID+MODAL_TOKEN_SECRET)')

    return available


TEST_PROVIDERS = get_test_providers()


def lifecycle_reasons(events: list[dict]) -> list[str]:
    """Extract lifecycle reasons from event payloads."""
    reasons: list[str] = []
    for event in events:
        reason = event.get('reason') if isinstance(event, dict) else None
        if isinstance(reason, str):
            reasons.append(reason)
    return reasons


async def wait_for_reason(events: list[dict], reason: str, timeout_ms: int = 120000) -> None:
    """Wait for a specific lifecycle reason to appear."""
    await wait_for(
        lambda: reason in lifecycle_reasons(events),
        timeout_ms=timeout_ms,
        check_interval_ms=250,
    )


async def wait_for_running_status(evolve: Evolve, timeout_ms: int = 120000) -> None:
    """Wait until the agent reports an active running process."""
    max_checks = max(1, timeout_ms // 250)
    for _ in range(max_checks):
        current = await evolve.status()
        if current.agent == 'running' and current.active_process_id is not None:
            return
        await asyncio.sleep(0.25)
    raise TimeoutError(f'Agent did not reach running state within {timeout_ms}ms')


async def test_get_session():
    """Test 1: get_session() - retrieve sandbox ID"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 1: get_session() - retrieve sandbox ID - {agent_name} [{provider}]")

        async with Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        ) as evolve:
            try:
                # Before initialization
                session_before = await evolve.get_session()
                log_result(session_before is None, f'Session before init: {session_before}')

                # Run a command to initialize sandbox
                log_info('Initializing sandbox with run()')
                result = await evolve.run(
                    prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                    timeout_ms=120000,
                )

                # After initialization
                session_after = await evolve.get_session()
                log_result(session_after is not None, f'Session after init: {session_after}')
                log_result(session_after == result.sandbox_id, 'Session ID matches result sandbox ID')

                assert_true(session_after is not None, 'Session should exist after run()')
                assert_true(session_after == result.sandbox_id, 'Session ID should match')

                log_result(True, 'Test completed successfully')
            except Exception as error:
                log_result(False, 'Test failed', error)
                raise


async def test_set_session():
    """Test 2: set_session() - reconnect to existing sandbox"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 2: set_session() - reconnect to existing sandbox - {agent_name} [{provider}]")

        saved_session_id = None

        # Create first Evolve instance (NO context manager - manual lifecycle)
        evolve1 = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )

        try:
            log_info('Step 1: Create sandbox and save session ID')

            # Create a file deterministically in first session
            create_result = await evolve1.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
            assert_true(create_result.exit_code == 0, 'Create hello file should succeed')

            saved_session_id = await evolve1.get_session()
            assert_true(saved_session_id is not None, 'Session ID should exist')

            log_result(True, f'Session 1 created: {saved_session_id}')

            # Don't kill - leave sandbox running for reconnection test
            log_info('Leaving sandbox running (not calling kill())')

            # Create second Evolve instance and reconnect
            log_info('Step 2: Create new Evolve instance and reconnect')

            evolve2 = Evolve(
                config=agent_config,
                sandbox=create_sandbox_provider(provider),
                workspace_mode='knowledge',
                sandbox_id=saved_session_id,  # Reconnect to same sandbox
            )

            # Verify reconnection worked via deterministic file/content checks
            result = await evolve2.execute_command(f'test -f {HELLO_PATH}')
            content_result = await evolve2.execute_command(
                f'grep -q "Hello world" {HELLO_PATH}'
            )

            assert_true(result.exit_code == 0, 'File should exist in reconnected session')
            assert_true(content_result.exit_code == 0, 'File content should be preserved')

            log_result(True, 'Successfully reconnected to existing sandbox')
            log_result(True, 'File from first session is accessible')

            # Clean up - evolve2 kills the sandbox, evolve1.kill() cleans up its bridge
            await evolve2.kill()
            try:
                await evolve1.kill()  # Sandbox already gone, but bridge cleanup still happens
            except Exception:
                # Some providers report transient state-change conflicts on second client cleanup.
                pass
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_pause_resume():
    """Test 3: pause() and resume() - suspend/resume sandbox"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 3: pause() and resume() - suspend/resume sandbox - {agent_name} [{provider}]")

        if not supports_pause_resume(provider):
            log_info('Provider does not support pause/resume; skipping')
            log_result(True, 'Skipped (unsupported on provider)')
            continue

        async with Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        ) as evolve:
            try:
                log_info('Step 1: Initialize sandbox and create file')

                # Initialize sandbox and create deterministic file
                create_result = await evolve.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
                assert_true(create_result.exit_code == 0, 'Create hello file should succeed')

                session_id = await evolve.get_session()
                log_result(True, f'Sandbox created: {session_id}')

                # Pause sandbox
                log_info('Step 2: Pausing sandbox')
                await evolve.pause()
                log_result(True, 'Sandbox paused successfully')

                # Resume sandbox
                log_info('Step 3: Resuming sandbox')
                await evolve.resume()
                log_result(True, 'Sandbox resumed successfully')

                # Verify sandbox still works
                log_info('Step 4: Verifying sandbox after resume')
                result = await evolve.execute_command(f'test -f {HELLO_PATH}')
                content_result = await evolve.execute_command(
                    f'grep -q "Hello world" {HELLO_PATH}'
                )

                assert_true(result.exit_code == 0, 'File should exist after resume')
                assert_true(content_result.exit_code == 0, 'File content should be preserved')

                log_result(True, 'Sandbox state preserved after pause/resume')
                log_result(True, 'Test completed successfully')
            except Exception as error:
                log_result(False, 'Test failed', error)
                raise


async def test_kill():
    """Test 4: kill() - terminate sandbox"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 4: kill() - terminate sandbox - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )

        try:
            log_info('Creating sandbox')

            # Initialize sandbox deterministically
            create_result = await evolve.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
            assert_true(create_result.exit_code == 0, 'Create hello file should succeed')

            session_id = await evolve.get_session()
            log_result(True, f'Sandbox created: {session_id}')

            # Kill sandbox
            log_info('Killing sandbox')
            await evolve.kill()
            log_result(True, 'Sandbox killed successfully')

            # Verify new run creates new sandbox
            log_info('Running again (should create new sandbox)')
            rerun_result = await evolve.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
            assert_true(rerun_result.exit_code == 0, 'Command should succeed after kill')

            new_session_id = await evolve.get_session()
            log_result(new_session_id != session_id, f'New sandbox created: {new_session_id}')

            assert_true(new_session_id != session_id, 'Should create new sandbox after kill()')

            await evolve.kill()
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_multiple_session_switching():
    """Test 5: Switch between multiple sandboxes"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 5: Switch between multiple sandboxes - {agent_name} [{provider}]")

        session_a = None
        session_b = None

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )

        try:
            # Create Session A
            log_info('Step 1: Creating Session A')
            create_a = await evolve.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
            assert_true(create_a.exit_code == 0, 'Create hello file in Session A should succeed')
            session_a = await evolve.get_session()
            log_result(True, f'Session A created: {session_a}')

            # Create Session B using a second Evolve instance
            # Note: We create a NEW instance but DON'T kill Session A
            log_info('Step 2: Creating Session B with new Evolve instance')

            evolve2 = Evolve(
                config=agent_config,
                sandbox=create_sandbox_provider(provider),
                workspace_mode='knowledge',
            )

            create_b = await evolve2.execute_command(CREATE_HELLO_COMMAND, timeout_ms=120000)
            assert_true(create_b.exit_code == 0, 'Create hello file in Session B should succeed')
            session_b = await evolve2.get_session()
            log_result(True, f'Session B created: {session_b}')
            assert_true(session_a != session_b, 'Sessions should be different')

            # Switch back to Session A
            log_info('Step 3: Switching back to Session A')
            await evolve.set_session(session_a)

            result_a = await evolve.execute_command(f'grep -q "Hello world" {HELLO_PATH}')
            assert_true(result_a.exit_code == 0, 'Should access Session A files')
            log_result(True, 'Successfully switched to Session A')

            # Switch to Session B
            log_info('Step 4: Switching to Session B')
            await evolve.set_session(session_b)

            result_b = await evolve.execute_command(f'grep -q "Hello world" {HELLO_PATH}')
            assert_true(result_b.exit_code == 0, 'Should access Session B files')
            log_result(True, 'Successfully switched to Session B')

            # Clean up both sessions
            await evolve.set_session(session_a)
            await evolve.kill()
            await evolve2.kill()

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_status_and_interrupt():
    """Test 6: status() and interrupt() runtime controls"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 6: status() and interrupt() - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )

        try:
            log_info('Checking initial status')
            status0 = await evolve.status()
            assert_true(status0.sandbox in ('stopped', 'ready'), 'Initial sandbox state is valid')
            assert_true(status0.agent == 'idle', 'Initial agent state is idle')

            if supports_interrupt(provider):
                log_info('Starting background command')
                await evolve.execute_command('sleep 60', timeout_ms=120000, background=True)

                # Wait for runtime to observe running state
                saw_running = False
                for _ in range(40):
                    current = await evolve.status()
                    if current.agent == 'running':
                        saw_running = True
                        break
                    await asyncio.sleep(0.25)

                assert_true(saw_running, 'Agent reaches running state for background command')

                log_info('Interrupting active command')
                interrupted = await evolve.interrupt()
                assert_true(interrupted is True, 'interrupt() returns True when process is active')

                after = await evolve.status()
                assert_true(after.sandbox == 'ready', 'Sandbox remains ready after interrupt')
                assert_true(after.agent in ('interrupted', 'idle'), 'Agent transitions after interrupt')
            else:
                log_info('Provider does not support process interrupt; validating graceful no-op')
                interrupted = await evolve.interrupt()
                assert_true(interrupted is False, 'interrupt() returns False when unsupported/idle')

            # Ensure session is still usable
            result = await evolve.execute_command('echo still-alive', timeout_ms=30000)
            assert_true(result.exit_code == 0, 'Sandbox remains usable after interrupt flow')

            await evolve.kill()
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_runtime_lifecycle_parity():
    """Test 7: lifecycle reason matrix parity with TS session lifecycle test."""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 7: runtime lifecycle parity - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )
        lifecycle_events: list[dict] = []
        evolve.on('lifecycle', lambda event: lifecycle_events.append(event))

        evolve2 = None
        evolve3 = None

        try:
            # 1) Initial status
            s0 = await evolve.status()
            assert_true(s0.sandbox in ('stopped', 'ready'), 'Initial sandbox state is valid')
            assert_true(s0.agent == 'idle', 'Initial agent state is idle')

            # 2) run() boot + completion lifecycle
            run1 = await evolve.run(
                prompt='Create output/session-test.txt with text Turn 1.',
                timeout_ms=180000,
            )
            assert_true(run1.exit_code == 0, 'Initial run succeeds')
            session_id = await evolve.get_session()
            assert_true(session_id is not None, 'Session exists after first run')
            assert_true((await evolve.status()).has_run is True, 'has_run becomes true after first run')

            reasons = lifecycle_reasons(lifecycle_events)
            assert_true('sandbox_boot' in reasons, 'Lifecycle includes sandbox_boot')
            assert_true('sandbox_ready' in reasons, 'Lifecycle includes sandbox_ready')
            assert_true('run_start' in reasons, 'Lifecycle includes run_start')
            assert_true('run_complete' in reasons, 'Lifecycle includes run_complete')

            # 3) interrupt when idle
            assert_true(await evolve.interrupt() is False, 'interrupt() returns false while idle')

            # 4) interrupt on execute_command + command_interrupted
            if supports_interrupt(provider):
                long_cmd = asyncio.create_task(
                    evolve.execute_command('sleep 60', timeout_ms=180000)
                )
                await wait_for_running_status(evolve, timeout_ms=120000)
                assert_true(await evolve.interrupt() is True, 'interrupt() returns true on active command')
                await long_cmd
                await wait_for_reason(lifecycle_events, 'command_interrupted', timeout_ms=120000)

                # 5) interrupt on run + run_interrupted
                long_run = asyncio.create_task(
                    evolve.run(
                        prompt='Run this exact command and wait for it to finish: sleep 120',
                        timeout_ms=180000,
                    )
                )
                await wait_for_running_status(evolve, timeout_ms=120000)
                assert_true(await evolve.interrupt() is True, 'interrupt() returns true on active run')
                await long_run
                await wait_for_reason(lifecycle_events, 'run_interrupted', timeout_ms=120000)

                # 6) concurrent run() rejection while command active
                long_cmd2 = asyncio.create_task(
                    evolve.execute_command('sleep 30', timeout_ms=180000)
                )
                await wait_for_running_status(evolve, timeout_ms=120000)
                threw = False
                try:
                    await evolve.run(prompt='should fail', timeout_ms=5000)
                except Exception as err:
                    threw = True
                    assert_true('already running' in str(err), 'Concurrent run throws already-running error')
                assert_true(threw, 'Concurrent run() is rejected')
                await evolve.interrupt()
                await long_cmd2
            else:
                log_info('Skipping interrupt/concurrency lifecycle checks for provider without interrupt support')

            # 7) foreground command lifecycle success/failure
            cmd_ok = await evolve.execute_command('echo hello', timeout_ms=30000)
            assert_true(cmd_ok.exit_code == 0, 'Foreground command success exits 0')
            await wait_for_reason(lifecycle_events, 'command_complete', timeout_ms=60000)

            cmd_fail = await evolve.execute_command('false', timeout_ms=30000)
            assert_true(cmd_fail.exit_code != 0, 'Foreground command failure exits non-zero')
            await wait_for_reason(lifecycle_events, 'command_failed', timeout_ms=60000)

            # 8) background command lifecycle success/failure
            bg_ok = await evolve.execute_command('echo bg-ok', timeout_ms=30000, background=True)
            assert_true(bg_ok.exit_code == 0, 'Background command success handshake exits 0')
            await wait_for_reason(lifecycle_events, 'command_background_complete', timeout_ms=60000)

            bg_fail = await evolve.execute_command('false', timeout_ms=30000, background=True)
            assert_true(bg_fail.exit_code == 0, 'Background command failure handshake exits 0')
            await wait_for_reason(lifecycle_events, 'command_background_failed', timeout_ms=120000)

            # 9) background run lifecycle success/failure
            bg_run_ok = await evolve.run(
                prompt='Say hello in one short sentence.',
                timeout_ms=180000,
                background=True,
            )
            assert_true(bg_run_ok.exit_code == 0, 'Background run success handshake exits 0')
            await wait_for_reason(lifecycle_events, 'run_background_complete', timeout_ms=120000)

            bg_run_fail = await evolve.run(
                prompt='Run this exact command and wait for it to finish: sleep 30',
                timeout_ms=1000,
                background=True,
            )
            assert_true(bg_run_fail.exit_code == 0, 'Background run failure handshake exits 0')
            await wait_for_reason(lifecycle_events, 'run_background_failed', timeout_ms=180000)

            # 10) pause/resume lifecycle
            if supports_pause_resume(provider):
                await evolve.pause()
                paused = await evolve.status()
                assert_true(paused.sandbox == 'paused', 'Sandbox state is paused after pause()')
                await wait_for_reason(lifecycle_events, 'sandbox_pause', timeout_ms=60000)

                await evolve.resume()
                resumed = await evolve.status()
                assert_true(resumed.sandbox == 'ready', 'Sandbox state is ready after resume()')
                await wait_for_reason(lifecycle_events, 'sandbox_resume', timeout_ms=60000)
            else:
                log_info('Skipping pause/resume lifecycle checks for provider without pause support')

            # 11) withSession reconnect + sandbox_connected
            events2: list[dict] = []
            evolve2 = Evolve(
                config=agent_config,
                sandbox=create_sandbox_provider(provider),
                workspace_mode='knowledge',
                sandbox_id=session_id,
            )
            evolve2.on('lifecycle', lambda event: events2.append(event))

            reconnect_run = await evolve2.run(
                prompt='Append Turn 2 to output/session-test.txt.',
                timeout_ms=180000,
            )
            assert_true(reconnect_run.exit_code == 0, 'Reconnected run succeeds')
            await wait_for_reason(events2, 'sandbox_connected', timeout_ms=120000)

            # 12) set_session switch to another live sandbox
            evolve3 = Evolve(
                config=agent_config,
                sandbox=create_sandbox_provider(provider),
                workspace_mode='knowledge',
            )
            alt_run = await evolve3.run(
                prompt='Create output/alt-session.txt with text alt.',
                timeout_ms=180000,
            )
            assert_true(alt_run.exit_code == 0, 'Alternate session run succeeds')
            alt_session_id = await evolve3.get_session()
            assert_true(alt_session_id is not None and alt_session_id != session_id, 'Alternate session id exists and differs')

            await evolve2.set_session(cast(str, alt_session_id))
            switched = await evolve2.status()
            assert_true(switched.sandbox_id == alt_session_id, 'set_session switches sandbox id')
            switch_run = await evolve2.run(
                prompt='Append switched-session to output/alt-session.txt.',
                timeout_ms=180000,
            )
            assert_true(switch_run.exit_code == 0, 'Run after set_session switch succeeds')

            # 13) kill lifecycle reason
            await evolve2.kill()
            assert_true(
                'sandbox_killed' in lifecycle_reasons(events2),
                'Lifecycle includes sandbox_killed on kill()',
            )

            # Provider test complete; cleanup remaining instances in finally.
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise
        finally:
            if evolve2 is not None:
                try:
                    await evolve2.kill()
                except Exception:
                    pass
            if evolve3 is not None:
                try:
                    await evolve3.kill()
                except Exception:
                    pass
            try:
                await evolve.kill()
            except Exception:
                pass


async def run_all_tests():
    """Run all session management tests"""
    print('\n🚀 Starting Session Management Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}')
    print(f'🧱 Providers: {", ".join(TEST_PROVIDERS)}\n')

    try:
        await test_get_session()
        await test_set_session()
        await test_pause_resume()
        await test_kill()
        await test_multiple_session_switching()
        await test_status_and_interrupt()
        await test_runtime_lifecycle_parity()

        print('\n' + '=' * 70)
        print(f'✅ All session management tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
