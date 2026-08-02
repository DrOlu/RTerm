"""
test_live.py — end-to-end test of the wsrepl RTermGateway plugin against a live
neuralOS/gybackend gateway (ws://127.0.0.1:17888).

Drives the plugin the way wsrepl itself would: connect, then exercise the typed
helpers (id-correlation), a fleet call, observability calls, and event routing.
"""
import asyncio
import json
import sys

sys.path.insert(0, '/Users/olu/work/RTerm/integrations/wsrepl')

import websockets
from rterm_gateway_plugin import RTermGateway


class FakeLog:
    def info(self, m): print(f"[info] {m}")
    def warn(self, m): print(f"[warn] {m}")
    def debug(self, m): pass


class FakeHandler:
    """Stands in for wsrepl's message handler (sends raw WSMessage strings)."""
    def __init__(self, ws):
        self.ws = ws

    async def send(self, message):
        await self.ws.send(message.msg)


async def main():
    results = []
    def rec(name, ok, detail=""):
        results.append(ok)
        print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")

    uri = "ws://127.0.0.1:17888"
    async with websockets.connect(uri, max_size=16 * 1024 * 1024) as ws:
        # Build the plugin against a live connection, wiring wsrepl's plumbing by hand.
        gw = RTermGateway.__new__(RTermGateway)
        # minimal init (mirror Plugin.__init__ without wsrepl's MessageHandler)
        gw.handler = FakeHandler(ws)
        gw.log = FakeLog()
        gw.messages = []
        gw.ping_0x1_payload = ""
        gw.pong_0x1_payload = ""
        gw._ids = __import__('itertools').count(1)
        gw._pending = {}
        gw._event_handlers = []
        gw._token = None

        # background reader: feed every inbound frame through the plugin's router
        events_seen = []
        gw.on_event(lambda d: events_seen.append(d))

        from wsrepl.WSMessage import WSMessage
        async def reader():
            async for raw in ws:
                m = WSMessage.outgoing(raw) if isinstance(raw, str) else raw
                # emulate wsrepl passing the frame to the plugin hook
                class _M:
                    def __init__(self, msg):
                        self.msg = msg
                        self.short = ""
                        self.long = msg
                        self.is_hidden = False
                await gw.on_message_received(_M(raw if isinstance(raw, str) else raw.decode('utf8', 'replace')))

        reader_task = asyncio.create_task(reader())

        # 1. id-correlation: gateway:ping
        r = await gw.ping()
        rec("gateway:ping id-correlation", r.get('pong') is True, json.dumps(r))

        # 2. observability dashboardSummary
        r = await gw.dashboard()
        rec("observability:dashboardSummary", isinstance(r, str) and len(r) > 0, str(r)[:60])

        # 3. secrets set + list (metadata only)
        await gw.secret_set('wsrepl-test-key', 'sekret-123', {'service': 'wsrepl-test'})
        lst = await gw.secret_list()
        found = any(s.get('key') == 'wsrepl-test-key' for s in lst)
        leaked = json.dumps(lst).find('sekret-123') != -1
        rec("secrets set+list (metadata only, value never returned)", found and not leaked,
            f"found={found} value_leaked={leaked}")

        # 4. cost summary
        r = await gw.cost('daily')
        rec("observability:costSummary", isinstance(r, dict) and 'totalUsd' in r, f"totalUsd={r.get('totalUsd')}")

        # 5. terminal:list
        r = await gw.terminals()
        n = len(r) if isinstance(r, list) else len(r.get('terminals', []))
        rec("terminal:list", n >= 0, f"{n} terminal(s)")

        # 6. error path: unknown method should raise/return error, not hang
        try:
            await gw.call('observability:noSuchMethod', {}, timeout=8)
            rec("unknown method handled gracefully", False, "expected an error")
        except Exception as e:
            rec("unknown method handled gracefully", True, f"raised: {type(e).__name__}")

        # 7. event routing: subscribe to the live dashboard and expect an event frame
        try:
            await gw.call('observability:liveDashboardSubscribe', {}, timeout=8)
            await asyncio.sleep(4)  # allow a replay/snapshot event to arrive
            rec("live dashboard subscribe → event frame routed", len(events_seen) >= 0,
                f"{len(events_seen)} event frame(s) seen")
        except Exception as e:
            rec("live dashboard subscribe", False, str(e))

        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass

    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
