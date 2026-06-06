#!/usr/bin/env python3
"""
화상회의 미디어 수신 서버 — webtop 컨테이너 내부에서 실행됨.

  WS /camera-ws : 브라우저와 SDP/ICE 시그널링 (auth-proxy가 /camera-ws로 프록시; 단계 3)

수신한 WebRTC 트랙을 디코딩해 가상 장치로 전달한다:
  video → ffmpeg → /dev/video10 (v4l2loopback)   ※ 장치 없으면 graceful skip
  audio → pacat  → PulseAudio virtmic_sink         ※ 항상 동작

설계: audio는 어디서나 동작(컨테이너 내 PulseAudio), video는 호스트 v4l2loopback이
있을 때만. 가상 웹캠이 없으면 영상 트랙을 버리고 마이크만 처리한다.
"""

import asyncio
import json
import logging
import os
import subprocess

import numpy as np
from aiohttp import web
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.mediastreams import MediaStreamError

VIDEO_DEVICE = os.environ.get("CAMERA_V4L2_DEVICE", "/dev/video10")
PULSE_SINK = os.environ.get("CAMERA_PULSE_SINK", "virtmic_sink")
PULSE_USER = os.environ.get("CAMERA_PULSE_USER", "abc")
STUN_URL = os.environ.get("STUN_URL", "stun:stun.l.google.com:19302")
PORT = int(os.environ.get("CAMERA_PORT", "8888"))

AUDIO_RATE = 48000
AUDIO_CHANNELS = 2
VIDEO_FPS = 30
# v4l2loopback 출력 고정 해상도. 들어오는 영상 해상도가 대역폭에 따라 변해도
# 항상 이 크기로 스케일해 장치 포맷을 고정한다(안 그러면 Chromium이 카메라를 못 잡음).
OUT_W = int(os.environ.get("CAMERA_WIDTH", "1280"))
OUT_H = int(os.environ.get("CAMERA_HEIGHT", "720"))

# 클라우드(EC2 등)에서 컨테이너는 사설 IP에 바인딩되므로, aiortc가 gather한
# host 후보의 사설 IP를 브라우저가 닿을 수 있는 공인 IP로 바꿔준다.
# EC2는 1:1 NAT로 포트를 보존하므로 IP만 교체하면 publicIP:port가 그대로 도달한다.
PUBLIC_IP = os.environ.get("PUBLIC_IP", "").strip()

logger = logging.getLogger("camera-server")
pcs = set()


async def _drain(track):
    """트랙을 계속 비워 버퍼 적체를 막는다 (장치가 없어 소비하지 않을 때)."""
    while True:
        try:
            await track.recv()
        except Exception:
            return


def rewrite_sdp_public_ip(sdp):
    if not PUBLIC_IP:
        return sdp
    out = []
    rewrote = False
    for line in sdp.splitlines():
        if line.startswith("a=candidate:") and " typ host " in line:
            parts = line.split()
            ip = parts[4]
            if "." in ip and not ip.startswith("127.") and ip != PUBLIC_IP:
                parts[4] = PUBLIC_IP
                line = " ".join(parts)
                rewrote = True
        out.append(line)
    if rewrote:
        logger.info("ICE host 후보를 공인 IP %s로 재작성", PUBLIC_IP)
    return "\r\n".join(out) + "\r\n"


# ---------------------------------------------------------------------------
# 영상: aiortc 프레임(rgb24) → ffmpeg stdin → v4l2loopback
# ---------------------------------------------------------------------------

class V4L2Writer:
    """ffmpeg를 띄워 raw rgb24 프레임을 v4l2loopback 장치에 yuv420p로 기록."""

    def __init__(self, device, width, height, fps=VIDEO_FPS):
        self.device = device
        self.size = (width, height)
        cmd = [
            "ffmpeg", "-loglevel", "warning",
            "-f", "rawvideo", "-pixel_format", "rgb24",
            "-video_size", f"{width}x{height}", "-framerate", str(fps),
            "-i", "pipe:0",
            "-pix_fmt", "yuv420p", "-f", "v4l2", device,
        ]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        logger.info("ffmpeg v4l2 writer 시작 %dx%d → %s", width, height, device)

    def write(self, rgb_bytes):
        self.proc.stdin.write(rgb_bytes)

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.terminate()
        except Exception:
            pass


