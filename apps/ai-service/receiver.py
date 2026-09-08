import asyncio
import base64
import io
import logging
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

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
    from aiortc import RTCIceServer, RTCPeerConnection, RTCConfiguration, MediaStreamTrack
    import av
    AIORTC_AVAILABLE = True
except ImportError:
    AIORTC_AVAILABLE = False
    logger.warning("aiortc or av not installed in current environment. Background WebRTC will use fallback stream.")


class CameraStreamSession:
    def __init__(
        self,
        camera_id: str,
        provider: str,
        config: Dict[str, Any],
        api_url: str,
        semaphore: Optional[threading.BoundedSemaphore] = None,
    ):
        self.camera_id = camera_id
        self.provider = provider.upper()
        self.config = config
        self.api_url = api_url.rstrip("/")
        self.semaphore = semaphore
        self.running = False
        self.thread: Optional[threading.Thread] = None

        # Frame circular buffer (keeps last 20 frames / ~15-20s)
        self.frame_buffer: Deque[Tuple[float, bytes]] = deque(maxlen=20)
        self.lock = threading.Lock()

        # Status & metrics
        self.last_frame_time: float = 0.0
        self.is_online: bool = False
        self.previous_boxes: List[Dict[str, Any]] = []
        self.last_motion_time: float = 0.0
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
                if self.provider == "TUYA" and AIORTC_AVAILABLE:
                    self._run_webrtc_stream()
                else:
                    self._run_capture_stream()
            except Exception as exc:
                consecutive_failures += 1
                logger.error("Stream worker exception on %s: %s (retrying...)", self.camera_id, exc)

            if not self.running:
                break

            # If stream dropped and remained offline for >10s
            if self.is_online and (time.time() - self.last_frame_time > 10.0):
                self._notify_camera_status(False)

            backoff = min(15.0, 2.0 * (consecutive_failures or 1))
            time.sleep(backoff)

    def _run_webrtc_stream(self):
        """
        Connects directly to Tuya camera WebRTC media stream via backend signaling bridge.
        """
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def run():
            sess_url = f"{self.api_url}/internal/tuya-webrtc/session"
            sess_resp = requests.post(sess_url, json={"cameraId": self.camera_id}, headers=self._headers(), timeout=10)
            if sess_resp.status_code != 200:
                logger.warning("Failed to allocate Tuya WebRTC session for %s: %s", self.camera_id, sess_resp.text)
                return

            sess_data = sess_resp.json()
            session_id = sess_data.get("sessionId")
            ice_configs = sess_data.get("iceServers", [])

            ice_servers = []
            for entry in ice_configs:
                urls = entry.get("urls") or entry.get("url")
                if urls:
                    ice_servers.append(
                        RTCIceServer(
                            urls=urls if isinstance(urls, list) else [urls],
                            username=entry.get("username"),
                            credential=entry.get("credential"),
                        )
                    )

            pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
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
                json={"sessionId": session_id, "type": "offer", "payload": pc.localDescription.sdp},
                headers=self._headers(),
                timeout=10,
            )
            if sig_resp.status_code != 200:
                await pc.close()
                return

            # Explicitly relay any gathered local candidates to signaling
            for line in pc.localDescription.sdp.splitlines():
                if line.startswith("a=candidate:"):
                    cand_str = line[2:].strip()
                    try:
                        requests.post(
                            sig_url,
                            json={"sessionId": session_id, "type": "candidate", "payload": cand_str},
                            headers=self._headers(),
                            timeout=3,
                        )
                    except Exception:
                        pass

            sig_data = sig_resp.json()
            answer_sdp = sig_data.get("answer")
            if not answer_sdp:
                await pc.close()
                return

            from aiortc import RTCSessionDescription
            from aiortc.sdp import candidate_from_sdp
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))

            for c_sdp in sig_data.get("candidates", []):
                try:
                    cand = candidate_from_sdp(c_sdp)
                    await pc.addIceCandidate(cand)
                except Exception:
                    pass

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
                                        cand = candidate_from_sdp(s["payload"])
                                        await pc.addIceCandidate(cand)
                                        logger.debug("Applied Tuya remote ICE candidate on %s", self.camera_id)
                                    except Exception as e:
                                        logger.debug("Failed adding ICE candidate: %s", e)
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

            while self.running and pc.connectionState not in ("failed", "closed"):
                await asyncio.sleep(1.0)

            await pc.close()

        try:
            loop.run_until_complete(run())
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
        except Exception as exc:
            logger.debug("Failed to push camera state to API: %s", exc)
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
        max_parallel = int(os.environ.get("MAX_PARALLEL_INFERENCE", "2"))
        self.semaphore = threading.BoundedSemaphore(max_parallel)
        self.internal_secret = os.environ.get("INTERNAL_API_SECRET", "").strip()
        if (not self.internal_secret or self.internal_secret in ("internal-ai-service-secret", DEV_SECRET_FALLBACK)) and not IS_PRODUCTION:
            self.internal_secret = DEV_SECRET_FALLBACK
        self.bootstrap_thread: Optional[threading.Thread] = None

    def set_detection_fn(self, fn: Callable[[bytes, str, float], Dict[str, Any]]):
        self.detection_fn = fn

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
                    )
                    self.sessions[cid] = session
                    if self.detection_fn:
                        session.start(self.detection_fn)

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

