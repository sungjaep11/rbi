#!/usr/bin/env python3
"""
인쇄 리다이렉트 서버 — webtop 컨테이너 내부에서 실행됨.
  GET  /ws     : 브라우저 클라이언트가 여기로 연결 (auth-proxy를 통해 프록시됨)
  POST /print  : CUPS print-forwarder 스크립트가 PDF를 여기로 전송
"""

from aiohttp import web

clients: set = set()


async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    try:
        async for _ in ws:
            pass  # 브라우저는 데이터를 보내지 않음; 서버에서 푸시만 함
    finally:
        clients.discard(ws)
    return ws


async def print_handler(request):
    data = await request.read()
    if not data:
        return web.Response(status=400, text="empty body")

    dead = set()
    for ws in list(clients):
        try:
            await ws.send_bytes(data)
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)

    print(f"[print] forwarded {len(data)} bytes to {len(clients)} client(s)", flush=True)
    return web.Response(text="ok")


app = web.Application()
app.router.add_get("/ws", ws_handler)
app.router.add_post("/print", print_handler)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=7777)