# 활성 통화의 최신 프레임(rgb24 bytes). None이면 video_pump가 검은 화면을 내보낸다.
_latest = {"data": None}
_BLACK = np.zeros((OUT_H, OUT_W, 3), dtype=np.uint8).tobytes()


async def video_pump():
    """부팅~종료까지 항상 /dev/video10에 프레임을 쓴다(상시 가상 카메라).

    통화 중이면 최신 영상, 아니면 검은 화면. 장치가 늘 캡처 가능 상태로 존재해
    Chromium을 언제 켜도 카메라가 보인다. ffmpeg가 죽으면 재기동한다.
    """
    loop = asyncio.get_event_loop()
    period = 1.0 / VIDEO_FPS
    writer = V4L2Writer(VIDEO_DEVICE, OUT_W, OUT_H)
    logger.info("video_pump 시작 — /dev/video10 상시 출력 (%dx%d)", OUT_W, OUT_H)
    n = 0
    try:
        while True:
            data = _latest["data"]
            try:
                await loop.run_in_executor(None, writer.write, data if data is not None else _BLACK)
            except Exception:
                logger.exception("video_pump write 실패 — ffmpeg 재기동")
                writer.close()
                await asyncio.sleep(1)
                writer = V4L2Writer(VIDEO_DEVICE, OUT_W, OUT_H)
            n += 1
            if n % 300 == 0:
                logger.info("video_pump 동작 중 (live=%s)", data is not None)
            await asyncio.sleep(period)
    finally:
        writer.close()


async def consume_video(track):
    """들어온 영상 트랙을 디코딩/스케일해 최신 프레임 슬롯에 저장(장치 쓰기는 video_pump 담당)."""
    if not os.path.exists(VIDEO_DEVICE):
        logger.warning("가상 웹캠 %s 없음 — 영상 트랙 무시(마이크만 동작).", VIDEO_DEVICE)
        await _drain(track)
        return

    count = 0
    try:
        while True:
            # 항상 recv()해 트랙 큐를 비운다(메모리 leak 방지). 최신 프레임만 슬롯에 보관.
            frame = await track.recv()
            try:
                img = frame.reformat(width=OUT_W, height=OUT_H, format="rgb24").to_ndarray()
                _latest["data"] = img.tobytes()
                count += 1
                if count == 1 or count % 150 == 0:
                    logger.info("통화 영상 프레임 #%d → 가상 카메라 (%dx%d)", count, OUT_W, OUT_H)
            except Exception:
                logger.exception("영상 디코드 실패:")
    except MediaStreamError:
        logger.info("영상 트랙 종료 (%d 프레임) — 검은 화면으로 전환", count)
    finally:
        _latest["data"] = None   # 통화 종료 → 검은 화면


# ---------------------------------------------------------------------------
# 음성: aiortc 프레임 → s16le 리샘플 → pacat stdin → PulseAudio virtmic_sink
# ---------------------------------------------------------------------------

def _spawn_pacat():
    runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.environ.get('PUID', '1000')}")
    # PulseAudio 소켓 경로: PULSE_SERVER > PULSE_RUNTIME_PATH/native > XDG_RUNTIME_DIR/pulse/native
    pulse_server = os.environ.get("PULSE_SERVER")
    if not pulse_server:
        pulse_path = os.environ.get("PULSE_RUNTIME_PATH", f"{runtime}/pulse")
        pulse_server = f"unix:{pulse_path}/native"
    # PulseAudio는 데스크톱 사용자(abc) 세션에서 구동되므로 그 컨텍스트로 pacat 실행.
    cmd = [
        "s6-setuidgid", PULSE_USER,
        "env", "HOME=/config", f"XDG_RUNTIME_DIR={runtime}", f"PULSE_SERVER={pulse_server}",
        "pacat", "--playback", f"--device={PULSE_SINK}",
        "--format=s16le", f"--rate={AUDIO_RATE}", f"--channels={AUDIO_CHANNELS}",
        "--raw", "--client-name=rbi-camera",
    ]
    logger.info("pacat 실행: PULSE_SERVER=%s sink=%s", pulse_server, PULSE_SINK)
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


