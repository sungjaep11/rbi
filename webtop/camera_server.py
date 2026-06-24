#!/usr/bin/env python3
"""
화상회의 미디어 수신 서버 — webtop 컨테이너 내부에서 실행됨.

  WS /camera-ws : 브라우저가 보낸 미디어 프레임을 받는다 (auth-proxy가 /camera-ws로 프록시).

전송은 더 이상 WebRTC가 아니라 auth-proxy WebSocket 터널을 통한 **태그된 바이너리**다.
첫 바이트가 프레임 종류를 나타낸다(selkies 마이크 패턴과 동일한 발상):
  0x01 + JPEG bytes   → 영상 프레임
  0x02 + PCM16 LE bytes → 오디오 프레임 (mono, AUDIO_RATE)

수신한 프레임을 가상 장치로 전달한다(subprocess 없이 라이브러리 직접 사용):
  video → PyAV(JPEG 디코드) → pyvirtualcam → /dev/video10 (v4l2loopback) ※ 장치 없으면 graceful skip
  audio → PyAudio 출력 스트림 → PulseAudio virtmic_sink                  ※ 항상 동작

설계: audio는 어디서나 동작(컨테이너 내 PulseAudio), video는 호스트 v4l2loopback이
있을 때만. 가상 웹캠이 없으면 영상 프레임을 버리고 마이크만 처리한다.
"""

import asyncio
import logging
import os
import threading

import numpy as np
from aiohttp import web

# 프레임 종류 태그 (브라우저 CAMERA_CLIENT_SCRIPT와 합의된 값)
TAG_VIDEO = 0x01
TAG_AUDIO = 0x02

VIDEO_DEVICE = os.environ.get("CAMERA_V4L2_DEVICE", "/dev/video10")
PULSE_SINK = os.environ.get("CAMERA_PULSE_SINK", "virtmic_sink")
PORT = int(os.environ.get("CAMERA_PORT", "8888"))

AUDIO_RATE = int(os.environ.get("CAMERA_AUDIO_RATE", "48000"))
AUDIO_CHANNELS = int(os.environ.get("CAMERA_AUDIO_CHANNELS", "1"))
VIDEO_FPS = int(os.environ.get("CAMERA_FPS", "30"))
# v4l2loopback 출력 고정 해상도. 들어오는 영상 해상도가 변해도 항상 이 크기로
# 스케일해 장치 포맷을 고정한다(안 그러면 Chromium이 카메라를 못 잡음).
OUT_W = int(os.environ.get("CAMERA_WIDTH", "1280"))
OUT_H = int(os.environ.get("CAMERA_HEIGHT", "720"))

logger = logging.getLogger("camera-server")


# ---------------------------------------------------------------------------
# 영상: JPEG bytes → PyAV 디코드 → rgb24 ndarray → pyvirtualcam(v4l2loopback)
# ---------------------------------------------------------------------------

# 활성 통화의 최신 프레임(rgb24 ndarray, H×W×3 uint8). None이면 검은 화면 출력.
_latest = {"frame": None}
_BLACK = np.zeros((OUT_H, OUT_W, 3), dtype=np.uint8)


def _decode_jpeg_to_rgb(data):
    """JPEG bytes → OUT_W×OUT_H rgb24 ndarray. PyAV mjpeg 코덱으로 디코드."""
    import av

    cc = av.CodecContext.create("mjpeg", "r")
    for frame in cc.decode(av.packet.Packet(data)):
        img = frame.reformat(width=OUT_W, height=OUT_H, format="rgb24").to_ndarray()
        return np.ascontiguousarray(img)
    return None


def video_pump_thread(stop_event):
    """부팅~종료까지 항상 /dev/video10에 프레임을 쓴다(상시 가상 카메라).

    통화 중이면 최신 영상, 아니면 검은 화면. 장치가 늘 캡처 가능 상태로 존재해
    Chromium을 언제 켜도 카메라가 보인다. pyvirtualcam이 프레임 타이밍을 관리한다.
    """
    import pyvirtualcam

    logger.info("video_pump 시작 — %s 상시 출력 (%dx%d@%dfps)", VIDEO_DEVICE, OUT_W, OUT_H, VIDEO_FPS)
    n = 0
    try:
        with pyvirtualcam.Camera(
            width=OUT_W, height=OUT_H, fps=VIDEO_FPS,
            device=VIDEO_DEVICE, backend="v4l2loopback",
            fmt=pyvirtualcam.PixelFormat.RGB,
        ) as cam:
            logger.info("pyvirtualcam 연결: %s", cam.device)
            while not stop_event.is_set():
                frame = _latest["frame"]
                cam.send(frame if frame is not None else _BLACK)
                cam.sleep_until_next_frame()
                n += 1
                if n % 300 == 0:
                    logger.info("video_pump 동작 중 (live=%s)", frame is not None)
    except Exception:
        logger.exception("video_pump 종료(장치 오류) — 영상 비활성")


