import io
import os
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

# Set dummy environment variables for tests
os.environ["INTERNAL_API_SECRET"] = "test-internal-secret-1234567890123456"
os.environ["MAX_PARALLEL_INFERENCE"] = "2"

from receiver import CameraStreamSession, StreamWorkerManager
from server import AIServiceHandler
from vlm import resolve_and_pin_local_url


class TestAIServiceAuth(unittest.TestCase):
    def test_check_auth_rejects_missing_secret(self):
        handler = MagicMock()
        handler.headers = {}
        handler.path = "/worker/status"
        handler._send_json = MagicMock()

        result = AIServiceHandler._check_auth(handler)
        self.assertFalse(result)
        handler._send_json.assert_called_once_with(403, {"error": "FORBIDDEN_INTERNAL_ONLY"})

    def test_check_auth_rejects_invalid_secret(self):
        handler = MagicMock()
        handler.headers = {"X-Internal-Secret": "wrong-secret"}
        handler.path = "/worker/status"
        handler._send_json = MagicMock()

        result = AIServiceHandler._check_auth(handler)
        self.assertFalse(result)
        handler._send_json.assert_called_once_with(403, {"error": "FORBIDDEN_INTERNAL_ONLY"})

    def test_check_auth_accepts_valid_header(self):
        handler = MagicMock()
        handler.headers = {"X-Internal-Secret": "test-internal-secret-1234567890123456"}
        handler.path = "/worker/status"
        handler._send_json = MagicMock()

        result = AIServiceHandler._check_auth(handler)
        self.assertTrue(result)
        handler._send_json.assert_not_called()

    def test_check_auth_accepts_valid_query_param(self):
        handler = MagicMock()
        handler.headers = {}
        handler.path = "/worker/status?secret=test-internal-secret-1234567890123456"
        handler._send_json = MagicMock()

        result = AIServiceHandler._check_auth(handler)
        self.assertTrue(result)
        handler._send_json.assert_not_called()

    @patch("server.INTERNAL_API_SECRET", "")
    def test_check_auth_rejects_when_server_secret_empty(self):
        handler = MagicMock()
        handler.headers = {"X-Internal-Secret": "anything"}
        handler.path = "/worker/status"
        handler._send_json = MagicMock()

        result = AIServiceHandler._check_auth(handler)
        self.assertFalse(result)
        handler._send_json.assert_called_once_with(403, {"error": "FORBIDDEN_INTERNAL_ONLY"})


class TestWorkerManagerAndBackpressure(unittest.TestCase):
    def test_frame_buffer_and_caching(self):
        session = CameraStreamSession(
            camera_id="cam-test",
            provider="TUYA",
            config={},
            api_url="http://api:3000",
        )
        # Push 3 mock jpeg frames
        session.frame_buffer.append((time.time() - 2.0, b"frame-1"))
        session.frame_buffer.append((time.time() - 1.0, b"frame-2"))
        session.frame_buffer.append((time.time(), b"frame-3"))

        cached = session.get_recent_frames(count=2)
        self.assertEqual(len(cached), 2)
        self.assertIn("timestamp", cached[0])
        self.assertIn("base64", cached[0])

        b64_list = session.get_recent_frames_b64(count=2)
        self.assertEqual(len(b64_list), 2)
        self.assertIsInstance(b64_list[0], str)

    def test_inference_semaphore_backpressure(self):
        semaphore = threading.BoundedSemaphore(1)
        session = CameraStreamSession(
            camera_id="cam-backpressure",
            provider="TUYA",
            config={},
            api_url="http://api:3000",
            semaphore=semaphore,
        )

        mock_detect = MagicMock(return_value={"people": []})
        session.detection_fn = mock_detect

        # Acquire the semaphore externally to simulate an in-progress YOLO detection
        acquired = semaphore.acquire(blocking=False)
        self.assertTrue(acquired)

        # Now trigger frame processing: with semaphore blocked, it should skip detection
        session._process_frame_bytes(b"dummy-image-bytes")
        mock_detect.assert_not_called()

        # Frame was still stored in circular buffer despite backpressure drop
        self.assertEqual(len(session.frame_buffer), 1)

        # Release semaphore
        semaphore.release()
        session.stop()

    def test_get_recent_clip_generates_valid_gif(self):
        from PIL import Image
        session = CameraStreamSession(
            camera_id="cam-clip-test",
            provider="TUYA",
            config={},
            api_url="http://api:3000",
        )
        im = Image.new("RGB", (64, 64), color="blue")
        buf = io.BytesIO()
        im.save(buf, format="JPEG")
        jpg_bytes = buf.getvalue()

        session.frame_buffer.append((time.time() - 1.0, jpg_bytes))
        session.frame_buffer.append((time.time(), jpg_bytes))

        clip = session.get_recent_clip(count=2)
        self.assertTrue(clip.startswith(b"GIF89a") or clip.startswith(b"GIF87a"))
        self.assertGreater(len(clip), 100)

    def test_worker_manager_bootstrap_from_api(self):
        manager = StreamWorkerManager(api_url="http://api:3000")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [{"id": "cam-boot-1", "ai_enabled": True, "provider": "TUYA"}]

        with patch("requests.get", return_value=mock_resp) as mock_get:
            manager.bootstrap_from_api(max_retries=1, retry_interval=0.01)
            if manager.bootstrap_thread:
                manager.bootstrap_thread.join(timeout=2.0)
            self.assertIn("cam-boot-1", manager.sessions)
            mock_get.assert_called_once()
            # Clean up
            manager.sessions["cam-boot-1"].stop()



class TestVLMSecurity(unittest.TestCase):
    def test_reject_public_ip(self):
        with self.assertRaises(ValueError):
            resolve_and_pin_local_url("http://8.8.8.8:11434")

    def test_allow_local_services(self):
        url, headers = resolve_and_pin_local_url("http://vlm:11434")
        self.assertEqual(url, "http://vlm:11434")
        self.assertEqual(headers, {})

        url2, _ = resolve_and_pin_local_url("http://127.0.0.1:11434")
        self.assertEqual(url2, "http://127.0.0.1:11434")


if __name__ == "__main__":
    unittest.main()