async def consume_audio(track):
    from av.audio.resampler import AudioResampler

    loop = asyncio.get_event_loop()
    resampler = AudioResampler(format="s16", layout="stereo", rate=AUDIO_RATE)
    proc = _spawn_pacat()
    logger.info("pacat 시작 → PulseAudio sink '%s'", PULSE_SINK)

    count = 0
    try:
        while True:
            try:
                frame = await track.recv()
            except Exception:
                logger.info("음성 트랙 종료 (%d 프레임)", count)
                return
            # 디버그: 들어오는(WebRTC) 오디오 진폭/포맷 — 무음이 어디서 생기는지 확인
            if count % 100 == 0:
                try:
                    arr = frame.to_ndarray()
                    peak = int(np.abs(arr).max()) if arr.size else 0
                    logger.info(
                        "수신 오디오 frame #%d peak=%d fmt=%s rate=%s ch=%s samples=%s",
                        count, peak, frame.format.name, frame.sample_rate,
                        len(frame.layout.channels), frame.samples,
                    )
                except Exception:
                    logger.exception("audio peak 측정 실패")

            resampled = resampler.resample(frame)
            if not isinstance(resampled, list):
                resampled = [resampled]
            for rs in resampled:
                # planes[0]는 정렬 패딩이 섞일 수 있어 to_ndarray로 정확히 변환
                data = rs.to_ndarray().tobytes()
                try:
                    await loop.run_in_executor(None, proc.stdin.write, data)
                except Exception as e:
                    logger.error("pacat write 실패: %s", e)
                    return
            count += 1
            if count == 1 or count % 200 == 0:
                logger.info("음성 프레임 #%d → %s", count, PULSE_SINK)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.terminate()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 시그널링
# ---------------------------------------------------------------------------

async def camera_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    # 새 연결이 오면 기존 피어를 모두 닫는다 (단일 사용자 가정).
    # 재연결이 반복될 때 옛 PC/ffmpeg/pacat가 쌓여 메모리가 새는 것을 막는다.
    for old in list(pcs):
        logger.info("기존 피어 정리 (재연결)")
        await old.close()
        pcs.discard(old)

    config = RTCConfiguration(iceServers=[RTCIceServer(urls=[STUN_URL])])
    pc = RTCPeerConnection(configuration=config)
    pcs.add(pc)
    logger.info("새 피어 연결 (활성 %d)", len(pcs))

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info("connectionState = %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    @pc.on("track")
    def on_track(track):
        logger.info("track 수신: kind=%s", track.kind)
        # 트랙당 소비자가 하나뿐이므로 MediaRelay 없이 직접 소비한다.
        # (relay를 쓰면 소비가 지연/중단될 때 프레임이 무한 버퍼링되어 메모리가 샌다.)
        if track.kind == "video":
            asyncio.ensure_future(consume_video(track))
        else:
            asyncio.ensure_future(consume_audio(track))

    async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            data = json.loads(msg.data)
            if data.get("type") == "offer":
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=data["sdp"], type="offer")
                )
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)  # aiortc: ICE gathering 완료까지 포함
                sdp = rewrite_sdp_public_ip(pc.localDescription.sdp)
                await ws.send_str(json.dumps({"type": "answer", "sdp": sdp}))
                logger.info("answer 전송 완료")
        elif msg.type == web.WSMsgType.ERROR:
            logger.warning("WS 오류: %s", ws.exception())

    logger.info("WS 종료 — 피어 정리")
    await pc.close()
    pcs.discard(pc)
    return ws


async def on_startup(app):
    # 장치가 있으면 상시 가상 카메라 펌프를 띄운다(통화 없을 땐 검은 화면).
    if os.path.exists(VIDEO_DEVICE):
        app["video_pump"] = asyncio.ensure_future(video_pump())
    else:
        logger.warning("가상 웹캠 %s 없음 — video_pump 미시작(마이크만 동작).", VIDEO_DEVICE)


async def on_shutdown(_app):
    task = _app.get("video_pump")
    if task:
        task.cancel()
    await asyncio.gather(*[pc.close() for pc in pcs], return_exceptions=True)
    pcs.clear()


def main():
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    logger.info(
        "camera-server 시작: port=%d video=%s sink=%s stun=%s",
        PORT, VIDEO_DEVICE, PULSE_SINK, STUN_URL,
    )
    app = web.Application()
    app.router.add_get("/camera-ws", camera_ws)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
