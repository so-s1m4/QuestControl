import asyncio
import base64
import io
import logging
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

_AI_SERVICE_DIR = str(Path(__file__).resolve().parent)
if _AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, _AI_SERVICE_DIR)

import requests
from PIL import Image

logger = logging.getLogger("questcontrol.ai.receiver")

DEV_SECRET_FALLBACK = "development-internal-ai-secret-key-32chars-min"
IS_PRODUCTION = os.environ.get("NODE_ENV") == "production" or os.environ.get("ENV") == "production"

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    logger.warning("OpenCV (cv2) not available. VideoCapture fallbacks will be simulated.")

try:
    from aiortc import AudioStreamTrack, RTCIceServer, RTCPeerConnection, RTCConfiguration, MediaStreamTrack
    import av
    AIORTC_AVAILABLE = True
except ImportError:
    AIORTC_AVAILABLE = False
    logger.warning("aiortc or av not installed in current environment. Tuya WebRTC workers cannot start.")


class CameraStreamSession:
    def __init__(
        self,
        camera_id: str,
        provider: str,
        config: Dict[str, Any],
        api_url: str,
        semaphore: Optional[threading.BoundedSemaphore] = None,
        activity_semaphore: Optional[threading.BoundedSemaphore] = None,
    ):
        self.camera_id = camera_id
        self.provider = provider.upper()
        self.config = config
        self.api_url = api_url.rstrip("/")
        self.semaphore = semaphore
        self.activity_semaphore = activity_semaphore
        self.running = False
        self.thread: Optional[threading.Thread] = None

        # Frame circular buffer (keeps last 20 frames / ~15-20s)
        self.frame_buffer: Deque[Tuple[float, bytes]] = deque(maxlen=20)
        self.lock = threading.Lock()

        # Status & metrics
        self.last_frame_time: float = 0.0
        self.is_online: bool = False
        self.transport: str = "WEBRTC" if self.provider == "TUYA" else "SOURCE"
        self.last_error: Optional[str] = None
        self.is_moving: bool = False
        self.current_preset: str = "default"
        self.headset_detection_fn: Optional[Callable[[bytes, str, float], Dict[str, Any]]] = None
        self.activity_detection_fn: Optional[Callable[[bytes, str, str, float, List[str]], Dict[str, Any]]] = None
        self.dataset_capture_fn: Optional[Callable[[bytes, str, str, float, Dict[str, Any], List[Dict[str, Any]]], None]] = None
        self.last_activity_inference_at: float = 0.0
        self.last_auto_capture_at: float = 0.0
        self.previous_boxes: List[Dict[str, Any]] = []
        self.last_motion_time: float = 0.0
        # Browser playback remains WebRTC. This fallback applies only to the
        # isolated server-side AI worker after Tuya has rejected its P2P media
        # session, so capture and Telegram integrations keep working with no
        # browser open.
        fallback_setting = config.get("tuya_ai_hls_fallback", os.environ.get("TUYA_AI_HLS_FALLBACK", "true"))
        self.tuya_ai_hls_fallback = str(fallback_setting).strip().lower() not in ("0", "false", "no", "off")
        self.internal_secret = os.environ.get("INTERNAL_API_SECRET", "").strip()
        if (not self.internal_secret or self.internal_secret in ("internal-ai-service-secret", DEV_SECRET_FALLBACK)) and not IS_PRODUCTION:
            self.internal_secret = DEV_SECRET_FALLBACK

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.internal_secret:
            headers["X-Internal-Secret"] = self.internal_secret
        return headers

    def start(self, detection_fn: Callable[[bytes, str, float], Dict[str, Any]]):
        if self.running:
            return
        self.running = True
        self.detection_fn = detection_fn
        self.thread = threading.Thread(target=self._worker_loop, daemon=True, name=f"stream-{self.camera_id}")
        self.thread.start()
        logger.info("Started background stream worker for camera %s (%s)", self.camera_id, self.provider)

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3.0)
        logger.info("Stopped stream worker for camera %s", self.camera_id)

    def get_recent_frames(self, count: int = 4) -> List[Dict[str, Any]]:
        with self.lock:
            frames = list(self.frame_buffer)[-count:]
        return [
            {
                "timestamp": ts,
                "base64": base64.b64encode(b).decode("utf-8"),
            }
            for ts, b in frames
        ]

    def get_recent_frames_b64(self, count: int = 4) -> List[str]:
        with self.lock:
            frames = list(self.frame_buffer)[-count:]
        return [base64.b64encode(b).decode("utf-8") for _, b in frames]

    def get_recent_clip(self, count: int = 10, duration_ms: int = 400) -> bytes:
        with self.lock:
            frames = list(self.frame_buffer)[-count:]
        if not frames:
            return b""

        images = []
        for _, b in frames:
            try:
                im = Image.open(io.BytesIO(b)).convert("RGB")
                if im.width > 640 or im.height > 480:
                    im.thumbnail((640, 480))
                images.append(im)
            except Exception as e:
                logger.debug("Failed to decode frame for clip: %s", e)

        if not images:
            return b""

        out = io.BytesIO()
        images[0].save(
            out,
            format="GIF",
            save_all=True,
            append_images=images[1:],
            duration=duration_ms,
            loop=0,
            optimize=True,
        )
        return out.getvalue()


    def _worker_loop(self):
        consecutive_failures = 0

        while self.running:
            try:
                if self.provider == "TUYA":
                    # A Tuya worker is deliberately WebRTC-only. HLS creates a
                    # second cloud stream and hiding this dependency makes the AI
                    # appear healthy while it is no longer using the live path.
                    if not AIORTC_AVAILABLE:
                        self.last_error = "WEBRTC_RUNTIME_UNAVAILABLE"
                        logger.error("Tuya camera %s requires aiortc and av; refusing HLS fallback", self.camera_id)
                        time.sleep(15.0)
                        continue
                    completed = self._run_webrtc_stream()
                    if not completed and self.tuya_ai_hls_fallback and self.running:
                        # Some Tuya firmware accepts browser WebRTC but closes
                        # aiortc's server P2P session after ICE. HLS is the
                        # documented cloud transport fallback and preserves
                        # browser-independent processing.
                        logger.warning(
                            "Tuya WebRTC worker failed for %s (%s); switching AI worker to HLS fallback",
                            self.camera_id,
                            self.last_error or "unknown error",
                        )
                        self.transport = "HLS_FALLBACK"
                        frame_time_before_hls = self.last_frame_time
                        self._run_capture_stream()
                        completed = self.last_frame_time > frame_time_before_hls
                    # A failed allocation, invalid ICE configuration or a
                    # dropped session must count as a failure. Previously a
                    # normal return reset the cadence to two seconds and
                    # created an endless stream of Tuya sessions.
                    if completed:
                        consecutive_failures = 0
                        self.last_error = None
                    else:
                        consecutive_failures += 1
                else:
                    self.transport = "SOURCE"
                    self._run_capture_stream()
            except Exception as exc:
                consecutive_failures += 1
                self.last_error = str(exc)[:240]
                logger.error("Stream worker exception on %s: %s (retrying...)", self.camera_id, exc)

            if not self.running:
                break

            # If stream dropped and remained offline for >10s
            if self.is_online and (time.time() - self.last_frame_time > 10.0):
                self._notify_camera_status(False)

            # Back off failed camera negotiations aggressively. This protects
            # both Tuya's P2P service and an operator's foreground session.
            backoff = min(60.0, 2.0 ** min(consecutive_failures, 6))
            time.sleep(backoff)

    def _run_webrtc_stream(self) -> bool:
        """
        Connects directly to Tuya camera WebRTC media stream via backend signaling bridge.
        """
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def run() -> bool:
            sess_url = f"{self.api_url}/internal/tuya-webrtc/session"
            sess_resp = requests.post(sess_url, json={"cameraId": self.camera_id}, headers=self._headers(), timeout=10)
            if sess_resp.status_code != 200:
                logger.warning("Failed to allocate Tuya WebRTC session for %s: %s", self.camera_id, sess_resp.text)
                self.last_error = f"SESSION_ALLOCATION_HTTP_{sess_resp.status_code}"
                return False

            sess_data = sess_resp.json()
            session_id = sess_data.get("sessionId")
            ice_configs = sess_data.get("iceServers", [])

            ice_servers = []
            for entry in ice_configs:
                raw_urls = entry.get("urls") or entry.get("url")
                urls = raw_urls if isinstance(raw_urls, list) else [raw_urls]
                for url in urls:
                    if not url:
                        continue
                    # aiortc's ICE URI parser cannot consume Tuya's bracketed
                    # IPv6 STUN URI. Keep the valid IPv4 STUN/TURN servers;
                    # a malformed optional IPv6 endpoint must not prevent the
                    # entire worker from negotiating media.
                    if str(url).startswith(("stun:[", "turn:[", "turns:[")):
                        logger.info("Skipping unsupported bracketed IPv6 ICE URI for %s", self.camera_id)
                        continue
                    ice_servers.append(
                        RTCIceServer(
                            # aiortc accepts one URI per RTCIceServer, unlike
                            # the browser API where `urls` can be an array.
                            urls=str(url),
                            username=entry.get("username"),
                            credential=entry.get("credential"),
                        )
                    )

            pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
            # Tuya's camera-side WebRTC implementation expects the same offer
            # shape as its Smart Life browser player: a silent audio sender and
            # a video receiver. Sending only a recvonly video m-line lets the
            # SDP exchange complete but then closes the ICE session before any
            # media frame arrives.
            pc.addTrack(AudioStreamTrack())
            pc.addTransceiver("video", direction="recvonly")

            @pc.on("connectionstatechange")
            def on_conn_state():
                logger.info("WebRTC connection state on %s: %s", self.camera_id, pc.connectionState)

            @pc.on("iceconnectionstatechange")
            def on_ice_state():
                logger.info("WebRTC ICE connection state on %s: %s", self.camera_id, pc.iceConnectionState)

            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)

            # Send the offer SDP to Tuya WebRTC signaling bridge
            sig_url = f"{self.api_url}/internal/tuya-webrtc/signal"
            sig_resp = requests.post(
                sig_url,
                json={
                    "sessionId": session_id,
                    "type": "offer",
                    "payload": pc.localDescription.sdp,
                    # Do not wait for the answer here. Tuya expects the local
                    # ICE candidates immediately after the offer, just like
                    # the browser player sends them.
                    "waitForAnswer": False,
                },
                headers=self._headers(),
                timeout=10,
            )
            if sig_resp.status_code != 200:
                await pc.close()
                self.last_error = f"OFFER_SIGNAL_HTTP_{sig_resp.status_code}"
                return False

            # Explicitly relay any gathered local candidates to signaling
            for line in pc.localDescription.sdp.splitlines():
                if line.startswith("a=candidate:"):
                    # Tuya's MQTT 302 protocol requires the SDP-line form
                    # (`a=candidate:…`), not aiortc's parsed raw candidate.
                    cand_str = line.strip()
                    try:
                        requests.post(
                            sig_url,
                            json={"sessionId": session_id, "type": "candidate", "payload": cand_str},
                            headers=self._headers(),
                            timeout=3,
                        )
                    except Exception:
                        pass

            # The bridge queues camera signals. Collect the answer only after
            # the local candidates have been relayed; waiting for it before
            # sending them makes Tuya close the P2P session without media.
            answer_sdp = None
            initial_remote_candidates = []
            for _ in range(40):
                try:
                    response = requests.get(
                        f"{self.api_url}/internal/tuya-webrtc/signals",
                        params={"sessionId": session_id},
                        headers=self._headers(),
                        timeout=3,
                    )
                    if response.status_code == 200:
                        for signal in response.json().get("signals", []):
                            if signal.get("type") == "answer" and signal.get("payload"):
                                answer_sdp = signal["payload"]
                            elif signal.get("type") == "candidate" and signal.get("payload"):
                                initial_remote_candidates.append(signal["payload"])
                            elif signal.get("type") == "disconnect":
                                self.last_error = "TUYA_DISCONNECTED_DURING_NEGOTIATION"
                                await pc.close()
                                return False
                        if answer_sdp:
                            break
                except Exception:
                    pass
                await asyncio.sleep(0.25)

            if not answer_sdp:
                await pc.close()
                self.last_error = "TUYA_ANSWER_MISSING"
                return False

            from aiortc import RTCSessionDescription
            from aiortc.sdp import candidate_from_sdp

            async def apply_remote_candidate(raw_candidate: str) -> None:
                """Attach a Tuya trickle candidate to the bundled audio/video SDP."""
                candidate = candidate_from_sdp(str(raw_candidate).removeprefix("a="))
                # aiortc does not infer the media section from a parsed SDP
                # candidate. Tuya sends bundle candidates, whose browser
                # player applies to m-line 0; without this association ICE
                # remains in "checking" forever.
                candidate.sdpMid = "0"
                candidate.sdpMLineIndex = 0
                await pc.addIceCandidate(candidate)

            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))

            for c_sdp in initial_remote_candidates:
                try:
                    await apply_remote_candidate(c_sdp)
                except Exception:
                    pass

            camera_disconnected = asyncio.Event()

            async def poll_remote_candidates():
                poll_count = 0
                while self.running and pc.connectionState not in ("connected", "failed", "closed") and poll_count < 25:
                    await asyncio.sleep(0.6)
                    poll_count += 1
                    try:
                        resp = requests.get(
                            f"{self.api_url}/internal/tuya-webrtc/signals",
                            params={"sessionId": session_id},
                            headers=self._headers(),
                            timeout=3,
                        )
                        if resp.status_code == 200:
                            signals = resp.json().get("signals", [])
                            for s in signals:
                                if s.get("type") == "candidate" and s.get("payload"):
                                    try:
                                        await apply_remote_candidate(s["payload"])
                                        logger.debug("Applied Tuya remote ICE candidate on %s", self.camera_id)
                                    except Exception as e:
                                        logger.debug("Failed adding ICE candidate: %s", e)
                                elif s.get("type") == "disconnect":
                                    logger.info("Tuya camera disconnected WebRTC session for %s", self.camera_id)
                                    camera_disconnected.set()
                                    return
                    except Exception:
                        pass

            asyncio.create_task(poll_remote_candidates())

            @pc.on("track")
            async def on_track(track: MediaStreamTrack):
                if track.kind == "video":
                    logger.info("WebRTC video track received for camera %s", self.camera_id)
                    frame_interval = 0.8
                    last_processed = 0.0

                    while self.running:
                        try:
                            frame = await asyncio.wait_for(track.recv(), timeout=8.0)
                            now = time.time()
                            if now - last_processed >= frame_interval:
                                last_processed = now
                                img = frame.to_image()
                                buf = io.BytesIO()
                                img.save(buf, format="JPEG", quality=80)
                                self._process_frame_bytes(buf.getvalue())
                        except asyncio.TimeoutError:
                            logger.warning("WebRTC frame timeout on camera %s", self.camera_id)
                            break
                        except Exception as e:
                            logger.warning("WebRTC frame read error on %s: %s", self.camera_id, e)
                            break

            connected_once = False
            connect_deadline = time.monotonic() + 20.0
            while self.running and not camera_disconnected.is_set() and pc.connectionState not in ("failed", "closed"):
                connected_once = connected_once or pc.connectionState == "connected"
                if not connected_once and time.monotonic() >= connect_deadline:
                    self.last_error = "WEBRTC_CONNECTION_TIMEOUT"
                    logger.warning("WebRTC connection timed out on %s", self.camera_id)
                    break
                await asyncio.sleep(1.0)

            await pc.close()
            if not connected_once:
                self.last_error = self.last_error or "WEBRTC_CONNECTION_NOT_ESTABLISHED"
            return connected_once

        try:
            return bool(loop.run_until_complete(run()))
        finally:
            loop.close()

    def _run_capture_stream(self):
        """
        Reads from RTSP or Tuya HLS stream using OpenCV or periodic HTTP snapshot fetch.
        """
        stream_url = self.config.get("stream_url") or self.config.get("streamUrl")

        if self.provider == "TUYA" and not stream_url:
            try:
                hls_resp = requests.post(
                    f"{self.api_url}/internal/tuya/hls",
                    json={"cameraId": self.camera_id},
                    headers=self._headers(),
                    timeout=8,
                )
                if hls_resp.status_code == 200:
                    stream_url = hls_resp.json().get("endpoint")
            except Exception as e:
                logger.warning("Could not allocate HLS for Tuya camera %s: %s", self.camera_id, e)

        if not stream_url and self.config.get("stream_key"):
            stream_url = f"http://localhost:1984/api/frame.jpeg?src={self.config['stream_key']}"

        if not stream_url:
            time.sleep(3.0)
            return

        if stream_url.endswith(".jpeg") or stream_url.endswith(".jpg") or "/frame.jpeg" in stream_url:
            while self.running:
                try:
                    resp = requests.get(stream_url, timeout=4)
                    if resp.status_code == 200:
                        self._process_frame_bytes(resp.content)
                    time.sleep(1.0)
                except Exception:
                    time.sleep(2.0)
            return

        if not CV2_AVAILABLE:
            time.sleep(5.0)
            return

        cap = cv2.VideoCapture(stream_url)
        if not cap.isOpened():
            logger.warning("Cannot open stream for camera %s: %s", self.camera_id, stream_url)
            time.sleep(4.0)
            return

        last_processed = 0.0
        frame_interval = 0.8

        try:
            while self.running:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.5)
                    break

                now = time.time()
                if now - last_processed >= frame_interval:
                    last_processed = now
                    ret_enc, jpeg_bytes = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                    if ret_enc:
                        self._process_frame_bytes(jpeg_bytes.tobytes())
                time.sleep(0.05)
        finally:
            cap.release()

    def _process_frame_bytes(self, image_bytes: bytes):
        now = time.time()
        self.last_frame_time = now

        with self.lock:
            self.frame_buffer.append((now, image_bytes))

        if not self.is_online:
            self._notify_camera_status(True)

        if self.is_moving:
            logger.debug("Skipping detection tick for %s because camera is moving/settling", self.camera_id)
            return

        if not hasattr(self, "detection_fn") or not self.detection_fn:
            return

        # Concurrency & backpressure control: acquire semaphore with short timeout
        # to prevent parallel YOLO saturation and thread starvation across multiple cameras
        acquired = True
        if self.semaphore:
            acquired = self.semaphore.acquire(timeout=0.3)
            if not acquired:
                logger.debug("Skipping detection tick for %s due to worker inference backpressure", self.camera_id)
                return

        try:
            detection = self.detection_fn(image_bytes, self.camera_id, 0.25)
            people = detection.get("people", [])
            people_count = len(people)

            motion = self._evaluate_motion(people)
            unusual, unusual_desc = self._evaluate_unusual_activity(people)

            payload = {
                "cameraId": self.camera_id,
                "peopleCount": people_count,
                "people": people,
                "motion": motion,
                "unusual": unusual,
                "unusualDescription": unusual_desc,
                "status": "ONLINE",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            requests.post(
                f"{self.api_url}/internal/ai/camera-state",
                json=payload,
                headers=self._headers(),
                timeout=3.0,
            )

            # Headset tracking if enabled
            if self.config.get("headset_tracking_enabled") and self.headset_detection_fn:
                try:
                    headsets_res = self.headset_detection_fn(image_bytes, self.camera_id, 0.4)
                    h_status = headsets_res.get("status", "READY")
                    requests.post(
                        f"{self.api_url}/internal/ai/camera-headsets",
                        json={
                            "cameraId": self.camera_id,
                            "preset": self.current_preset,
                            "status": h_status,
                            "modelStatus": h_status,
                            "headsets": headsets_res.get("headsets", []),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        },
                        headers=self._headers(),
                        timeout=3.0,
                    )
                except Exception as h_err:
                    logger.debug("Headset state push failed: %s", h_err)

        except Exception as exc:
            logger.debug("Failed to push camera state to API: %s", exc)
        finally:
            if self.semaphore and acquired:
                self.semaphore.release()

        self._maybe_auto_capture(image_bytes, now)

        # Activity inference deliberately has a separate bounded semaphore.
        # A slow pose model must never block the existing people/headset worker.
        activity_settings = self.config.get("activity_settings") or {}
        enabled_actions = [
            str(action_type)
            for action_type, setting in activity_settings.items()
            if isinstance(setting, dict) and setting.get("enabled")
        ]
        activity_interval = max(0.25, float(self.config.get("activity_interval_sec", 0.75)))
        if not enabled_actions or not self.activity_detection_fn or now - self.last_activity_inference_at < activity_interval:
            return

        activity_acquired = True
        if self.activity_semaphore:
            activity_acquired = self.activity_semaphore.acquire(blocking=False)
        if not activity_acquired:
            logger.debug("Skipping activity tick for %s due to activity backpressure", self.camera_id)
            return
        try:
            self.last_activity_inference_at = now
            activity_result = self.activity_detection_fn(
                image_bytes, self.camera_id, self.current_preset, now, enabled_actions
            )
            events = activity_result.get("events", []) if isinstance(activity_result, dict) else []
            # Frames are sent only after a confirmed event, never for each tick.
            payload = {
                "cameraId": self.camera_id,
                "preset": self.current_preset,
                "timestamp": now,
                "result": activity_result if isinstance(activity_result, dict) else {},
            }
            if events:
                payload["image"] = base64.b64encode(image_bytes).decode("ascii")
            requests.post(
                f"{self.api_url}/internal/ai/camera-activity",
                json=payload,
                headers=self._headers(),
                timeout=4.0,
            )
        except Exception as activity_err:
            logger.debug("Activity state push failed for %s: %s", self.camera_id, activity_err)
        finally:
            if self.activity_semaphore and activity_acquired:
                self.activity_semaphore.release()

    def _maybe_auto_capture(self, image_bytes: bytes, now: float) -> None:
        """Sparsely collect model-suggested frames during an operator session."""
        if not self.config.get("auto_capture_enabled") or not self.config.get("capture_session_id"):
            return
        if not self.dataset_capture_fn or not self.headset_detection_fn:
            return
        interval = max(3.0, float(self.config.get("capture_interval_sec", 12)))
        if now - self.last_auto_capture_at < interval:
            return
        acquired = True
        if self.semaphore:
            acquired = self.semaphore.acquire(blocking=False)
        if not acquired:
            logger.debug("Skipping automatic dataset capture for %s due to inference backpressure", self.camera_id)
            return
        try:
            detection = self.headset_detection_fn(image_bytes, self.camera_id, 0.35)
            bboxes = [
                {"classId": 0, **headset.get("bbox", {})}
                for headset in detection.get("headsets", [])
                if isinstance(headset, dict) and isinstance(headset.get("bbox"), dict)
            ]
            self.dataset_capture_fn(image_bytes, self.camera_id, self.current_preset, now, self.config, bboxes)
            self.last_auto_capture_at = now
        except Exception as exc:
            logger.debug("Automatic dataset capture failed for %s: %s", self.camera_id, exc)
        finally:
            if self.semaphore and acquired:
                self.semaphore.release()

    def _evaluate_motion(self, people: List[Dict[str, Any]]) -> bool:
        current_boxes = [p.get("bbox", {}) for p in people]
        if not current_boxes and not self.previous_boxes:
            self.previous_boxes = []
            return False

        if len(current_boxes) != len(self.previous_boxes):
            self.previous_boxes = current_boxes
            return True

        motion_found = False
        for i, curr in enumerate(current_boxes):
            prev = self.previous_boxes[i] if i < len(self.previous_boxes) else None
            if prev:
                dx = abs(curr.get("x", 0) - prev.get("x", 0))
                dy = abs(curr.get("y", 0) - prev.get("y", 0))
                if dx > 0.025 or dy > 0.025:
                    motion_found = True
                    break

        self.previous_boxes = current_boxes
        return motion_found

    def _evaluate_unusual_activity(self, people: List[Dict[str, Any]]) -> Tuple[bool, Optional[str]]:
        if not people:
            return False, None

        for p in people:
            b = p.get("bbox", {})
            w = b.get("width", 0.1)
            h = b.get("height", 0.5)
            y = b.get("y", 0.0)
            if h > 0:
                aspect = w / h
                if aspect > 1.6 and y > 0.55:
                    return True, "Возможное падение игрока на пол"

        if len(people) >= 4:
            xs = [p.get("bbox", {}).get("x", 0) for p in people]
            if max(xs) - min(xs) < 0.25:
                return True, "Плотное скопление игроков в одной зоне"

        return False, None

    def _notify_camera_status(self, online: bool):
        self.is_online = online
        status_str = "ONLINE" if online else "OFFLINE"
        logger.info("Camera %s status changed to %s", self.camera_id, status_str)
        try:
            requests.post(
                f"{self.api_url}/internal/ai/camera-state",
                json={
                    "cameraId": self.camera_id,
                    "status": status_str,
                    "peopleCount": 0 if not online else None,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                headers=self._headers(),
                timeout=3.0,
            )
        except Exception:
            pass


class StreamWorkerManager:
    def __init__(self, api_url: Optional[str] = None):
        self.api_url = (
            api_url
            or os.environ.get("API_INTERNAL_URL")
            or os.environ.get("API_URL", "http://api:3000")
        ).rstrip("/")
        self.sessions: Dict[str, CameraStreamSession] = {}
        self.lock = threading.Lock()
        self.detection_fn: Optional[Callable[[bytes, str, float], Dict[str, Any]]] = None
        self.headset_detection_fn: Optional[Callable[[bytes, str, float], Dict[str, Any]]] = None
        self.activity_detection_fn: Optional[Callable[[bytes, str, str, float, List[str]], Dict[str, Any]]] = None
        self.dataset_capture_fn: Optional[Callable[[bytes, str, str, float, Dict[str, Any], List[Dict[str, Any]]], None]] = None
        max_parallel = int(os.environ.get("MAX_PARALLEL_INFERENCE", "2"))
        self.semaphore = threading.BoundedSemaphore(max_parallel)
        max_parallel_activity = int(os.environ.get("MAX_PARALLEL_ACTIVITY_INFERENCE", "1"))
        self.activity_semaphore = threading.BoundedSemaphore(max_parallel_activity)
        self.internal_secret = os.environ.get("INTERNAL_API_SECRET", "").strip()
        if (not self.internal_secret or self.internal_secret in ("internal-ai-service-secret", DEV_SECRET_FALLBACK)) and not IS_PRODUCTION:
            self.internal_secret = DEV_SECRET_FALLBACK
        self.bootstrap_thread: Optional[threading.Thread] = None

    def set_detection_fn(self, fn: Callable[[bytes, str, float], Dict[str, Any]]):
        self.detection_fn = fn

    def set_headset_detection_fn(self, fn: Callable[[bytes, str, float], Dict[str, Any]]):
        self.headset_detection_fn = fn
        with self.lock:
            for session in self.sessions.values():
                session.headset_detection_fn = fn

    def set_activity_detection_fn(self, fn: Callable[[bytes, str, str, float, List[str]], Dict[str, Any]]):
        self.activity_detection_fn = fn
        with self.lock:
            for session in self.sessions.values():
                session.activity_detection_fn = fn

    def set_dataset_capture_fn(self, fn: Callable[[bytes, str, str, float, Dict[str, Any], List[Dict[str, Any]]], None]):
        self.dataset_capture_fn = fn
        with self.lock:
            for session in self.sessions.values():
                session.dataset_capture_fn = fn

    def set_camera_moving(self, camera_id: str, is_moving: bool, preset: str = ""):
        with self.lock:
            session = self.sessions.get(camera_id)
            if session:
                session.is_moving = is_moving
                if preset:
                    session.current_preset = preset

    def sync_cameras(self, cameras: List[Dict[str, Any]]):
        with self.lock:
            incoming_ids = set()
            for cam in cameras:
                cid = str(cam.get("id"))
                incoming_ids.add(cid)
                ai_enabled = cam.get("ai_enabled", cam.get("aiEnabled", True))

                if not ai_enabled:
                    if cid in self.sessions:
                        self.sessions[cid].stop()
                        del self.sessions[cid]
                    continue

                if cid not in self.sessions:
                    provider = cam.get("provider", "TUYA")
                    session = CameraStreamSession(
                        camera_id=cid,
                        provider=provider,
                        config=cam,
                        api_url=self.api_url,
                        semaphore=self.semaphore,
                        activity_semaphore=self.activity_semaphore,
                    )
                    session.headset_detection_fn = self.headset_detection_fn
                    session.activity_detection_fn = self.activity_detection_fn
                    session.dataset_capture_fn = self.dataset_capture_fn
                    self.sessions[cid] = session
                    if self.detection_fn:
                        session.start(self.detection_fn)
                else:
                    # Settings (including room-scoped activity flags) may
                    # change while the worker stays alive.
                    session = self.sessions[cid]
                    session.config = cam
                    session.headset_detection_fn = self.headset_detection_fn
                    session.activity_detection_fn = self.activity_detection_fn
                    session.dataset_capture_fn = self.dataset_capture_fn

            for cid in list(self.sessions.keys()):
                if cid not in incoming_ids:
                    self.sessions[cid].stop()
                    del self.sessions[cid]

    def get_cached_frames(self, camera_id: str, count: int = 4) -> List[Dict[str, Any]]:
        session = self.sessions.get(camera_id)
        if session:
            return session.get_recent_frames(count)
        return []

    def get_recent_clip(self, camera_id: str, count: int = 10) -> bytes:
        session = self.sessions.get(camera_id)
        if session:
            return session.get_recent_clip(count)
        return b""

    def get_statuses(self) -> Dict[str, Any]:
        result = {}
        for cid, sess in self.sessions.items():
            result[cid] = {
                "online": sess.is_online,
                "provider": sess.provider,
                "transport": sess.transport,
                "webrtcAvailable": AIORTC_AVAILABLE if sess.provider == "TUYA" else None,
                "lastError": sess.last_error,
                "lastFrame": sess.last_frame_time,
                "bufferedFrames": len(sess.frame_buffer),
            }
        return result

    def bootstrap_from_api(self, max_retries: int = 20, retry_interval: float = 3.0):
        def _bootstrap_loop():
            target_url = f"{self.api_url}/internal/cameras"
            headers = {"Content-Type": "application/json"}
            if self.internal_secret:
                headers["X-Internal-Secret"] = self.internal_secret

            for attempt in range(1, max_retries + 1):
                try:
                    resp = requests.get(target_url, headers=headers, timeout=5)
                    if resp.status_code == 200:
                        cameras = resp.json()
                        if isinstance(cameras, list):
                            logger.info("Self-bootstrap: successfully fetched %d AI cameras from API.", len(cameras))
                            self.sync_cameras(cameras)
                            return
                    else:
                        logger.debug("Self-bootstrap attempt %d/%d HTTP %s from %s", attempt, max_retries, resp.status_code, target_url)
                except Exception as e:
                    logger.debug("Self-bootstrap attempt %d/%d failed to reach %s: %s", attempt, max_retries, target_url, e)
                time.sleep(retry_interval)
            logger.warning("Self-bootstrap finished without fetching cameras from %s.", target_url)

        self.bootstrap_thread = threading.Thread(target=_bootstrap_loop, daemon=True, name="worker-bootstrap")
        self.bootstrap_thread.start()
