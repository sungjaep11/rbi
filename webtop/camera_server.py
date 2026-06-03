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

from aiohttp import web
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.contrib.media import MediaRelay

VIDEO_DEVICE = os.environ.get("CAMERA_V4L2_DEVICE", "/dev/video10")
PULSE_SINK = os.environ.get("CAMERA_PULSE_SINK", "virtmic_sink")
PULSE_USER = os.environ.get("CAMERA_PULSE_USER", "abc")
STUN_URL = os.environ.get("STUN_URL", "stun:stun.l.google.com:19302")
PORT = int(os.environ.get("CAMERA_PORT", "8888"))

AUDIO_RATE = 48000
AUDIO_CHANNELS = 2
VIDEO_FPS = 30

logger = logging.getLogger("camera-server")
relay = MediaRelay()
pcs = set()


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


async def consume_video(track):
    loop = asyncio.get_event_loop()

    if not os.path.exists(VIDEO_DEVICE):
        logger.warning(
            "가상 웹캠 %s 없음 — 영상 트랙 무시 (마이크만 동작). "
            "Linux 호스트에서 v4l2loopback 로드 후 docker-compose.camera.yml로 실행해야 영상이 활성화됨.",
            VIDEO_DEVICE,
        )
        while True:  # 버퍼 적체 방지를 위해 프레임은 계속 비워준다
            try:
                await track.recv()
            except Exception:
                return

    writer = None
    count = 0
    try:
        while True:
            try:
                frame = await track.recv()
            except Exception:
                logger.info("영상 트랙 종료 (%d 프레임)", count)
                return
            img = frame.to_ndarray(format="rgb24")
            h, w, _ = img.shape
            if writer is None or writer.size != (w, h):
                if writer:
                    writer.close()
                writer = V4L2Writer(VIDEO_DEVICE, w, h)
            try:
                await loop.run_in_executor(None, writer.write, img.tobytes())
            except Exception as e:
                logger.error("v4l2 write 실패: %s", e)
                return
            count += 1
            if count == 1 or count % 150 == 0:
                logger.info("영상 프레임 #%d → %s", count, VIDEO_DEVICE)
    finally:
        if writer:
            writer.close()


# ---------------------------------------------------------------------------
# 음성: aiortc 프레임 → s16le 리샘플 → pacat stdin → PulseAudio virtmic_sink
# ---------------------------------------------------------------------------

def _spawn_pacat():
    runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.environ.get('PUID', '1000')}")
    # PulseAudio는 데스크톱 사용자(abc) 세션에서 구동되므로 그 컨텍스트로 pacat 실행.
    cmd = [
        "s6-setuidgid", PULSE_USER,
        "env", "HOME=/config", f"XDG_RUNTIME_DIR={runtime}",
        "pacat", "--playback", f"--device={PULSE_SINK}",
        "--format=s16le", f"--rate={AUDIO_RATE}", f"--channels={AUDIO_CHANNELS}",
        "--raw", "--client-name=rbi-camera",
    ]
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
            resampled = resampler.resample(frame)
            if not isinstance(resampled, list):
                resampled = [resampled]
            for rs in resampled:
                data = bytes(rs.planes[0])
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
        if track.kind == "video":
            asyncio.ensure_future(consume_video(relay.subscribe(track)))
        else:
            asyncio.ensure_future(consume_audio(relay.subscribe(track)))

    async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            data = json.loads(msg.data)
            if data.get("type") == "offer":
                await pc.setRemoteDescription(
                    RTCSessionDescription(sdp=data["sdp"], type="offer")
                )
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)  # aiortc: ICE gathering 완료까지 포함
                await ws.send_str(
                    json.dumps({"type": "answer", "sdp": pc.localDescription.sdp})
                )
                logger.info("answer 전송 완료")
        elif msg.type == web.WSMsgType.ERROR:
            logger.warning("WS 오류: %s", ws.exception())

    logger.info("WS 종료 — 피어 정리")
    await pc.close()
    pcs.discard(pc)
    return ws


async def on_shutdown(_app):
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
    app.on_shutdown.append(on_shutdown)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
