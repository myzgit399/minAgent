from __future__ import annotations

from hermes_cli import gateway_host_lifecycle as ghl


def test_registry_tracks_and_releases_live_host(tmp_path):
    ghl.register_host(ghl.CLI, home=tmp_path)

    assert ghl.has_live_hosts(home=tmp_path)
    assert ghl.unregister_host(ghl.CLI, home=tmp_path)
    assert not ghl.has_live_hosts(home=tmp_path)


def test_end_host_stops_when_no_host_remains(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ghl, "stop_gateway_and_wait", lambda **kw: calls.append(kw) or True)
    ghl.register_host(ghl.CLI, home=tmp_path)

    assert ghl.end_host(ghl.CLI, home=tmp_path)
    assert len(calls) == 1


def test_end_host_keeps_gateway_for_another_live_host(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ghl, "stop_gateway_and_wait", lambda **kw: calls.append(kw) or True)
    monkeypatch.setattr(ghl, "_pid_alive", lambda pid, start_time=None: True)
    ghl.register_host(ghl.CLI, home=tmp_path)
    ghl.register_host(ghl.GUI, pid=999_999_999, start_time=1.0, home=tmp_path)

    assert ghl.end_host(ghl.CLI, home=tmp_path)
    assert not calls
