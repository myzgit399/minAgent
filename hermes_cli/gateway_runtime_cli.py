"""Machine-readable ensure/attach boundary. Only ``attach`` prints a credential: its one ticket."""
from dataclasses import asdict
import json
import math
import sys
from contextlib import redirect_stdout

INVALID_INVOCATION = {"state": "inaccessible", "reason_code": "invalid_invocation", "endpoint": None}


def ensure_exit_code(result) -> int:
    if result.reason_code == "deadline":
        return 5
    if result.reason_code in {"authorization", "profile_mismatch", "gateway_elevated", "gateway_other_session"}:
        return 4
    return {"ready": 0, "incompatible": 3, "draining": 6,
            "inaccessible": 7, "conflict": 7, "starting": 5, "absent": 5}[result.state]


def _verdict_payload(result) -> dict:
    payload = asdict(result)
    if result.endpoint:
        payload["endpoint"]["capabilities"] = sorted(result.endpoint.capabilities)
    # The code THIS client (and any gateway it starts) runs, resolved exactly like the owner's
    # ``endpoint.code_sha``: a client that sees them differ is attached to a gateway that
    # outlived ``hermes update`` and must restart it rather than re-attach.
    from hermes_cli.version_info import get_code_identity
    payload["client_code_sha"] = get_code_identity().get("sha")
    return payload


def _emit(payload, code) -> None:
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    raise SystemExit(code)


def requested_host(args) -> str | None:
    """``<kind>:<pid>`` for the CLI/GUI that asked, or None when this short-lived ensure CLI is alone."""
    host_pid = getattr(args, "host_pid", None)
    host_kind = getattr(args, "host_kind", "")
    if not host_pid or not host_kind:
        return None
    return f"{host_kind}:{int(host_pid)}"


def _register_requested_host(args) -> None:
    """CLI/GUI passes its own PID; the short-lived ensure CLI is never a host."""
    host = requested_host(args)
    if host is None:
        return
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_host_lifecycle import register_host

    host_kind, _, host_pid = host.partition(":")
    register_host(host_kind, pid=int(host_pid), home=get_hermes_home())


def cmd_gateway_host_release(args) -> None:
    """Last host's shutdown handoff: release, stop gateway, wait, then reply."""
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_host_lifecycle import end_host

    try:
        with redirect_stdout(sys.stderr):
            stopped = end_host(
                args.host_kind, pid=int(args.host_pid),
                home=get_hermes_home(), timeout=float(getattr(args, "timeout", "30")),
            )
        payload, code = {"ok": True, "gateway_stopped": stopped}, 0
    except (ValueError, TypeError):
        payload, code = INVALID_INVOCATION, 2
    _emit(payload, code)


def cmd_gateway_ensure(args) -> None:
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_runtime import ensure_gateway_runtime

    try:
        _register_requested_host(args)
        # Legacy imported utilities can print; protocol stdout belongs only to us.
        with redirect_stdout(sys.stderr):
            result = ensure_gateway_runtime(get_hermes_home(), timeout=float(args.timeout),
                                            host=requested_host(args))
        payload, code = _verdict_payload(result), ensure_exit_code(result)
    except (ValueError, TypeError):
        payload, code = INVALID_INVOCATION, 2
    _emit(payload, code)


def cmd_gateway_attach(args) -> None:
    """``ensure``'s verdict plus, once attachable, the owner's WebSocket ``url``, its ``protocol``,
    the dial ``protocols`` and one single-use ``ticket`` for this profile. A refusal adds the
    ``message`` Ink's bootstrap shows (``gateway <state>: <reason>`` lines) and exits like ensure.
    Every reply carries ``start_context.windows_service_session``."""
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_client import GATEWAY_WS_PROTOCOL, gateway_ws_target
    from hermes_cli.gateway_runtime import GatewayDiscovery
    from hermes_cli.gateway_runtime_attach import (SERVICE_SESSION_START_WARNING, GatewayAttach, TicketUnavailable,
                                                   attach_gateway, failure_message, scrub_client_launch_env,
                                                   windows_service_session)

    # Where a gateway THIS call starts would run, so a remote client can decide not to ask for one.
    service_session = windows_service_session()
    start_context = {"start_context": {"windows_service_session": service_session}}
    try:
        timeout = float(args.timeout)
    except ValueError:
        timeout = math.nan
    if not math.isfinite(timeout) or timeout <= 0:
        _emit({**INVALID_INVOCATION, **start_context}, 2)
    if args.start and service_session:
        print(SERVICE_SESSION_START_WARNING, file=sys.stderr)
    scrub_client_launch_env()
    _register_requested_host(args)
    with redirect_stdout(sys.stderr):
        try:
            attached = attach_gateway(get_hermes_home(), start=args.start, recover=args.recover, timeout=timeout)
        except TicketUnavailable as exc:
            # Attachable at discovery, then no ticket (the owner went away or refused the grant).
            attached = GatewayAttach(GatewayDiscovery("inaccessible", reason_code="ticket_unavailable",
                                                      detail=exc.detail or exc.reason))
        payload = {**_verdict_payload(attached.receipt), **start_context}
    if attached.ticket is None:
        message = failure_message(attached.receipt)
        print(message, file=sys.stderr)
        _emit({**payload, "message": message}, ensure_exit_code(attached.receipt))
    url, protocols = gateway_ws_target(attached.receipt.endpoint, attached.ticket)
    _emit({**payload, "url": url, "protocol": GATEWAY_WS_PROTOCOL, "protocols": protocols,
           "ticket": attached.ticket}, 0)
