"""
rterm_gateway_plugin.py — a wsrepl plugin for driving the RTerm / neuralOS
WebSocket JSON-RPC gateway (ws://host:17888).

Layer-2 integration: speaks the gateway's envelope natively.
  • Request/response id-correlation (async + multiplexed): every `call()` gets a
    unique id; the matching `gateway:response` resolves it.
  • Typed helpers: rterm.call / fleet / obs / record / page / secret / cost / etc.
  • Event routing: `gateway:event`, `gateway:raw`, `gateway:ui-update` frames are
    routed to a handler instead of being mistaken for replies.
  • Auth: supply the gateway token for non-localhost (localhost skips auth).

Usage (inside wsrepl):
    >>> from rterm_gateway_plugin import RTermGateway
    >>> gw = RTermGateway()                     # auto-loaded as the plugin
    >>> await gw.call('gateway:ping')
    {'pong': True, 'ts': 1784...}
    >>> await gw.obs('costSummary', {'period': 'daily'})
    >>> await gw.fleet(['prod-linux'], 'openssl version')
    >>> await gw.record('local-main')           # start a session recording

Drop this file into your wsrepl plugins directory (or `pip install -e .` and
select it with wsrepl's plugin loader). The plugin registers itself as `RTerm`.
"""

from __future__ import annotations

import asyncio
import json
import itertools
from typing import Any, Callable, Dict, Optional

from wsrepl import Plugin
from wsrepl.WSMessage import WSMessage


class RTermGateway(Plugin):
    """wsrepl Plugin that speaks the RTerm gateway JSON-RPC envelope."""

    # ── wsrepl lifecycle ──────────────────────────────────────────────────────
    def init(self) -> None:
        # id-counter for outgoing RPC ids
        self._ids = itertools.count(1)
        # pending id -> asyncio.Future resolving to the result (or raising on error)
        self._pending: Dict[str, asyncio.Future] = {}
        # optional event handler(s): set with on_event(fn)
        self._event_handlers: list[Callable[[Dict[str, Any]], None]] = []
        # gateway access token (non-localhost). Set via set_token() / config.
        self._token: Optional[str] = None
        self.log.info("[rterm] gateway plugin loaded — ready to drive ws://host:17888")

    async def on_connect(self) -> None:
        # If a token is configured and the gateway requires it (non-localhost),
        # send it as the first frame (the gateway's auth handshake).
        if self._token:
            self.log.info("[rterm] sending auth token")
            await self.send_str(json.dumps({"type": "auth", "token": self._token}))

    # ── public config API ─────────────────────────────────────────────────────
    def set_token(self, token: str) -> None:
        """Set the gateway access token (needed for non-localhost connections)."""
        self._token = token

    def on_event(self, fn: Callable[[Dict[str, Any]], None]) -> None:
        """Register a handler for gateway:event frames (dashboard pushes, monitor
        snapshots, task progress, etc.)."""
        self._event_handlers.append(fn)

    # ── core RPC: id-correlation ──────────────────────────────────────────────
    async def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 60.0) -> Any:
        """Call a gateway RPC method and await its correlated result.

        Raises on gateway error (ok:false) or timeout.
        """
        rid = f"wsrepl-{next(self._ids)}"
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        payload = {"id": rid, "method": method, "params": params or {}}
        await self.send_str(json.dumps(payload))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    # ── typed helpers (thin, discoverable wrappers over the gateway surface) ──
    async def ping(self) -> Any:
        return await self.call('gateway:ping')

    async def fleet(self, targets: list[str], command: str, timeout: float = 120.0) -> Any:
        """Run a command across a fleet (group/tags/explicit hosts)."""
        return await self.call('run_fleet_command', {'targets': targets, 'command': command}, timeout)

    async def facts(self, targets: Optional[list[str]] = None) -> Any:
        return await self.call('collect_facts', {'targets': targets or []})

    async def exec(self, terminal_id: str, command: str, timeout: float = 120.0) -> Any:
        """Run a command on a single terminal tab."""
        return await self.call('exec_command', {'tabIdOrName': terminal_id, 'command': command}, timeout)

    async def terminals(self) -> Any:
        return await self.call('terminal:list')

    async def obs(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 60.0) -> Any:
        """Call any observability:* method, e.g. obs('costSummary', {'period':'daily'})."""
        return await self.call(f'observability:{method}', params or {}, timeout)

    async def dashboard(self) -> Any:
        return await self.obs('dashboardSummary')

    async def secret_set(self, key: str, value: str, labels: Optional[Dict[str, str]] = None) -> Any:
        return await self.obs('secretsSet', {'key': key, 'value': value, 'labels': labels or {}})

    async def secret_list(self) -> Any:
        return await self.obs('secretsList')

    async def cost(self, period: str = 'daily') -> Any:
        return await self.obs('costSummary', {'period': period})

    async def record(self, terminal_id: str, title: Optional[str] = None) -> Any:
        """Start an asciinema session recording on a terminal."""
        return await self.obs('recordingStart', {'terminalId': terminal_id, 'title': title})

    async def stop_record(self, terminal_id: str) -> Any:
        return await self.obs('recordingStopTerminal', {'terminalId': terminal_id})

    async def page(self, incident_id: str, policy_id: str, title: str, severity: str) -> Any:
        return await self.obs('oncallPage', {
            'incidentId': incident_id, 'policyId': policy_id, 'title': title, 'severity': severity,
        })

    async def ingest_spans(self, otlp_payload: Dict[str, Any]) -> Any:
        return await self.obs('apmIngestSpans', {'payload': otlp_payload})

    async def ingest_beacon(self, beacon: Dict[str, Any]) -> Any:
        return await self.obs('demIngestBeacon', {'payload': beacon})

    # ── event routing (wsrepl message hook) ───────────────────────────────────
    async def on_message_received(self, message: WSMessage) -> None:
        """Route incoming frames: gateway:response -> resolve pending id;
        gateway:event/raw/ui-update -> event handlers."""
        try:
            data = json.loads(message.msg)
        except (ValueError, TypeError):
            return  # not JSON — leave as-is in history

        mtype = data.get('type')
        # Correlated response: resolve the pending future by id.
        if mtype == 'gateway:response' and 'id' in data:
            rid = data['id']
            fut = self._pending.get(rid)
            if fut is not None and not fut.done():
                if data.get('ok'):
                    fut.set_result(data.get('result'))
                else:
                    err = data.get('error') or {}
                    fut.set_exception(RuntimeError(err.get('message', 'gateway error')))
            # Annotate history entry for readability.
            message.short = f"⬅ {data.get('ok', '?')} {rid}"
            return

        # Event frames: dashboard pushes, monitor snapshots, raw terminal output.
        if mtype in ('gateway:event', 'gateway:raw', 'gateway:ui-update'):
            for fn in self._event_handlers:
                try:
                    fn(data)
                except Exception as e:  # never let a handler break the loop
                    self.log.warn(f"[rterm] event handler error: {e}")
            message.short = f"◆ {mtype}:{data.get('event', '')}"


# wsrepl auto-discovers the Plugin subclass. Alias for clarity in the loader.
Plugin_ = RTermGateway
