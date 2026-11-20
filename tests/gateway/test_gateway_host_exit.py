"""A gateway started for a host (Desktop, a CLI/TUI) ends when that host exits.

The orderly stop is ``gateway host-release``; these cover the way that handoff never runs — a crash,
a force-quit — where the daemon has to notice the host itself. Real asyncio, no gateway process: the
runner is a stand-in exposing only what the watcher reads, as in test_unmanaged_idle_exit.py, and
each async case builds its runner inside its own loop, so the module needs no async plugin.
"""
from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest

from gateway import run_idle_exit
from hermes_cli.gateway_runtime_start import HOST_PID_ENV


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch):
    monkeypatch.setattr(run_idle_exit, "_HOST_POLL_SECONDS", 0.01)


def _runner():
    """A runner with just what the watcher reads; ``stop`` records the call and clears ``_running``."""
    stops = []
    tasks: list[asyncio.Task] = []

    async def stop():
        stops.append(True)
        runner._running = False

    def spawn_supervised(coro_factory, name):
        tasks.append(asyncio.ensure_future(coro_factory()))
        return tasks[-1]

    runner = SimpleNamespace(
        _running=True, _draining=False, _exit_reason=None,
        session_runtime_descriptor={"state": "ready", "capabilities": ["session-authority-v1"]},
        stop=stop, _spawn_supervised=spawn_supervised)
    return runner, tasks, stops


def test_a_dead_host_makes_the_gateway_drain_first_and_stop(monkeypatch):
    monkeypatch.setattr(run_idle_exit, "_host_alive", lambda pid: False)

    async def scenario():
        runner, tasks, stops = _runner()
        armed = run_idle_exit.arm_host_exit(runner, 424242)
        await asyncio.wait_for(asyncio.gather(*tasks), 10)  # the watcher returns once it has acted
        await asyncio.wait_for(runner._idle_exit_stop_task, 10)
        return armed, runner, stops

    armed, runner, stops = asyncio.run(scenario())

    assert armed is True
    assert stops == [True]
    # Published before stop(), so a client racing the exit reads "leaving by itself" (and starts a
    # fresh gateway) instead of a refusal.
    assert runner.session_runtime_descriptor["state"] == "draining"
    assert runner.session_runtime_descriptor["drain_reason"] == run_idle_exit.HOST_EXIT_REASON
    assert runner.session_runtime_descriptor["capabilities"] == []
    assert runner._exit_reason.startswith(run_idle_exit.HOST_EXIT_STOP_PREFIX)


def test_a_live_host_keeps_it_running(monkeypatch):
    monkeypatch.setattr(run_idle_exit, "_host_alive", lambda pid: True)

    async def scenario():
        runner, tasks, stops = _runner()
        run_idle_exit.arm_host_exit(runner, 424242)
        await asyncio.sleep(0.05)
        watching = not tasks[0].done()
        tasks[0].cancel()  # a shutdown cancels it; nothing else may run
        await asyncio.gather(*tasks, return_exceptions=True)
        return watching, runner, stops

    watching, runner, stops = asyncio.run(scenario())

    assert watching is True
    assert stops == []
    assert runner.session_runtime_descriptor["state"] == "ready"


def test_a_host_that_already_exited_drains_at_once_instead_of_watching(monkeypatch):
    monkeypatch.setattr(run_idle_exit, "_host_alive", lambda pid: False)

    async def scenario():
        runner, tasks, _stops = _runner()
        armed = run_idle_exit.arm_host_exit(runner, 424242)
        await asyncio.wait_for(runner._idle_exit_stop_task, 10)
        return armed, runner, tasks

    armed, runner, tasks = asyncio.run(scenario())

    assert armed is True
    assert tasks == []  # nothing to watch: acted on the spot
    assert runner.session_runtime_descriptor["drain_reason"] == run_idle_exit.HOST_EXIT_REASON


def test_its_own_pid_and_an_absent_host_arm_nothing(monkeypatch):
    monkeypatch.setattr(run_idle_exit, "_host_alive", lambda pid: True)

    async def scenario():
        runner, tasks, _stops = _runner()
        return (run_idle_exit.arm_host_exit(runner, os.getpid()),
                run_idle_exit.arm_host_exit(runner, None), tasks)

    own_pid, absent, tasks = asyncio.run(scenario())

    assert own_pid is False and absent is False
    assert tasks == []


def test_the_requested_host_is_read_from_the_launch_environment(monkeypatch):
    monkeypatch.setenv(HOST_PID_ENV, "gui:4321")
    assert run_idle_exit.requested_host_pid() == 4321
    monkeypatch.setenv(HOST_PID_ENV, "")
    assert run_idle_exit.requested_host_pid() is None
    monkeypatch.setenv(HOST_PID_ENV, "gui:not-a-pid")
    assert run_idle_exit.requested_host_pid() is None