def handle_video_frame(data):
    """수신한 JPEG 프레임을 디코드해 최신 프레임 슬롯에 저장(장치 쓰기는 video_pump 담당)."""
    try:
        img = _decode_jpeg_to_rgb(data)
        if img is not None:
            _latest["frame"] = img
    except Exception:
        logger.exception("영상 디코드 실패")


# ---------------------------------------------------------------------------
# 음성: PCM16 bytes → PyAudio 출력 스트림 → PulseAudio virtmic_sink
# ---------------------------------------------------------------------------

class AudioSink:
    """PyAudio 출력 스트림으로 PCM16을 PulseAudio virtmic_sink에 흘려보낸다.

    PortAudio의 PulseAudio 백엔드는 개별 sink를 잘 열거하지 못하므로,
    PULSE_SINK 환경변수로 기본 출력 sink를 고정한 뒤 기본 출력 장치를 연다.
    (sink 이름과 일치하는 장치가 열거되면 그 인덱스를 우선 사용한다.)
    """

    def __init__(self):
        import pyaudio

        # PulseAudio 클라이언트가 기본적으로 이 sink로 재생하도록 고정.
        os.environ.setdefault("PULSE_SINK", PULSE_SINK)
        self._pa = pyaudio.PyAudio()
        index = self._find_sink_index()
        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=AUDIO_CHANNELS,
            rate=AUDIO_RATE,
            output=True,
            output_device_index=index,
        )
        logger.info(
            "PyAudio 출력 스트림 시작: sink=%s device_index=%s rate=%d ch=%d",
            PULSE_SINK, index, AUDIO_RATE, AUDIO_CHANNELS,
        )

    def _find_sink_index(self):
        for i in range(self._pa.get_device_count()):
            info = self._pa.get_device_info_by_index(i)
            if info.get("maxOutputChannels", 0) > 0 and PULSE_SINK in str(info.get("name", "")):
                return i
        return None  # 기본 출력(PULSE_SINK env로 라우팅)

    def write(self, pcm_bytes):
        self._stream.write(pcm_bytes, exception_on_underflow=False)

    def close(self):
        try:
            self._stream.stop_stream()
            self._stream.close()
        except Exception:
            pass
        try:
            self._pa.terminate()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 시그널링 없는 미디어 수신 WS
# ---------------------------------------------------------------------------

async def camera_ws(request):
    ws = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024)
    await ws.prepare(request)
    logger.info("새 미디어 연결")

    loop = asyncio.get_event_loop()
    audio = None
    vcount = acount = 0

    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.BINARY:
                if msg.type == web.WSMsgType.ERROR:
                    logger.warning("WS 오류: %s", ws.exception())
                continue

            tag = msg.data[0]
            payload = msg.data[1:]

            if tag == TAG_VIDEO:
                if not os.path.exists(VIDEO_DEVICE):
                    continue  # 가상 웹캠 없음 — 영상 무시(마이크만 동작)
                await loop.run_in_executor(None, handle_video_frame, payload)
                vcount += 1
                if vcount == 1 or vcount % 150 == 0:
                    logger.info("영상 프레임 #%d → 가상 카메라", vcount)

            elif tag == TAG_AUDIO:
                if audio is None:
                    try:
                        audio = AudioSink()
                    except Exception:
                        logger.exception("PyAudio 초기화 실패 — 오디오 비활성")
                        audio = False  # 재시도 방지
                if audio:
                    await loop.run_in_executor(None, audio.write, payload)
                    acount += 1
                    if acount == 1 or acount % 200 == 0:
                        logger.info("음성 프레임 #%d → %s", acount, PULSE_SINK)
    finally:
        logger.info("WS 종료 (video=%d audio=%d) — 검은 화면 복귀", vcount, acount)
        _latest["frame"] = None
        if audio:
            audio.close()
    return ws


# ---------------------------------------------------------------------------
# 수명주기
# ---------------------------------------------------------------------------

async def on_startup(app):
    # 장치가 있으면 상시 가상 카메라 펌프 스레드를 띄운다(통화 없을 땐 검은 화면).
    if os.path.exists(VIDEO_DEVICE):
        stop = threading.Event()
        t = threading.Thread(target=video_pump_thread, args=(stop,), daemon=True)
        t.start()
        app["video_stop"] = stop
        app["video_thread"] = t
    else:
        logger.warning("가상 웹캠 %s 없음 — video_pump 미시작(마이크만 동작).", VIDEO_DEVICE)


async def on_shutdown(app):
    stop = app.get("video_stop")
    if stop:
        stop.set()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logger.info(
        "camera-server 시작: port=%d video=%s sink=%s (%dx%d@%dfps, audio %dHz×%dch)",
        PORT, VIDEO_DEVICE, PULSE_SINK, OUT_W, OUT_H, VIDEO_FPS, AUDIO_RATE, AUDIO_CHANNELS,
    )
    app = web.Application()
    app.router.add_get("/camera-ws", camera_ws)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    web.run_app(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
