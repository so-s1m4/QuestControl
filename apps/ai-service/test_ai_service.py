from datetime import datetime, timezone
import hashlib
import io
import json
import multiprocessing
import os
import shutil
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from PIL import Image

_AI_SERVICE_DIR = str(Path(__file__).resolve().parent)
if _AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, _AI_SERVICE_DIR)

# Set dummy environment variables for tests
os.environ["INTERNAL_API_SECRET"] = "test-internal-secret-1234567890123456"
os.environ["MAX_PARALLEL_INFERENCE"] = "2"

from receiver import CameraStreamSession, StreamWorkerManager, certificate_digest_from_der
from server import AIServiceHandler, dataset_frame_rejection_reason
from vlm import resolve_and_pin_local_url


def _mp_lock_worker(lock_path_str, start_event, release_event, out_queue):
    import sys
    from pathlib import Path
    scripts_dir = str(Path(__file__).resolve().parent / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from dataset_pipeline import PipelineJobLock
    lock = PipelineJobLock(lock_path_str)
    try:
        lock.acquire("training", "worker_process")
        out_queue.put("ACQUIRED")
        start_event.set()
        release_event.wait(timeout=5)
        lock.release()
        out_queue.put("RELEASED")
    except Exception as e:
        out_queue.put(f"ERROR: {e}")



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


class TestDatasetFrameQualityGate(unittest.TestCase):
    def test_rejects_black_loading_placeholder(self):
        buf = io.BytesIO()
        Image.new("RGB", (1920, 1080), color=(0, 0, 0)).save(buf, format="JPEG")
        reason = dataset_frame_rejection_reason(buf.getvalue())
        self.assertIn("FRAME_NOT_READY", reason)

    def test_accepts_usable_camera_frame(self):
        image = Image.new("L", (320, 240), color=28)
        for x in range(80, 240):
            for y in range(60, 180):
                image.putpixel((x, y), 180)
        buf = io.BytesIO()
        image.convert("RGB").save(buf, format="JPEG")
        self.assertIsNone(dataset_frame_rejection_reason(buf.getvalue()))


class TestTuyaDtlsCompatibility(unittest.TestCase):
    def test_der_fingerprint_uses_sdp_colon_format(self):
        self.assertEqual(
            certificate_digest_from_der(b"tuya-certificate-der", "sha-256"),
            "33:82:64:94:92:94:AB:E1:6A:96:D4:68:52:36:DF:C4:98:85:F0:E7:15:74:5E:77:AC:C4:44:23:7C:19:5D:ED",
        )

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
    def test_hls_loading_placeholder_never_enters_worker_frame_buffer(self):
        session = CameraStreamSession(
            camera_id="cam-hls-placeholder",
            provider="TUYA",
            config={},
            api_url="http://api:3000",
        )
        session.transport = "HLS_FALLBACK"
        black = io.BytesIO()
        Image.new("RGB", (1920, 1080), color=(0, 0, 0)).save(black, format="JPEG")

        session._process_frame_bytes(black.getvalue())

        self.assertEqual(session.last_error, "FRAME_NOT_READY")
        self.assertEqual(len(session.frame_buffer), 0)
        self.assertEqual(session.last_frame_time, 0.0)

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

    @patch("receiver.AIORTC_AVAILABLE", True)
    def test_tuya_worker_uses_hls_after_background_webrtc_failure(self):
        session = CameraStreamSession(
            camera_id="cam-tuya-fallback",
            provider="TUYA",
            config={"tuya_ai_hls_fallback": True},
            api_url="http://api:3000",
        )
        session.running = True

        def stop_after_hls():
            session.last_frame_time = time.time()
            session.running = False

        with patch.object(session, "_run_webrtc_stream", return_value=False) as webrtc, \
             patch.object(session, "_run_capture_stream", side_effect=stop_after_hls) as hls:
            session._worker_loop()

        webrtc.assert_called_once()
        hls.assert_called_once()
        self.assertEqual(session.transport, "HLS_FALLBACK")

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


class TestHeadsetDetectionAndMoving(unittest.TestCase):
    def _create_real_jpeg_bytes(self, width: int = 640, height: int = 480) -> bytes:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (width, height), color=(40, 45, 55))
        draw = ImageDraw.Draw(img)
        # Draw mock headsets on table / floor
        draw.rectangle([100, 100, 220, 180], fill=(20, 20, 20), outline=(255, 255, 255))
        draw.rectangle([400, 300, 520, 380], fill=(15, 15, 15), outline=(200, 200, 200))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    def test_run_headset_detection_test_bboxes(self):
        from server import run_headset_detection
        test_bboxes = [
            {"confidence": 0.94, "bbox": {"x": 0.1, "y": 0.1, "width": 0.15, "height": 0.15}},
            {"confidence": 0.88, "bbox": {"x": 0.7, "y": 0.7, "width": 0.2, "height": 0.2}},
        ]
        res = run_headset_detection(b"", "cam-vr-test", conf_threshold=0.4, test_headsets=test_bboxes)
        self.assertEqual(res["cameraId"], "cam-vr-test")
        self.assertEqual(res["headsetCount"], 2)
        self.assertEqual(len(res["headsets"]), 2)
        self.assertEqual(res["headsets"][0]["confidence"], 0.94)

    def test_people_detection_ignores_confidence_at_or_below_85_percent(self):
        import server
        jpeg_bytes = self._create_real_jpeg_bytes()

        at_threshold = MagicMock()
        at_threshold.xyxy = [[100.0, 100.0, 220.0, 400.0]]
        at_threshold.conf = [0.85]
        at_threshold.id = [1]
        above_threshold = MagicMock()
        above_threshold.xyxy = [[300.0, 100.0, 420.0, 400.0]]
        above_threshold.conf = [0.851]
        above_threshold.id = [2]
        result = MagicMock()
        result.boxes = [at_threshold, above_threshold]
        mock_model = MagicMock()
        mock_model.track.return_value = [result]

        original_model, original_available = server.YOLO_MODEL, server.YOLO_AVAILABLE
        try:
            server.YOLO_MODEL, server.YOLO_AVAILABLE = mock_model, True
            detected = server.run_yolo_detection(jpeg_bytes, "cam-people", conf_threshold=0.25)
            self.assertEqual(detected["peopleCount"], 1)
            self.assertEqual(detected["people"][0]["trackId"], 2)
            self.assertEqual(detected["people"][0]["confidence"], 0.851)
            self.assertEqual(mock_model.track.call_args.kwargs["conf"], 0.85)
        finally:
            server.YOLO_MODEL, server.YOLO_AVAILABLE = original_model, original_available

    def test_run_headset_detection_real_jpeg_inference_pipeline(self):
        import server
        from server import run_headset_detection
        jpeg_bytes = self._create_real_jpeg_bytes(640, 480)

        # Mock Ultralytics YOLO Results structure to test the full image parsing, coordinate normalization, and class parsing
        mock_box1 = MagicMock()
        mock_box1.xyxy = [[100.0, 100.0, 220.0, 180.0]]
        mock_box1.conf = [0.93]
        mock_box1.cls = [0]

        mock_box2 = MagicMock()
        mock_box2.xyxy = [[400.0, 300.0, 520.0, 380.0]]
        mock_box2.conf = [0.87]
        mock_box2.cls = [0]

        mock_result = MagicMock()
        mock_result.boxes = [mock_box1, mock_box2]
        mock_result.names = {0: "vr_headset"}

        mock_model = MagicMock(return_value=[mock_result])

        # Temporarily enable YOLO_AVAILABLE
        orig_yolo_avail = server.YOLO_AVAILABLE
        orig_yolo_model = server.YOLO_MODEL
        orig_headset_model = server.HEADSET_MODEL
        orig_headset_status = server.HEADSET_MODEL_STATUS
        try:
            server.YOLO_AVAILABLE = True
            server.HEADSET_MODEL = mock_model
            server.HEADSET_MODEL_STATUS = "READY"

            # Test inference on real JPEG frame
            res = run_headset_detection(jpeg_bytes, "cam-vr-real-jpeg", conf_threshold=0.4)

            self.assertEqual(res["cameraId"], "cam-vr-real-jpeg")
            self.assertEqual(res["headsetCount"], 2)
            self.assertEqual(len(res["headsets"]), 2)

            h1 = res["headsets"][0]
            self.assertEqual(h1["confidence"], 0.93)
            self.assertEqual(h1["className"], "vr_headset")
            # Verify coordinates normalized to [0.0, 1.0]
            self.assertAlmostEqual(h1["bbox"]["x"], round(100.0 / 640.0, 4), places=3)
            self.assertAlmostEqual(h1["bbox"]["y"], round(100.0 / 480.0, 4), places=3)
            self.assertAlmostEqual(h1["bbox"]["width"], round(120.0 / 640.0, 4), places=3)
            self.assertAlmostEqual(h1["bbox"]["height"], round(80.0 / 480.0, 4), places=3)

            # Assert mock model was called with valid PIL image
            mock_model.assert_called_once()
            called_img = mock_model.call_args[0][0]
            self.assertEqual(called_img.size, (640, 480))
        finally:
            server.YOLO_AVAILABLE = orig_yolo_avail
            server.YOLO_MODEL = orig_yolo_model
            server.HEADSET_MODEL = orig_headset_model
            server.HEADSET_MODEL_STATUS = orig_headset_status

    def test_no_name_error_when_yolo_available(self):
        """Regression test for NameError: name 'yolo_model' is not defined"""
        import server
        from server import run_headset_detection
        jpeg_bytes = self._create_real_jpeg_bytes(320, 240)

        mock_result = MagicMock()
        mock_result.boxes = []
        mock_result.names = {}
        mock_model = MagicMock(return_value=[mock_result])

        orig_yolo_avail = server.YOLO_AVAILABLE
        orig_headset_model = server.HEADSET_MODEL
        orig_headset_status = server.HEADSET_MODEL_STATUS
        try:
            server.YOLO_AVAILABLE = True
            server.HEADSET_MODEL = mock_model
            server.HEADSET_MODEL_STATUS = "READY"

            # This must execute without raising NameError: name 'yolo_model' is not defined!
            res = run_headset_detection(jpeg_bytes, "cam-regression-test", conf_threshold=0.4)
            self.assertEqual(res["cameraId"], "cam-regression-test")
            self.assertEqual(res["headsetCount"], 0)
        finally:
            server.YOLO_AVAILABLE = orig_yolo_avail
            server.HEADSET_MODEL = orig_headset_model
            server.HEADSET_MODEL_STATUS = orig_headset_status

    def test_coco_classes_filtering_separates_person_from_headset(self):
        """Ensures that general COCO classes (like person) are not misclassified as headsets unless filtered"""
        import server
        from server import run_headset_detection
        jpeg_bytes = self._create_real_jpeg_bytes(640, 480)

        mock_box_person = MagicMock()
        mock_box_person.xyxy = [[50.0, 50.0, 150.0, 300.0]]
        mock_box_person.conf = [0.95]
        mock_box_person.cls = [0]  # person

        mock_box_headset = MagicMock()
        mock_box_headset.xyxy = [[300.0, 300.0, 400.0, 360.0]]
        mock_box_headset.conf = [0.89]
        mock_box_headset.cls = [1]  # headset

        mock_result = MagicMock()
        mock_result.boxes = [mock_box_person, mock_box_headset]
        mock_result.names = {0: "person", 1: "vr headset"}

        mock_model = MagicMock(return_value=[mock_result])

        orig_yolo_avail = server.YOLO_AVAILABLE
        orig_yolo_model = server.YOLO_MODEL
        orig_headset_model = server.HEADSET_MODEL
        orig_headset_status = server.HEADSET_MODEL_STATUS
        try:
            server.YOLO_AVAILABLE = True
            server.HEADSET_MODEL = mock_model
            server.HEADSET_MODEL_STATUS = "READY"

            res = run_headset_detection(jpeg_bytes, "cam-filter-test", conf_threshold=0.4)
            # Only the headset class should be recognized, not the person!
            self.assertEqual(res["headsetCount"], 1)
            self.assertEqual(res["headsets"][0]["className"], "vr headset")
        finally:
            server.YOLO_AVAILABLE = orig_yolo_avail
            server.YOLO_MODEL = orig_yolo_model
            server.HEADSET_MODEL = orig_headset_model
            server.HEADSET_MODEL_STATUS = orig_headset_status

    def test_handle_detect_headsets_raw_jpeg_endpoint(self):
        """Tests the HTTP endpoint handle_detect_headsets receiving a raw JPEG byte payload"""
        from server import AIServiceHandler
        jpeg_bytes = self._create_real_jpeg_bytes(320, 240)

        handler = MagicMock()
        handler.headers = {
            "Content-Type": "image/jpeg",
            "X-Camera-Id": "cam-http-jpeg",
            "X-Test-Headset-Bboxes": json.dumps([
                {"confidence": 0.91, "bbox": {"x": 0.2, "y": 0.3, "width": 0.1, "height": 0.1}}
            ]),
        }
        handler._send_json = MagicMock()

        AIServiceHandler.handle_detect_headsets(handler, jpeg_bytes)

        handler._send_json.assert_called_once()
        status_code = handler._send_json.call_args[0][0]
        payload = handler._send_json.call_args[0][1]
        self.assertEqual(status_code, 200)
        self.assertEqual(payload["cameraId"], "cam-http-jpeg")
        self.assertEqual(payload["headsetCount"], 1)

    def test_camera_stream_session_moving_pauses_detection(self):
        session = CameraStreamSession(
            camera_id="cam-moving-test",
            provider="TUYA",
            config={"headset_tracking_enabled": True},
            api_url="http://api:3000",
        )
        mock_detect = MagicMock()
        mock_headset_detect = MagicMock()
        session.detection_fn = mock_detect
        session.headset_detection_fn = mock_headset_detect

        # Set moving = True
        session.is_moving = True
        session._process_frame_bytes(b"some-frame-bytes")

        # Must skip detection while moving
        mock_detect.assert_not_called()
        mock_headset_detect.assert_not_called()

        # Set moving = False
        session.is_moving = False
        with patch("requests.post") as mock_post:
            mock_detect.return_value = {"people": []}
            mock_headset_detect.return_value = {"headsets": []}
            session._process_frame_bytes(b"some-frame-bytes")
            mock_detect.assert_called_once()
            mock_headset_detect.assert_called_once()

        session.stop()

    def test_model_unavailable_when_weights_missing(self):
        """Verifies that run_headset_detection returns MODEL_UNAVAILABLE when model weights are not loaded"""
        import server
        orig_headset_model = server.HEADSET_MODEL
        try:
            server.HEADSET_MODEL = None
            jpeg_bytes = self._create_real_jpeg_bytes(320, 240)
            res = server.run_headset_detection(jpeg_bytes, "cam-no-weights")
            self.assertEqual(res["status"], "MODEL_UNAVAILABLE")
            self.assertEqual(res["headsetCount"], 0)
            self.assertEqual(res["headsets"], [])
            self.assertIn("MODEL_UNAVAILABLE", res.get("error", ""))
        finally:
            server.HEADSET_MODEL = orig_headset_model

    def test_provision_integrity_checker_missing_file(self):
        """Verifies that provision_headset_model integrity check fails gracefully when weights are missing"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from provision_headset_model import check_model_integrity

        missing_path = Path("/tmp/non_existent_vr_headset.pt")
        ready, status = check_model_integrity(missing_path, Path("/tmp/non_existent_meta.json"))
        self.assertFalse(ready)
        self.assertIn("MODEL_UNAVAILABLE", status)

    def test_session_split_validation_detects_leakage(self):
        """Verifies that train_headset_model validate_session_splits detects cross-split session leakage"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from train_headset_model import validate_session_splits
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            train_dir = tmp_path / "images" / "train"
            val_dir = tmp_path / "images" / "val"
            train_dir.mkdir(parents=True)
            val_dir.mkdir(parents=True)

            # Create frames belonging to the same session cam01_sess01
            (train_dir / "cam01_sess01_f01.jpg").touch()
            (val_dir / "cam01_sess01_f02.jpg").touch()

            with self.assertRaises(ValueError) as ctx:
                validate_session_splits(tmp_path, smoke_test_files=set())
            self.assertIn("DATASET LEAKAGE", str(ctx.exception))

    def test_session_split_validation_rejects_smoke_test_in_training(self):
        """Verifies that smoke test frames cannot be placed into the training split"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from train_headset_model import validate_session_splits
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            train_dir = tmp_path / "images" / "train"
            train_dir.mkdir(parents=True)

            (train_dir / "frame_charging_base.jpg").touch()

            with self.assertRaises(ValueError) as ctx:
                validate_session_splits(tmp_path, smoke_test_files={"frame_charging_base.jpg"})
            self.assertIn("CRITICAL LEAKAGE: Smoke test frame", str(ctx.exception))

    def test_train_pipeline_halts_on_empty_dataset(self):
        """Verifies that train_headset_model validate_session_splits halts with DATASET_EMPTY when train set is empty"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from train_headset_model import validate_session_splits
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            (tmp_path / "images" / "train").mkdir(parents=True)
            with self.assertRaises(ValueError) as ctx:
                validate_session_splits(tmp_path, smoke_test_files=set())
            self.assertIn("DATASET_EMPTY", str(ctx.exception))

    def test_synthetic_fixture_jpeg_decoding(self):
        """Validates that synthetic JPEG frame fixtures decode cleanly into PIL images for geometric format tests"""
        from PIL import Image
        jpeg_bytes = self._create_real_jpeg_bytes(1280, 720)
        img = Image.open(io.BytesIO(jpeg_bytes))
        self.assertEqual(img.size, (1280, 720))
        self.assertEqual(img.format, "JPEG")


class TestModelValidatorStrictOffline(unittest.TestCase):
    def test_prevent_ultralytics_network_downloads_installs_guards(self):
        """Verifies that attempt_download_asset and download raise RuntimeError when invoked"""
        from model_validator import prevent_ultralytics_network_downloads
        prevent_ultralytics_network_downloads()
        try:
            import ultralytics.utils.downloads as u_downloads
            with self.assertRaises(RuntimeError) as ctx:
                u_downloads.attempt_download_asset("some_remote_model.pt")
            self.assertIn("AIR-GAPPED OFFLINE VIOLATION", str(ctx.exception))
        except (ImportError, AttributeError):
            pass

    def test_load_general_yolo_missing_file_skips_download(self):
        """Verifies that load_general_yolo_model returns None, False when file is absent, making 0 network requests"""
        from model_validator import load_general_yolo_model
        model, available, err = load_general_yolo_model("/tmp/definitely_not_existing_yolo_model.pt")
        self.assertIsNone(model)
        self.assertFalse(available)
        self.assertIn("not found", err.lower())

    def test_load_general_yolo_checksum_mismatch(self):
        """Verifies that load_general_yolo_model rejects weights with mismatched checksum"""
        from model_validator import load_general_yolo_model
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as f:
            f.write(b"fake-general-weights")
            f_path = f.name
        try:
            model, available, err = load_general_yolo_model(f_path, expected_sha256="wrong-sha256")
            self.assertIsNone(model)
            self.assertFalse(available)
            self.assertIn("checksum mismatch", err.lower())
        finally:
            if os.path.exists(f_path):
                os.unlink(f_path)


class TestVRHeadsetStartupValidation(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmpdir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.tmpdir.name)
        self.model_path = self.base_dir / "vr_headset_yolo.pt"
        self.metadata_path = self.base_dir / "model_metadata.json"

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_model_and_metadata(self, model_content=b"dummy-model-binary-weights-12345", metadata_dict=None, raw=False):
        with open(self.model_path, "wb") as f:
            f.write(model_content)

        if metadata_dict is not None:
            if not raw:
                full_meta = {
                    "datasetVersion": "v1.0.0",
                    "datasetManifestHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "validatedSplit": "test",
                }
                full_meta.update(metadata_dict)
            else:
                full_meta = metadata_dict
            with open(self.metadata_path, "w", encoding="utf-8") as f:
                json.dump(full_meta, f)

    def test_headset_validation_missing_weights_file(self):
        """Fails with MODEL_UNAVAILABLE if weights file is absent on disk"""
        from model_validator import validate_and_load_headset_model
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("Weights file not found on disk", res.error)

    def test_headset_validation_missing_metadata_file(self):
        """Fails with MODEL_UNAVAILABLE if metadata file is absent on disk"""
        from model_validator import validate_and_load_headset_model
        self.model_path.touch()
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("Metadata file not found on disk", res.error)

    def test_headset_validation_corrupt_metadata_json(self):
        """Fails with MODEL_UNAVAILABLE if metadata JSON is malformed syntax"""
        from model_validator import validate_and_load_headset_model
        self.model_path.touch()
        with open(self.metadata_path, "w") as f:
            f.write("{invalid_json: true, broken")
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("corrupt or invalid JSON", res.error)

    def test_headset_validation_metadata_not_a_dict(self):
        """Fails with MODEL_UNAVAILABLE if metadata root is a list rather than an object"""
        from model_validator import validate_and_load_headset_model
        self.model_path.touch()
        with open(self.metadata_path, "w") as f:
            json.dump(["item1", "item2"], f)
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("Metadata root must be a JSON object", res.error)

    def test_headset_validation_missing_sha256(self):
        """Fails with MODEL_UNAVAILABLE if metadata lacks required sha256 field"""
        from model_validator import validate_and_load_headset_model
        self._write_model_and_metadata(metadata_dict={"modelName": "test.pt"}, raw=True)
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("missing required 'sha256'", res.error)

    def test_headset_validation_sha256_mismatch(self):
        """Fails with MODEL_UNAVAILABLE if sha256 of weights does not match metadata"""
        from model_validator import validate_and_load_headset_model
        self._write_model_and_metadata(metadata_dict={"sha256": "0000000000000000000000000000000000000000000000000000000000000000"})
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("SHA-256 checksum mismatch", res.error)

    def test_headset_validation_missing_validation_metrics(self):
        """Fails with MODEL_UNAVAILABLE if validationMetrics is omitted from metadata"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(model_content=content, metadata_dict={"sha256": sha})
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("missing required 'validationMetrics'", res.error)

    def test_headset_validation_sub_threshold_map50(self):
        """Fails with MODEL_UNAVAILABLE if mAP50 < 0.85"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validationMetrics": {"mAP50": 0.72, "precision": 0.85, "recall": 0.82},
            },
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("mAP50 (0.7200) below required threshold", res.error)

    def test_headset_validation_sub_threshold_precision(self):
        """Fails with MODEL_UNAVAILABLE if precision < 0.80"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validationMetrics": {"mAP50": 0.88, "precision": 0.74, "recall": 0.82},
            },
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("precision (0.7400) below required threshold", res.error)

    def test_headset_validation_sub_threshold_recall(self):
        """Fails with MODEL_UNAVAILABLE if recall < 0.80"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validationMetrics": {"mAP50": 0.88, "precision": 0.84, "recall": 0.76},
            },
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("recall (0.7600) below required threshold", res.error)

    def test_headset_validation_wrong_class_not_headset(self):
        """Fails with MODEL_UNAVAILABLE if model class 0 is person instead of vr_headset"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validationMetrics": {"mAP50": 0.88, "precision": 0.84, "recall": 0.82},
            },
        )
        mock_model = MagicMock()
        mock_model.names = {0: "person", 1: "bicycle"}
        res = validate_and_load_headset_model(
            model_path=self.model_path,
            metadata_path=self.metadata_path,
            model_loader_fn=lambda p: mock_model,
        )
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("expected 'vr_headset' or 'headset'", res.error)

    def test_headset_validation_forward_pass_failure(self):
        """Fails with MODEL_UNAVAILABLE if test forward pass raises an exception"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validationMetrics": {"mAP50": 0.88, "precision": 0.84, "recall": 0.82},
            },
        )
        mock_model = MagicMock()
        mock_model.names = {0: "vr_headset"}
        mock_model.side_effect = RuntimeError("Forward pass CUDA out of memory or corrupt graph")
        res = validate_and_load_headset_model(
            model_path=self.model_path,
            metadata_path=self.metadata_path,
            model_loader_fn=lambda p: mock_model,
        )
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("forward pass dry-run failed", res.error.lower())

    def test_headset_validation_all_checks_pass_ready(self):
        """Succeeds with status READY when checksum, class, quality metrics, and forward pass all pass"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test-content-54321"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "modelName": "vr_headset_yolo.pt",
                "sha256": sha,
                "classes": ["vr_headset"],
                "validationMetrics": {"mAP50": 0.892, "precision": 0.845, "recall": 0.831},
            },
        )
        mock_model = MagicMock()
        mock_model.names = {0: "vr_headset"}
        mock_model.return_value = []
        res = validate_and_load_headset_model(
            model_path=self.model_path,
            metadata_path=self.metadata_path,
            model_loader_fn=lambda p: mock_model,
        )
        self.assertTrue(res.is_valid)
        self.assertEqual(res.status, "READY")
        self.assertIsNone(res.error)
        self.assertEqual(res.model, mock_model)
        self.assertEqual(res.metrics["mAP50"], 0.892)

    def test_server_health_endpoint_reports_model_unavailable_and_error(self):
        """Verifies that GET /health reflects MODEL_UNAVAILABLE status and exact error reason"""
        import server
        orig_status = server.HEADSET_MODEL_STATUS
        orig_error = server.HEADSET_MODEL_ERROR
        try:
            server.HEADSET_MODEL_STATUS = "MODEL_UNAVAILABLE"
            server.HEADSET_MODEL_ERROR = "Weights file not found on disk"
            handler = MagicMock()
            handler.path = "/health"
            handler._send_json = MagicMock()
            server.AIServiceHandler.do_GET(handler)
            handler._send_json.assert_called_once()
            args, kwargs = handler._send_json.call_args
            self.assertEqual(args[0], 200)
            self.assertEqual(args[1]["headsetModelStatus"], "MODEL_UNAVAILABLE")
            self.assertEqual(args[1]["headsetModelError"], "Weights file not found on disk")
        finally:
            server.HEADSET_MODEL_STATUS = orig_status
            server.HEADSET_MODEL_ERROR = orig_error


    def test_headset_validation_missing_dataset_version(self):
        """Fails with MODEL_UNAVAILABLE if datasetVersion is omitted from metadata"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={"sha256": sha, "datasetManifestHash": "abc", "validatedSplit": "test"},
            raw=True,
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("missing required 'datasetVersion'", res.error)

    def test_headset_validation_missing_dataset_manifest_hash(self):
        """Fails with MODEL_UNAVAILABLE if datasetManifestHash is omitted from metadata"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={"sha256": sha, "datasetVersion": "v1.0.0", "validatedSplit": "test"},
            raw=True,
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("missing required 'datasetManifestHash'", res.error)

    def test_headset_validation_rejects_val_split_for_production(self):
        """Fails with MODEL_UNAVAILABLE if validatedSplit is 'val' instead of 'test'"""
        import hashlib
        from model_validator import validate_and_load_headset_model
        content = b"valid-weights-test"
        sha = hashlib.sha256(content).hexdigest()
        self._write_model_and_metadata(
            model_content=content,
            metadata_dict={
                "sha256": sha,
                "validatedSplit": "val",
                "validationMetrics": {"mAP50": 0.90, "precision": 0.85, "recall": 0.85},
            },
        )
        res = validate_and_load_headset_model(model_path=self.model_path, metadata_path=self.metadata_path)
        self.assertFalse(res.is_valid)
        self.assertEqual(res.status, "MODEL_UNAVAILABLE")
        self.assertIn("strictly requires validatedSplit='test'", res.error)

    def test_run_yolo_detection_model_unavailable_when_weights_missing(self):
        """Verifies that run_yolo_detection returns status: MODEL_UNAVAILABLE when general weights missing"""
        import server
        from PIL import Image
        orig_avail = server.YOLO_AVAILABLE
        orig_model = server.YOLO_MODEL
        try:
            server.YOLO_AVAILABLE = False
            server.YOLO_MODEL = None
            buf = io.BytesIO()
            Image.new("RGB", (320, 240), color=(100, 100, 100)).save(buf, format="JPEG")
            jpeg_bytes = buf.getvalue()
            res = server.run_yolo_detection(jpeg_bytes, "cam-yolo-unavailable")
            self.assertEqual(res["status"], "MODEL_UNAVAILABLE")
            self.assertEqual(res["peopleCount"], 0)
            self.assertEqual(res["people"], [])
            self.assertIn("MODEL_UNAVAILABLE", res.get("error", ""))
        finally:
            server.YOLO_AVAILABLE = orig_avail
            server.YOLO_MODEL = orig_model

    def test_validate_headset_model_enforce_quality_gates_rejects_val_split(self):
        """Verifies that enforce_quality_gates raises ValueError when split != 'test'"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from validate_headset_model import enforce_quality_gates
        metrics = {"mAP50": 0.92, "precision": 0.88, "recall": 0.86}
        with self.assertRaises(ValueError) as ctx:
            enforce_quality_gates(metrics, split="val")
        self.assertIn("strictly requires --split test", str(ctx.exception))

    def test_train_headset_model_rejects_missing_base_model(self):
        """Verifies that train_model raises FileNotFoundError when base YOLO checkpoint is missing without downloading"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from train_headset_model import train_model
        with self.assertRaises(FileNotFoundError) as ctx:
            train_model(dataset_yaml=Path("/tmp/non_existent.yaml"), base_model="non_existent_base_model.pt")
        self.assertIn("not found on disk", str(ctx.exception))

    def test_docker_compose_files_use_absolute_model_paths(self):
        """Regression test ensuring docker-compose and docker-compose.portainer use /app/models/ and not bare relative yolo11n.pt"""
        root_dir = Path(__file__).resolve().parent.parent.parent
        dc_path = root_dir / "docker-compose.yml"
        dcp_path = root_dir / "docker-compose.portainer.yml"

        if not dc_path.is_file():
            self.skipTest("Host compose files not present in execution environment")

        for p in [dc_path, dcp_path]:
            with open(p, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertNotIn("YOLO_MODEL: yolo11n.pt", content, f"Bare relative YOLO_MODEL found in {p.name}")
            self.assertIn("YOLO_MODEL: /app/models/yolo11n.pt", content, f"Missing absolute /app/models/ in {p.name}")
            self.assertTrue(
                "/app/models/current/vr_headset_yolo.pt" in content or "/app/models/vr_headset_yolo.pt" in content,
                f"Missing absolute headset path in {p.name}"
            )

    def test_dockerfile_bake_general_yolo_halts_on_error(self):
        """Regression test verifying that Dockerfile BAKE_GENERAL_YOLO has set -e and no || (rm -f ... success) masking"""
        dockerfile_path = Path(__file__).resolve().parent / "Dockerfile"
        if not dockerfile_path.is_file():
            self.skipTest("Dockerfile not present in execution environment")
        with open(dockerfile_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("set -e;", content)
        self.assertNotIn("Skipping general model bake or checksum mismatch", content)

    def test_session_split_validation_rejects_val_test_leakage(self):
        """Verifies that validate_session_splits strictly forbids camera/session leakage between val and test splits"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from train_headset_model import validate_session_splits
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            train_dir = tmp_path / "images" / "train"
            val_dir = tmp_path / "images" / "val"
            test_dir = tmp_path / "images" / "test"
            train_dir.mkdir(parents=True)
            val_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)

            # Valid training frame from session cam01_sess01
            (train_dir / "cam01_sess01_f01.jpg").touch()

            # Cross-split leakage between val and test from session cam02_sess05
            (val_dir / "cam02_sess05_f01.jpg").touch()
            (test_dir / "cam02_sess05_f02.jpg").touch()

            with self.assertRaises(ValueError) as ctx:
                validate_session_splits(tmp_path, smoke_test_files=set())
            self.assertIn("DATASET LEAKAGE: Session 'cam02_sess05' has frames in both 'val' and 'test' splits!", str(ctx.exception))

    def test_compute_dataset_manifest_hash_detects_same_length_content_change(self):
        """Verifies that compute_dataset_manifest_hash hashes actual file contents, detecting changes even with identical length"""
        import tempfile
        import yaml
        from model_validator import compute_dataset_manifest_hash

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            yaml_path = tmp_path / "dataset.yaml"
            with open(yaml_path, "w", encoding="utf-8") as f:
                yaml.dump({"train": "images/train", "val": "images/val", "test": "images/test"}, f)

            test_labels_dir = tmp_path / "labels" / "test"
            test_labels_dir.mkdir(parents=True)
            label_file = test_labels_dir / "frame01.txt"

            # Content 1: box centered at 0.50, 0.50
            content1 = b"0 0.500000 0.500000 0.200000 0.200000\n"
            label_file.write_bytes(content1)
            hash1 = compute_dataset_manifest_hash(yaml_path, split="test")

            # Content 2: box shifted to 0.65, 0.75 - identical byte length!
            content2 = b"0 0.650000 0.750000 0.200000 0.200000\n"
            self.assertEqual(len(content1), len(content2), "Test requires exact same byte length to test content hashing vs size hashing")
            label_file.write_bytes(content2)
            hash2 = compute_dataset_manifest_hash(yaml_path, split="test")

            self.assertNotEqual(hash1, hash2, "Manifest hash must change when label file content changes, even if file size is identical!")

    def test_extract_dataset_frames_session_assignment(self):
        """Verifies that extract_dataset_frames assign_session_to_split correctly partitions sessions"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        from extract_dataset_frames import assign_session_to_split
        self.assertEqual(assign_session_to_split(0, 1), "train")
        self.assertEqual(assign_session_to_split(0, 2), "train")
        self.assertEqual(assign_session_to_split(1, 2), "val")
        # Multi-session round-robin
        self.assertEqual(assign_session_to_split(0, 6), "train")
        self.assertEqual(assign_session_to_split(1, 6), "train")
        self.assertEqual(assign_session_to_split(2, 6), "train")
        self.assertEqual(assign_session_to_split(3, 6), "train")
        self.assertEqual(assign_session_to_split(4, 6), "val")
        self.assertEqual(assign_session_to_split(5, 6), "test")

    def test_extract_frames_from_synthetic_video(self):
        """Tests that extract_frames_from_video produces correctly named frames without session leakage"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        import cv2
        import numpy as np
        import tempfile
        from extract_dataset_frames import extract_frames_from_video

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            video_file = tmp_path / "test_sess01.mp4"
            out_dir = tmp_path / "out"

            # Create a short 10-frame synthetic mp4 video
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(str(video_file), fourcc, 10.0, (640, 480))
            for i in range(10):
                frame = np.full((480, 640, 3), fill_value=i * 25, dtype=np.uint8)
                writer.write(frame)
            writer.release()

            extracted = extract_frames_from_video(
                video_path=video_file,
                output_dir=out_dir,
                camera_id="cam_main",
                session_id="sess03",
                preset="table",
                lighting="day",
                interval_sec=0.2,
                max_frames=5,
            )

            self.assertGreater(len(extracted), 0)
            first = extracted[0]
            self.assertTrue(first.exists())
            self.assertTrue(first.name.startswith("cam_main_sess03_table_day_f"))
            self.assertTrue(first.name.endswith(".jpg"))


class TestDatasetPipeline(unittest.TestCase):
    """
    Unit tests for dataset_pipeline.py:
    1. PTZ raw frame collection into data/raw/<camera_id>/
    2. Human verification queue and operator audit
    3. Room-level stratified train/val/test export without leakage
    4. Quality gate enforcement on holdout test split
    5. Atomic activation and rollback upon degradation
    """

    def setUp(self):
        import hashlib
        import tempfile
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.tmp_dir.name)
        self.data_dir = self.base_dir / "data"
        self.models_dir = self.base_dir / "models"
        self.dataset_dir = self.base_dir / "dataset"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.dataset_dir.mkdir(parents=True, exist_ok=True)
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))

    def tearDown(self):
        self.tmp_dir.cleanup()

    def _create_valid_dataset(self, target_dir=None, split_counts=None):
        from model_validator import compute_dataset_manifest_hash
        if target_dir is None:
            target_dir = self.dataset_dir
        if split_counts is None:
            split_counts = {"train": 1, "val": 1, "test": 1}
        target_dir = Path(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        rel_dir = target_dir / "releases" / "v1.0.0"
        rel_dir.mkdir(parents=True, exist_ok=True)
        yaml_path = rel_dir / "dataset.yaml"
        yaml_path.write_text(f"""names:
  0: vr_headset
path: .
train: images/train
val: images/val
test: images/test
""")
        samples = []
        for sp, count in split_counts.items():
            (rel_dir / "images" / sp).mkdir(parents=True, exist_ok=True)
            (rel_dir / "labels" / sp).mkdir(parents=True, exist_ok=True)
            for i in range(count):
                sid = f"sample_{sp}_{i}"
                img_file = rel_dir / "images" / sp / f"{sid}.jpg"
                lbl_file = rel_dir / "labels" / sp / f"{sid}.txt"
                img_file.write_bytes(
                    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb"
                    + f"_{sp}_{i}".encode("utf-8")
                )
                lbl_file.write_text("0 0.5 0.5 0.2 0.2\n")
                h_img = hashlib.sha256(img_file.read_bytes()).hexdigest()
                h_lbl = hashlib.sha256(lbl_file.read_bytes()).hexdigest()
                samples.append({
                    "sampleId": sid,
                    "split": sp,
                    "sha256": h_img,
                    "imageSha256": h_img,
                    "labelSha256": h_lbl,
                    "captureSessionId": f"sess_{sp}",
                    "cameraId": f"cam_{sp}",
                    "roomId": f"room_{sp}",
                    "presetName": "default",
                    "bboxes": [{"classId": 0, "x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}],
                })
        manifest_hash = compute_dataset_manifest_hash(yaml_path, split="all")
        manifest_data = {
            "version": "v1.0.0",
            "exportedAt": "2026-09-09T12:00:00Z",
            "manifestHash": manifest_hash,
            "splitCounts": split_counts,
            "totalSamples": len(samples),
            "sessionGroups": ["sess_train", "sess_val", "sess_test"],
            "samples": samples,
        }
        (rel_dir / "manifest.json").write_text(json.dumps(manifest_data, indent=2))
        curr_link = target_dir / "current"
        if curr_link.is_symlink() or curr_link.exists():
            curr_link.unlink()
        curr_link.symlink_to(Path("releases") / "v1.0.0")

        for sym_name in ("images", "labels", "manifest.json", "dataset.yaml"):
            top_p = target_dir / sym_name
            if not top_p.exists() and not top_p.is_symlink():
                try:
                    top_p.symlink_to(Path("current") / sym_name)
                except OSError:
                    pass
        return curr_link / "dataset.yaml"

    def test_collect_ptz_frame_and_sidecar(self):
        from dataset_pipeline import collect_ptz_frame
        raw_bytes = b"FAKE_PTZ_JPEG_PAYLOAD"
        img_p = collect_ptz_frame(
            camera_id="cam_room1",
            room_id="room_1",
            preset_name="Base_Left",
            image_bytes=raw_bytes,
            timestamp="20260909T100000Z",
            output_root=self.data_dir,
        )
        self.assertTrue(img_p.is_file())
        self.assertEqual(img_p.read_bytes(), raw_bytes)
        meta_p = img_p.with_suffix(".json")
        self.assertTrue(meta_p.is_file())
        with open(meta_p, "r", encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(meta["cameraId"], "cam_room1")
        self.assertEqual(meta["roomId"], "room_1")
        self.assertEqual(meta["presetName"], "Base_Left")
        self.assertEqual(meta["sha256"], hashlib.sha256(raw_bytes).hexdigest())

    def test_enqueue_and_verify_operator_audit(self):
        from dataset_pipeline import collect_ptz_frame, enqueue_for_verification, verify_sample
        raw_p = collect_ptz_frame(
            camera_id="cam_room1",
            room_id="room_1",
            preset_name="Base_Left",
            image_bytes=b"FRAME_SAMPLE_1",
            output_root=self.data_dir,
        )
        sample_id = enqueue_for_verification(raw_p, initial_bboxes=[{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}], queue_root=self.data_dir)
        self.assertTrue((self.data_dir / "verification_queue" / sample_id).is_dir())

        # Verify without operator ID should fail
        with self.assertRaises(ValueError):
            verify_sample(sample_id, operator_id="", queue_root=self.data_dir)

        # Operator approves
        success = verify_sample(
            sample_id,
            operator_id="operator_anna",
            approved=True,
            corrected_bboxes=[{"x": 0.12, "y": 0.12, "width": 0.18, "height": 0.18}],
            notes="Adjusted bbox bounds",
            queue_root=self.data_dir,
        )
        self.assertTrue(success)
        self.assertFalse((self.data_dir / "verification_queue" / sample_id).exists())
        self.assertTrue((self.data_dir / "verified" / sample_id).is_dir())

        with open(self.data_dir / "verified" / sample_id / "annotation.json") as f:
            anno = json.load(f)
        self.assertTrue(anno["verified"])
        self.assertTrue(anno["approved"])
        self.assertEqual(anno["operatorId"], "operator_anna")
        self.assertEqual(len(anno["bboxes"]), 1)
        self.assertEqual(anno["bboxes"][0]["x"], 0.12)

    def test_bbox_validation_rules(self):
        from dataset_pipeline import validate_bboxes

        # 1. Empty bboxes rejected without allow_empty
        errs = validate_bboxes([])
        self.assertTrue(any("No bounding boxes" in e for e in errs))

        # 2. Empty bboxes accepted with allow_empty=True (negative sample)
        errs_neg = validate_bboxes([], allow_empty=True)
        self.assertEqual(len(errs_neg), 0)

        # 3. ClassId != 0 rejected
        errs = validate_bboxes([{"classId": 1, "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}])
        self.assertTrue(any("classId must be 0" in e for e in errs))

        # 4. Non-finite coordinates rejected
        errs = validate_bboxes([{"classId": 0, "x": float("nan"), "y": 0.1, "width": 0.2, "height": 0.2}])
        self.assertTrue(any("not finite" in e for e in errs))

        # 5. Out of [0, 1] range rejected
        errs = validate_bboxes([{"classId": 0, "x": -0.1, "y": 0.1, "width": 0.2, "height": 0.2}])
        self.assertTrue(any("out of normalized" in e for e in errs))

        # 6. Width/height <= 0 rejected
        errs = validate_bboxes([{"classId": 0, "x": 0.1, "y": 0.1, "width": 0.0, "height": 0.2}])
        self.assertTrue(any("width must be > 0" in e for e in errs))

        # 7. Box extends outside bounds (x + width > 1.0) rejected
        errs = validate_bboxes([{"classId": 0, "x": 0.8, "y": 0.1, "width": 0.3, "height": 0.2}])
        self.assertTrue(any("outside horizontal bounds" in e for e in errs))

    def test_export_dataset_splits_fewer_than_3_sessions_fails_dataset_insufficient(self):
        from dataset_pipeline import collect_ptz_frame, enqueue_for_verification, export_dataset_splits, verify_sample

        # Create samples for only 2 sessions
        for sess in ("session_1", "session_2"):
            raw_p = collect_ptz_frame(
                camera_id="cam1",
                room_id="room_1",
                preset_name="angle1",
                image_bytes=f"IMG_{sess}".encode(),
                capture_session_id=sess,
                output_root=self.data_dir,
            )
            sid = enqueue_for_verification(raw_p, queue_root=self.data_dir)
            verify_sample(
                sid,
                operator_id="op1",
                approved=True,
                corrected_bboxes=[{"classId": 0, "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}],
                queue_root=self.data_dir,
            )

        with self.assertRaises(ValueError) as ctx:
            export_dataset_splits(output_dir=self.dataset_dir, data_root=self.data_dir)
        self.assertIn("DATASET_INSUFFICIENT", str(ctx.exception))

    def test_export_dataset_splits_no_sha_appears_in_multiple_splits(self):
        from dataset_pipeline import collect_ptz_frame, enqueue_for_verification, export_dataset_splits, verify_sample

        # Create samples across 3 distinct sessions
        sessions = ["session_A", "session_B", "session_C"]
        for sess in sessions:
            for i in range(2):
                raw_p = collect_ptz_frame(
                    camera_id="cam_main",
                    room_id="room_main",
                    preset_name=f"p_{i}",
                    image_bytes=f"FRAME_{sess}_{i}_{time.time()}".encode(),
                    capture_session_id=sess,
                    output_root=self.data_dir,
                )
                sid = enqueue_for_verification(raw_p, queue_root=self.data_dir)
                verify_sample(
                    sid,
                    operator_id="operator_main",
                    approved=True,
                    corrected_bboxes=[{"classId": 0, "x": 0.2, "y": 0.2, "width": 0.3, "height": 0.3}],
                    queue_root=self.data_dir,
                )

        summary = export_dataset_splits(
            output_dir=self.dataset_dir,
            data_root=self.data_dir,
            version="v1.2.0",
        )
        self.assertEqual(summary["version"], "v1.2.0")
        active_dir = self.dataset_dir / "current"
        self.assertTrue((active_dir / "dataset.yaml").is_file())

        # Collect image SHA256 across all splits
        split_shas = {}
        for split in ("train", "val", "test"):
            img_dir = active_dir / "images" / split
            self.assertTrue(img_dir.is_dir())
            files = list(img_dir.glob("*.jpg"))
            self.assertGreater(len(files), 0, f"Split '{split}' must be non-empty")
            split_shas[split] = {hashlib.sha256(f.read_bytes()).hexdigest() for f in files}

        # Assert no SHA appears in multiple splits (strictly disjoint sets!)
        self.assertEqual(split_shas["train"] & split_shas["val"], set(), "Train and val must have 0 shared SHAs")
        self.assertEqual(split_shas["train"] & split_shas["test"], set(), "Train and test must have 0 shared SHAs")
        self.assertEqual(split_shas["val"] & split_shas["test"], set(), "Val and test must have 0 shared SHAs")

    def test_evaluate_quality_gate_metrics_come_from_val_mock_yolo(self):
        from dataset_pipeline import evaluate_quality_gate

        cand_weights = self.base_dir / "candidate.pt"
        cand_weights.write_bytes(b"CANDIDATE_MOCK_YOLO_BIN")

        yaml_p = self._create_valid_dataset()

        # Mock YOLO with val() returning custom metrics
        class MockValYOLO:
            def __init__(self, weights_path):
                self.weights_path = weights_path

            def val(self, data, split="test", verbose=False):
                res = MagicMock()
                res.results_dict = {
                    "metrics/mAP50(B)": 0.888,
                    "metrics/precision(B)": 0.842,
                    "metrics/recall(B)": 0.826,
                }
                return res

        ok, metrics, err = evaluate_quality_gate(
            cand_weights, yaml_p, split="test", yolo_factory=MockValYOLO
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        # Verify metrics came directly from val(), not hardcoded values
        self.assertEqual(metrics["mAP50"], 0.888)
        self.assertEqual(metrics["precision"], 0.842)
        self.assertEqual(metrics["recall"], 0.826)

        # Failing metrics
        class MockFailingValYOLO:
            def __init__(self, weights_path):
                pass
            def val(self, **kwargs):
                res = MagicMock()
                res.results_dict = {"mAP50": 0.60, "precision": 0.50, "recall": 0.50}
                return res

        fail_ok, fail_metrics, fail_err = evaluate_quality_gate(
            cand_weights, yaml_p, split="test", yolo_factory=MockFailingValYOLO
        )
        self.assertFalse(fail_ok)
        self.assertIn("Quality gate failed", fail_err)

    def test_atomic_activation_preserves_old_model_on_failure_and_rejects_random_bytes_mock_yolo(self):
        from dataset_pipeline import activate_candidate_model

        yaml_p = self._create_valid_dataset()

        self.models_dir.mkdir(parents=True, exist_ok=True)
        golden_rel = self.models_dir / "releases" / "golden_v1"
        golden_rel.mkdir(parents=True, exist_ok=True)
        (golden_rel / "vr_headset_yolo.pt").write_bytes(b"GOLDEN_ACTIVE_MODEL_PRESERVED")
        (golden_rel / "model_metadata.json").write_text(json.dumps({"modelName": "vr_headset_yolo", "sha256": "golden"}))
        (self.models_dir / "current").symlink_to("releases/golden_v1")
        active_model = self.models_dir / "current" / "vr_headset_yolo.pt"

        def mock_passing_gate(**kwargs):
            return True, {"mAP50": 0.89, "precision": 0.85, "recall": 0.82}, None

        def mock_failing_gate(**kwargs):
            return False, {"mAP50": 0.70, "precision": 0.60, "recall": 0.60}, "Quality gate failed: mAP50 too low"

        # 1. Candidate with random junk bytes rejected by YOLO instantiation
        cand_corrupt = self.base_dir / "corrupt_candidate.pt"
        cand_corrupt.write_bytes(b"CORRUPT_RANDOM_BYTES_NOT_A_VALID_MODEL")

        class MockCorruptYOLO:
            def __init__(self, p):
                raise RuntimeError("Invalid YOLO format: corrupt header")

        with self.assertRaises(ValueError) as ctx:
            activate_candidate_model(
                candidate_model_path=cand_corrupt,
                dataset_yaml=yaml_p,
                models_dir=self.models_dir,
                yolo_factory=MockCorruptYOLO,
                _eval_gate_fn=mock_passing_gate,
            )
        self.assertIn("failed YOLO instantiation", str(ctx.exception))
        # Active golden model must remain COMPLETELY UNCHANGED
        self.assertEqual(active_model.read_bytes(), b"GOLDEN_ACTIVE_MODEL_PRESERVED")

        # 2. Candidate with wrong class (e.g. 'person') rejected
        cand_wrong_class = self.base_dir / "wrong_class_candidate.pt"
        cand_wrong_class.write_bytes(b"VALID_BYTES_BUT_WRONG_CLASS")

        class MockWrongClassYOLO:
            def __init__(self, p):
                self.names = {0: "person"}
            def __call__(self, img, verbose=False):
                return []

        with self.assertRaises(ValueError) as ctx:
            activate_candidate_model(
                candidate_model_path=cand_wrong_class,
                dataset_yaml=yaml_p,
                models_dir=self.models_dir,
                yolo_factory=MockWrongClassYOLO,
                _eval_gate_fn=mock_passing_gate,
            )
        self.assertIn("expected 'vr_headset'", str(ctx.exception))
        self.assertEqual(active_model.read_bytes(), b"GOLDEN_ACTIVE_MODEL_PRESERVED")

        # 3. Candidate with failing metrics rejected before touching files
        with self.assertRaises(ValueError) as ctx:
            activate_candidate_model(
                candidate_model_path=cand_wrong_class,
                dataset_yaml=yaml_p,
                models_dir=self.models_dir,
                _eval_gate_fn=mock_failing_gate,
            )
        self.assertIn("failed quality gate", str(ctx.exception))
        self.assertEqual(active_model.read_bytes(), b"GOLDEN_ACTIVE_MODEL_PRESERVED")

    def test_atomic_activation_and_rollback_success_mock_yolo(self):
        from dataset_pipeline import activate_candidate_model, rollback_model

        yaml_p = self._create_valid_dataset()

        self.models_dir.mkdir(parents=True, exist_ok=True)
        current_model = self.models_dir / "current" / "vr_headset_yolo.pt"

        def mock_passing_gate_1(**kwargs):
            return True, {"mAP50": 0.89, "precision": 0.85, "recall": 0.82}, None

        def mock_passing_gate_2(**kwargs):
            return True, {"mAP50": 0.91, "precision": 0.88, "recall": 0.85}, None

        # Mock valid YOLO
        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        cand1 = self.base_dir / "candidate_1.pt"
        cand1.write_bytes(b"MODEL_VERSION_1_WEIGHTS")

        # First activation
        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="operator_alex",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_passing_gate_1,
        )
        self.assertEqual(res1["status"], "ACTIVATED")
        self.assertEqual(current_model.read_bytes(), b"MODEL_VERSION_1_WEIGHTS")

        # Second activation (backs up v1 to models/previous)
        cand2 = self.base_dir / "candidate_2.pt"
        cand2.write_bytes(b"MODEL_VERSION_2_WEIGHTS")
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v1.0.1",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="operator_alex",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_passing_gate_2,
        )
        self.assertEqual(res2["status"], "ACTIVATED")
        self.assertEqual(current_model.read_bytes(), b"MODEL_VERSION_2_WEIGHTS")
        self.assertTrue((self.models_dir / "previous" / "vr_headset_yolo.pt").is_file())
        self.assertEqual((self.models_dir / "previous" / "vr_headset_yolo.pt").read_bytes(), b"MODEL_VERSION_1_WEIGHTS")

        # Rollback restores v1 pointer
        rb_ok = rollback_model(models_dir=self.models_dir, operator_id="operator_alex")
        self.assertTrue(rb_ok)
        self.assertEqual(current_model.read_bytes(), b"MODEL_VERSION_1_WEIGHTS")

    def test_activation_fault_injection_metadata_failure_preserves_old_pair(self):
        """
        P0-2 requirement:
        Fault injection where single-pointer atomic replacement fails.
        Proves models/current remains pointing to the old release pair without corruption.
        """
        from dataset_pipeline import activate_candidate_model

        yaml_p = self._create_valid_dataset()

        self.models_dir.mkdir(parents=True, exist_ok=True)
        old_rel = self.models_dir / "releases" / "release_v1_old"
        old_rel.mkdir(parents=True, exist_ok=True)

        old_weights = b"OLD_GOLDEN_ACTIVE_WEIGHTS_VERSION_1"
        old_metadata = json.dumps({"modelName": "golden_v1", "sha256": "old_sha", "datasetVersion": "v1.0.0"}).encode("utf-8")

        (old_rel / "vr_headset_yolo.pt").write_bytes(old_weights)
        (old_rel / "model_metadata.json").write_bytes(old_metadata)

        # Pre-point models/current to old release
        current_link = self.models_dir / "current"
        if current_link.is_symlink() or current_link.exists():
            current_link.unlink()
        current_link.symlink_to("releases/release_v1_old")

        cand_new = self.base_dir / "candidate_new.pt"
        cand_new.write_bytes(b"NEW_CANDIDATE_WEIGHTS_VERSION_2")

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_passing_gate(**kwargs):
            return True, {"mAP50": 0.92, "precision": 0.89, "recall": 0.86}, None

        orig_replace = os.replace

        def faulty_replace(src, dst):
            # Inject failure when switching the current symlink pointer
            if "current" in str(dst):
                raise OSError("Simulated hardware/filesystem I/O failure during atomic pointer replacement")
            return orig_replace(src, dst)

        with patch("os.replace", side_effect=faulty_replace):
            with self.assertRaises(RuntimeError) as ctx:
                activate_candidate_model(
                    candidate_model_path=cand_new,
                    dataset_version="v2.0.0",
                    dataset_yaml=yaml_p,
                    models_dir=self.models_dir,
                    operator_id="operator_fault_injector",
                    yolo_factory=MockValidYOLO,
                    _eval_gate_fn=mock_passing_gate,
                )
            self.assertIn("Model activation failed", str(ctx.exception))

        # Critical assertion: Both active model and active metadata MUST REMAIN THE OLD PAIR!
        self.assertEqual((self.models_dir / "current" / "vr_headset_yolo.pt").read_bytes(), old_weights)
        self.assertEqual((self.models_dir / "current" / "model_metadata.json").read_bytes(), old_metadata)

    def test_export_dataset_clears_stale_files_across_exports(self):
        """
        P1-1 requirement:
        Two consecutive exports with changed sessions confirming zero stale files remain.
        """
        from dataset_pipeline import collect_ptz_frame, enqueue_for_verification, export_dataset_splits, verify_sample

        # First export with sessions A, B, C
        for sess in ("sess_A", "sess_B", "sess_C"):
            raw_p = collect_ptz_frame(
                camera_id="cam1",
                room_id="room1",
                preset_name="angle1",
                image_bytes=f"IMG_FIRST_EXPORT_{sess}".encode(),
                capture_session_id=sess,
                output_root=self.data_dir,
            )
            sid = enqueue_for_verification(raw_p, queue_root=self.data_dir)
            verify_sample(
                sid,
                operator_id="op_admin",
                approved=True,
                corrected_bboxes=[{"classId": 0, "x": 0.2, "y": 0.2, "width": 0.2, "height": 0.2}],
                queue_root=self.data_dir,
            )

        summary1 = export_dataset_splits(
            output_dir=self.dataset_dir,
            data_root=self.data_dir,
            version="v1.0.0",
        )
        self.assertEqual(summary1["version"], "v1.0.0")

        # Verify sess_C file content and manifest exist in active current dataset
        active_current = self.dataset_dir / "current"
        sess_c_found_1 = any(b"sess_C" in p.read_bytes() for p in active_current.rglob("*.jpg"))
        self.assertTrue(sess_c_found_1, "sess_C must be present in first export")
        manifest1 = json.loads((active_current / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("sess_C", manifest1.get("sessionGroups", []))

        # Now remove sess_C verified sample and add sess_D
        for p in (self.data_dir / "verified").glob("sample_*"):
            anno_p = p / "annotation.json"
            if anno_p.is_file():
                meta = json.loads(anno_p.read_text(encoding="utf-8"))
                if meta.get("captureSessionId") == "sess_C":
                    shutil.rmtree(p)

        raw_d = collect_ptz_frame(
            camera_id="cam1",
            room_id="room1",
            preset_name="angle1",
            image_bytes=b"IMG_SECOND_EXPORT_sess_D",
            capture_session_id="sess_D",
            output_root=self.data_dir,
        )
        sid_d = enqueue_for_verification(raw_d, queue_root=self.data_dir)
        verify_sample(
            sid_d,
            operator_id="op_admin",
            approved=True,
            corrected_bboxes=[{"classId": 0, "x": 0.3, "y": 0.3, "width": 0.2, "height": 0.2}],
            queue_root=self.data_dir,
        )

        # Second export with sessions A, B, D
        summary2 = export_dataset_splits(
            output_dir=self.dataset_dir,
            data_root=self.data_dir,
            version="v2.0.0",
        )
        self.assertEqual(summary2["version"], "v2.0.0")

        # Verify sess_C file is COMPLETELY GONE from active dataset pointer (current)
        sess_c_found_2 = any(b"sess_C" in p.read_bytes() for p in (self.dataset_dir / "current").rglob("*.jpg"))
        self.assertFalse(sess_c_found_2, "Zero stale sess_C images must remain in active dataset pointer after re-export")
        manifest2 = json.loads((self.dataset_dir / "current" / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotIn("sess_C", manifest2.get("sessionGroups", []))
        self.assertIn("sess_D", manifest2.get("sessionGroups", []))
        sess_d_found = any(b"sess_D" in p.read_bytes() for p in (self.dataset_dir / "current").rglob("*.jpg"))
        self.assertTrue(sess_d_found, "sess_D must be present in second export")

        # And prior release v1.0.0 remains immutable on disk
        self.assertTrue((self.dataset_dir / "releases" / "v1.0.0").is_dir())
        self.assertTrue(any(b"sess_C" in p.read_bytes() for p in (self.dataset_dir / "releases" / "v1.0.0").rglob("*.jpg")))

    @unittest.skipUnless(
        (Path(__file__).parent / "models" / "yolo11n.pt").is_file(),
        "Local YOLO .pt fixture not found; skipping real Ultralytics YOLO integration test"
    )
    def test_real_ultralytics_yolo_loading_integration(self):
        try:
            from ultralytics import YOLO
        except ImportError:
            self.skipTest("Ultralytics package not installed")

        fixture_path = Path(__file__).parent / "models" / "yolo11n.pt"
        model = YOLO(str(fixture_path))
        self.assertIsNotNone(model)

    def test_train_headset_model_dataset_required_and_training_unavailable(self):
        from dataset_pipeline import train_headset_model

        # 1. Missing dataset.yaml -> DATASET_REQUIRED
        with self.assertRaises((FileNotFoundError, ValueError)) as ctx:
            train_headset_model(dataset_yaml=self.base_dir / "non_existent.yaml")
        self.assertIn("DATASET_REQUIRED", str(ctx.exception))

        # 2. Missing manifest.json with sample provenance -> DATASET_CORRUPT
        yaml_p = self.dataset_dir / "dataset.yaml"
        self.dataset_dir.mkdir(parents=True, exist_ok=True)
        (self.dataset_dir / "images" / "train").mkdir(parents=True, exist_ok=True)
        yaml_p.write_text("names: {0: vr_headset}\n")
        with self.assertRaises(ValueError) as ctx:
            train_headset_model(dataset_yaml=yaml_p)
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

        # 3. Empty splits in manifest -> DATASET_INSUFFICIENT
        manifest_p = self.dataset_dir / "manifest.json"
        manifest_p.write_text(json.dumps({
            "version": "v1.0.0",
            "manifestHash": "fakehash",
            "splitCounts": {"train": 0, "val": 0, "test": 0},
            "samples": []
        }))
        with self.assertRaises(ValueError) as ctx:
            train_headset_model(dataset_yaml=yaml_p)
        self.assertIn("DATASET_INSUFFICIENT", str(ctx.exception))

        # 4. Splits non-empty in manifest and on disk, but base model weights missing on disk -> TRAINING_UNAVAILABLE
        yaml_p = self._create_valid_dataset()
        with self.assertRaises(FileNotFoundError) as ctx:
            train_headset_model(dataset_yaml=yaml_p, base_model=self.base_dir / "non_existent_yolo.pt")
        self.assertIn("TRAINING_UNAVAILABLE", str(ctx.exception))

    def test_train_headset_model_invokes_yolo_and_extracts_best_pt_mock_yolo(self):
        from dataset_pipeline import train_headset_model

        # Prepare verified dataset structure with manifest
        yaml_p = self._create_valid_dataset()

        # Fake base model
        base_weights = self.base_dir / "base_yolo.pt"
        base_weights.write_bytes(b"REAL_BASE_YOLO_WEIGHTS_BIN")

        # Mock YOLO model that runs train and writes best.pt
        mock_save_dir = self.base_dir / "runs_mock" / "train" / "vr_headset_candidate"
        weights_dir = mock_save_dir / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        mock_best_pt = weights_dir / "best.pt"
        mock_best_pt.write_bytes(b"GENUINE_TRAINED_BEST_PT_BINARY")

        class MockYOLOModel:
            def __init__(self, weights_path):
                self.weights_path = weights_path
                self.train_called = False

            def train(self, **kwargs):
                self.train_called = True
                self.kwargs = kwargs
                res = MagicMock()
                res.save_dir = mock_save_dir
                return res

        mock_instance = None
        def mock_yolo_factory(weights_path):
            nonlocal mock_instance
            mock_instance = MockYOLOModel(weights_path)
            return mock_instance

        out_cand = self.models_dir / "candidate_vr_headset.pt"
        trained_path = train_headset_model(
            dataset_yaml=yaml_p,
            epochs=5,
            base_model=base_weights,
            output_candidate=out_cand,
            yolo_factory=mock_yolo_factory,
        )

        self.assertEqual(trained_path, out_cand)
        self.assertTrue(out_cand.is_file())
        self.assertEqual(out_cand.read_bytes(), b"GENUINE_TRAINED_BEST_PT_BINARY")
        self.assertTrue(mock_instance.train_called)

    def test_cli_workflow_and_audit(self):
        import dataset_pipeline

        # 1. collect-ptz via CLI
        raw_img_file = self.base_dir / "raw_frame.jpg"
        raw_img_file.write_bytes(b"JPEG_CLI_PAYLOAD")

        cli_args = [
            "dataset_pipeline.py",
            "collect-ptz",
            "--camera-id", "cam_cli",
            "--room-id", "room_cli",
            "--preset", "center",
            "--image", str(raw_img_file),
            "--capture-session-id", "cli_session_01",
        ]
        with patch.object(dataset_pipeline, "DATA_DIR", self.data_dir), \
             patch.object(sys, "argv", cli_args):
            dataset_pipeline.main()

        raw_files = list((self.data_dir / "raw" / "cam_cli").glob("*.jpg"))
        self.assertEqual(len(raw_files), 1)

        # 2. enqueue via CLI
        cli_args = [
            "dataset_pipeline.py",
            "enqueue",
            "--raw-image", str(raw_files[0]),
        ]
        with patch.object(dataset_pipeline, "DATA_DIR", self.data_dir), \
             patch.object(sys, "argv", cli_args):
            dataset_pipeline.main()

        queue_dirs = list((self.data_dir / "verification_queue").glob("sample_*"))
        self.assertEqual(len(queue_dirs), 1)
        sample_id = queue_dirs[0].name

        # 3. verify via CLI with corrected bboxes
        bboxes_json = json.dumps([{"classId": 0, "x": 0.15, "y": 0.15, "width": 0.25, "height": 0.25}])
        cli_args = [
            "dataset_pipeline.py",
            "verify",
            "--sample-id", sample_id,
            "--operator-id", "operator_dan",
            "--approve",
            "--bboxes", bboxes_json,
            "--notes", "CLI verification passed",
        ]
        with patch.object(dataset_pipeline, "DATA_DIR", self.data_dir), \
             patch.object(sys, "argv", cli_args):
            dataset_pipeline.main()

        self.assertTrue((self.data_dir / "verified" / sample_id).is_dir())
        self.assertFalse((self.data_dir / "verification_queue" / sample_id).exists())

        # Check audit trail was recorded
        audit_file = self.data_dir / "audit_trail.jsonl"
        self.assertTrue(audit_file.is_file())
        audit_lines = audit_file.read_text(encoding="utf-8").strip().split("\n")
        self.assertTrue(any("operator_dan" in l and "verify_sample" in l for l in audit_lines))

        # 4. status via CLI
        status_args = ["dataset_pipeline.py", "status"]
        with patch.object(dataset_pipeline, "DATA_DIR", self.data_dir), \
             patch.object(dataset_pipeline, "MODELS_DIR", self.models_dir), \
             patch.object(sys, "argv", status_args):
            dataset_pipeline.main()

    def test_verify_dataset_manifest_tampering_fails(self):
        from dataset_pipeline import verify_dataset_manifest_and_provenance

        yaml_p = self._create_valid_dataset()

        # 1. Tamper with an image in test split
        img_p = self.dataset_dir / "images" / "test" / "sample_test_0.jpg"
        orig_bytes = img_p.read_bytes()
        img_p.write_bytes(orig_bytes + b"_TAMPERED")

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT: Manifest hash mismatch", str(ctx.exception))

        # Restore image
        img_p.write_bytes(orig_bytes)
        # Provenance check should now succeed
        manifest = verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIsNotNone(manifest)

        # 2. Tamper with manifestHash directly
        manifest_p = self.dataset_dir / "manifest.json"
        data = json.loads(manifest_p.read_text(encoding="utf-8"))
        data["manifestHash"] = "corrupted_hash"
        manifest_p.write_text(json.dumps(data), encoding="utf-8")

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT: Manifest hash mismatch", str(ctx.exception))

    def test_verify_dataset_untracked_extra_file_fails(self):
        from dataset_pipeline import verify_dataset_manifest_and_provenance

        yaml_p = self._create_valid_dataset()

        # Place untracked image into train split
        untracked = self.dataset_dir / "images" / "train" / "untracked_rogue.jpg"
        untracked.write_bytes(b"ROGUE_IMAGE")
        untracked_lbl = self.dataset_dir / "labels" / "train" / "untracked_rogue.txt"
        untracked_lbl.write_text("0 0.5 0.5 0.2 0.2\n")

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT: Untracked extra image found on disk", str(ctx.exception))

    def test_verify_dataset_invalid_bbox_coords_fails(self):
        from dataset_pipeline import verify_dataset_manifest_and_provenance
        from model_validator import compute_dataset_manifest_hash

        # 1. Invalid class (not 0)
        yaml_p = self._create_valid_dataset()
        lbl_p = self.dataset_dir / "labels" / "train" / "sample_train_0.txt"
        lbl_p.write_text("1 0.5 0.5 0.2 0.2\n")
        manifest_p = self.dataset_dir / "manifest.json"
        m = json.loads(manifest_p.read_text())
        m["manifestHash"] = compute_dataset_manifest_hash(yaml_p, split="test")
        manifest_p.write_text(json.dumps(m))

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

        # 2. Out of bounds coordinates (e.g. x > 1.0)
        lbl_p.write_text("0 1.5 0.5 0.2 0.2\n")
        m["manifestHash"] = compute_dataset_manifest_hash(yaml_p, split="test")
        manifest_p.write_text(json.dumps(m))

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

        # 3. Non-positive width
        lbl_p.write_text("0 0.5 0.5 0.0 0.2\n")
        m["manifestHash"] = compute_dataset_manifest_hash(yaml_p, split="test")
        manifest_p.write_text(json.dumps(m))

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

    def test_pipeline_job_lock_flock_concurrency(self):
        from dataset_pipeline import PipelineJobLock

        lock_path = self.data_dir / ".pipeline_job.lock"
        lock1 = PipelineJobLock(lock_path)
        lock2 = PipelineJobLock(lock_path)

        # Acquire lock1
        lock1.acquire(job_type="training", operator_id="user_a")
        self.assertTrue(lock_path.is_file())

        # Attempt acquire lock2 while lock1 is held -> must raise RuntimeError(JOB_IN_PROGRESS)
        with self.assertRaises(RuntimeError) as ctx:
            lock2.acquire(job_type="activation", operator_id="user_b")
        self.assertIn("JOB_IN_PROGRESS", str(ctx.exception))

        # Release lock1
        lock1.release()

        # Now lock2 acquire should succeed
        lock2.acquire(job_type="activation", operator_id="user_b")
        lock2.release()

    def test_model_activation_atomic_symlink_switch(self):
        from dataset_pipeline import activate_candidate_model, rollback_model

        yaml_p = self._create_valid_dataset()

        cand1 = self.base_dir / "cand1.pt"
        cand1.write_bytes(b"WEIGHTS_RELEASE_V1")

        cand2 = self.base_dir / "cand2.pt"
        cand2.write_bytes(b"WEIGHTS_RELEASE_V2")

        class MockYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_gate(**kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, None

        # 1. Activate cand1
        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockYOLO,
            _eval_gate_fn=mock_gate,
        )
        self.assertEqual(res1["status"], "ACTIVATED")

        # Verify symlink pointer
        current_link = self.models_dir / "current"
        self.assertTrue(current_link.is_symlink())
        self.assertTrue((current_link / "vr_headset_yolo.pt").is_file())
        self.assertEqual((current_link / "vr_headset_yolo.pt").read_bytes(), b"WEIGHTS_RELEASE_V1")

        # 2. Activate cand2
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v2.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockYOLO,
            _eval_gate_fn=mock_gate,
        )
        self.assertEqual(res2["status"], "ACTIVATED")

        # Verify current points to v2 and previous points to v1
        previous_link = self.models_dir / "previous"
        self.assertTrue(previous_link.is_symlink())
        self.assertEqual((previous_link / "vr_headset_yolo.pt").read_bytes(), b"WEIGHTS_RELEASE_V1")
        self.assertEqual((current_link / "vr_headset_yolo.pt").read_bytes(), b"WEIGHTS_RELEASE_V2")

        # 3. Rollback
        rb_ok = rollback_model(models_dir=self.models_dir, operator_id="op_admin")
        self.assertTrue(rb_ok)
        self.assertEqual((current_link / "vr_headset_yolo.pt").read_bytes(), b"WEIGHTS_RELEASE_V1")

    def test_pipeline_job_lock_multiprocess_contention(self):
        """
        P0 requirement:
        Verify true cross-process mutual exclusion using multiprocessing.Process,
        and confirm lock file inode remains stable (never unlinked).
        """
        from dataset_pipeline import PipelineJobLock

        lock_path = self.data_dir / ".pipeline_job.lock"
        start_event = multiprocessing.Event()
        release_event = multiprocessing.Event()
        out_queue = multiprocessing.Queue()

        proc = multiprocessing.Process(
            target=_mp_lock_worker,
            args=(str(lock_path), start_event, release_event, out_queue),
        )
        proc.start()

        try:
            # Wait for worker process to acquire lock
            self.assertTrue(start_event.wait(timeout=5), "Worker process failed to acquire lock in time")
            msg = out_queue.get(timeout=2)
            self.assertEqual(msg, "ACQUIRED")

            # Inode check: file exists and has stable inode
            self.assertTrue(lock_path.is_file())
            initial_inode = os.stat(lock_path).st_ino

            # Main process attempt to acquire must fail due to process contention
            main_lock = PipelineJobLock(lock_path)
            with self.assertRaises(RuntimeError) as ctx:
                main_lock.acquire("activation", "main_process")
            self.assertIn("JOB_IN_PROGRESS", str(ctx.exception))

            # Signal worker to release lock
            release_event.set()
            rel_msg = out_queue.get(timeout=5)
            self.assertEqual(rel_msg, "RELEASED")
            proc.join(timeout=3)

            # Confirm inode is STABLE and file was NOT unlinked upon release
            self.assertTrue(lock_path.is_file(), "Lock file must remain on disk to avoid inode race")
            self.assertEqual(os.stat(lock_path).st_ino, initial_inode, "Inode must remain stable across release")

            # Main process now acquires successfully
            self.assertTrue(main_lock.acquire("activation", "main_process"))
            main_lock.release()
            self.assertEqual(os.stat(lock_path).st_ino, initial_inode, "Inode must still be identical after second release")
        finally:
            if proc.is_alive():
                proc.terminate()
                proc.join()

    def test_verify_dataset_manifest_multi_split_integrity(self):
        """
        P0 requirement:
        Verify SHA-256 covers images and labels across all splits ('train', 'val', 'test'),
        and that any tampering in 'train' or 'val' split is immediately detected.
        """
        from dataset_pipeline import verify_dataset_manifest_and_provenance
        from model_validator import compute_sha256

        # 1. Tamper with a train split image
        yaml_p = self._create_valid_dataset()
        train_img = self.dataset_dir / "images" / "train" / "sample_train_0.jpg"
        orig_bytes = train_img.read_bytes()
        train_img.write_bytes(orig_bytes + b"_TAMPERED_TRAIN")

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

        # Restore train image
        train_img.write_bytes(orig_bytes)
        self.assertIsNotNone(verify_dataset_manifest_and_provenance(yaml_p, expected_split="test"))

        # 2. Tamper with a val split label
        val_lbl = self.dataset_dir / "labels" / "val" / "sample_val_0.txt"
        orig_lbl_content = val_lbl.read_text(encoding="utf-8")
        val_lbl.write_text("0 0.1 0.1 0.3 0.3\n")

        with self.assertRaises(ValueError) as ctx:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")
        self.assertIn("DATASET_CORRUPT", str(ctx.exception))

        # Restore val label
        val_lbl.write_text(orig_lbl_content)
        self.assertIsNotNone(verify_dataset_manifest_and_provenance(yaml_p, expected_split="test"))

    def test_reconcile_daemon_job_status_interrupted(self):
        """
        P1 requirement:
        Reconcile daemon job status upon restart or crash.
        Jobs marked TRAINING/ACTIVATING when lock is unheld must transition to INTERRUPTED.
        """
        from dataset_pipeline import reconcile_daemon_job_status, get_job_status

        self.data_dir.mkdir(parents=True, exist_ok=True)
        st_file = self.data_dir / "pipeline_job_status.json"
        # Write an orphaned in-flight training job
        st_file.write_text(json.dumps({
            "status": "TRAINING",
            "jobType": "training",
            "jobId": "job_orphaned_123",
            "operatorId": "op_crashed",
            "startedAt": "2026-09-09T10:00:00Z",
            "updatedAt": "2026-09-09T10:05:00Z",
        }))

        # Reconcile status without lock held
        reconciled = reconcile_daemon_job_status(self.data_dir)
        self.assertEqual(reconciled["status"], "INTERRUPTED")
        self.assertIn("interrupted by daemon restart", reconciled.get("error", ""))

        # Calling get_job_status also yields the reconciled INTERRUPTED status
        status_now = get_job_status(self.data_dir)
        self.assertEqual(status_now["status"], "INTERRUPTED")

    def test_two_successive_dataset_exports_v2_reads_only_v2(self):
        """
        P0 requirement:
        Two successive dataset exports must create immutable version directories (releases/v1.0.0 and releases/v2.0.0).
        v2 dataset.yaml must specify 'path: .' and resolve strictly v2 images and labels, never v1.
        """
        from dataset_pipeline import (
            collect_ptz_frame,
            enqueue_for_verification,
            verify_sample,
            export_dataset_splits,
            resolve_active_dataset_manifest,
        )

        # 1. Create 3 verified samples for v1.0.0
        for sess in ("sess_1", "sess_2", "sess_3"):
            raw = collect_ptz_frame(
                camera_id=f"cam_{sess}",
                room_id="room1",
                preset_name="preset",
                image_bytes=f"IMG_V1_{sess}".encode("utf-8"),
                capture_session_id=sess,
                output_root=self.data_dir,
            )
            sid = enqueue_for_verification(raw, queue_root=self.data_dir)
            verify_sample(
                sid,
                operator_id="op1",
                approved=True,
                corrected_bboxes=[{"classId": 0, "x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}],
                queue_root=self.data_dir,
            )

        summary1 = export_dataset_splits(
            output_dir=self.dataset_dir,
            data_root=self.data_dir,
            version="v1.0.0",
        )
        self.assertEqual(summary1["version"], "v1.0.0")

        # Verify v1.0.0 YAML has path: .
        v1_yaml_p = self.dataset_dir / "releases" / "v1.0.0" / "dataset.yaml"
        self.assertTrue(v1_yaml_p.is_file())
        self.assertIn("path: .", v1_yaml_p.read_text(encoding="utf-8"))

        # 2. Add new sample for v2.0.0
        raw2 = collect_ptz_frame(
            camera_id="cam_sess_4",
            room_id="room1",
            preset_name="preset",
            image_bytes=b"IMG_V2_sess_4_NEW",
            capture_session_id="sess_4",
            output_root=self.data_dir,
        )
        sid2 = enqueue_for_verification(raw2, queue_root=self.data_dir)
        verify_sample(
            sid2,
            operator_id="op1",
            approved=True,
            corrected_bboxes=[{"classId": 0, "x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}],
            queue_root=self.data_dir,
        )

        summary2 = export_dataset_splits(
            output_dir=self.dataset_dir,
            data_root=self.data_dir,
            version="v2.0.0",
        )
        self.assertEqual(summary2["version"], "v2.0.0")

        # Verify v2.0.0 YAML has path: .
        v2_yaml_p = self.dataset_dir / "releases" / "v2.0.0" / "dataset.yaml"
        self.assertTrue(v2_yaml_p.is_file())
        self.assertIn("path: .", v2_yaml_p.read_text(encoding="utf-8"))

        # Verify active manifest resolved through dataset/current/dataset.yaml
        resolved = resolve_active_dataset_manifest(self.dataset_dir)
        self.assertEqual(resolved.resolve(), v2_yaml_p.resolve())

        # Verify v2 images contain sess_4, while v1 remains intact
        v2_imgs = [p.read_bytes() for p in (self.dataset_dir / "releases" / "v2.0.0").rglob("*.jpg")]
        self.assertTrue(any(b"sess_4" in b for b in v2_imgs))
        v1_imgs = [p.read_bytes() for p in (self.dataset_dir / "releases" / "v1.0.0").rglob("*.jpg")]
        self.assertFalse(any(b"sess_4" in b for b in v1_imgs))

    def test_dataset_volume_topology_invariants(self):
        """
        P0 requirement:
        Verifies persistent volume topology invariants:
        - releases/ and current pointer resolve strictly inside persistent root
        - persistent root is never deleted, unlinked, or replaced with a symlink
        """
        from dataset_pipeline import export_dataset_splits, collect_ptz_frame, enqueue_for_verification, verify_sample

        for sess in ("top_1", "top_2", "top_3"):
            raw = collect_ptz_frame(
                camera_id=f"cam_{sess}",
                room_id="room1",
                preset_name="preset",
                image_bytes=f"IMG_TOP_{sess}".encode("utf-8"),
                capture_session_id=sess,
                output_root=self.data_dir,
            )
            sid = enqueue_for_verification(raw, queue_root=self.data_dir)
            verify_sample(
                sid,
                operator_id="op1",
                approved=True,
                corrected_bboxes=[{"classId": 0, "x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}],
                queue_root=self.data_dir,
            )

        # In Docker, output_dir is a mount point directory
        initial_stat = self.dataset_dir.stat()
        self.assertFalse(self.dataset_dir.is_symlink(), "Persistent root must be a directory, not symlink")

        export_dataset_splits(output_dir=self.dataset_dir, data_root=self.data_dir, version="v1.0.0")

        # 1. Mount root itself was NOT unlinked or replaced with symlink
        self.assertFalse(self.dataset_dir.is_symlink(), "Mount root must remain a real directory")
        self.assertEqual(self.dataset_dir.stat().st_ino, initial_stat.st_ino, "Mount root inode must not change")

        # 2. current pointer is strictly inside dataset_dir
        curr_link = self.dataset_dir / "current"
        self.assertTrue(curr_link.is_symlink())
        target = os.readlink(str(curr_link))
        self.assertEqual(target, "releases/v1.0.0", "Pointer must be relative to root")
        self.assertTrue(curr_link.resolve().is_relative_to(self.dataset_dir.resolve()), "Must resolve inside persistent root")

        # 3. releases are strictly inside dataset_dir
        self.assertTrue((self.dataset_dir / "releases" / "v1.0.0").is_dir())
        self.assertTrue((self.dataset_dir / "releases" / "v1.0.0").resolve().is_relative_to(self.dataset_dir.resolve()))

    def test_dataset_duplicate_version_rejected_and_reader_unaffected(self):
        """
        P0 requirement:
        Reject duplicate dataset export version with DATASET_RELEASE_EXISTS.
        Existing published release must remain untouched and active reader must be unaffected.
        """
        from dataset_pipeline import export_dataset_splits, collect_ptz_frame, enqueue_for_verification, verify_sample

        for sess in ("dup_1", "dup_2", "dup_3"):
            raw = collect_ptz_frame(
                camera_id=f"cam_{sess}",
                room_id="room1",
                preset_name="preset",
                image_bytes=f"IMG_DUP_{sess}".encode("utf-8"),
                capture_session_id=sess,
                output_root=self.data_dir,
            )
            sid = enqueue_for_verification(raw, queue_root=self.data_dir)
            verify_sample(
                sid,
                operator_id="op1",
                approved=True,
                corrected_bboxes=[{"classId": 0, "x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}],
                queue_root=self.data_dir,
            )

        export_dataset_splits(output_dir=self.dataset_dir, data_root=self.data_dir, version="v1.0.0")
        v1_manifest = (self.dataset_dir / "releases" / "v1.0.0" / "manifest.json").read_text()

        # Attempt to export v1.0.0 again
        with self.assertRaises(ValueError) as ctx:
            export_dataset_splits(output_dir=self.dataset_dir, data_root=self.data_dir, version="v1.0.0")
        self.assertIn("DATASET_RELEASE_EXISTS", str(ctx.exception))

        # Check existing release and reader completely unaffected
        self.assertEqual((self.dataset_dir / "releases" / "v1.0.0" / "manifest.json").read_text(), v1_manifest)
        self.assertTrue((self.dataset_dir / "current" / "dataset.yaml").is_file())

    def test_model_release_collision_proof_exclusive_creation(self):
        """
        P0 requirement:
        Release IDs must be collision-proof with microsecond timestamps and UUIDs.
        Shared models/releases directory must exist, while rel_dir must be created with exist_ok=False.
        """
        from dataset_pipeline import activate_candidate_model

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        # Create two mock candidates
        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        self.assertNotEqual(res1["releaseId"], res2["releaseId"])
        # Verify releases dir exists and has both releases
        releases_dir = self.models_dir / "releases"
        self.assertTrue((releases_dir / res1["releaseId"]).is_dir())
        self.assertTrue((releases_dir / res2["releaseId"]).is_dir())

    def test_rollback_derived_from_activation_journal_even_with_stale_previous(self):
        """
        P0 requirement:
        Deterministic rollback derived strictly from activation_journal.jsonl.
        Even if models/previous pointer is missing, deleted, or corrupted,
        rollback correctly restores the previous active release from the journal.
        """
        from dataset_pipeline import activate_candidate_model, rollback_model

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        # Current is res2
        self.assertIn(res2["releaseId"], os.readlink(str(self.models_dir / "current")))

        # Intentionally tamper with or remove previous pointer
        prev_link = self.models_dir / "previous"
        if prev_link.is_symlink() or prev_link.exists():
            prev_link.unlink()

        # Rollback must succeed deterministically by reading activation_journal.jsonl!
        rollback_ok = rollback_model(models_dir=self.models_dir, operator_id="op_admin")
        self.assertTrue(rollback_ok)

        # Current must now point to res1!
        curr_target = os.readlink(str(self.models_dir / "current"))
        self.assertIn(res1["releaseId"], curr_target)

    def test_rollback_fault_injection_previous_fails_before_current_switched(self):
        """
        P0 requirement:
        Fault injection: if updating previous pointer fails, abort activation before
        current pointer is touched. Never allow a stale previous pointer to misrepresent state.
        """
        from dataset_pipeline import activate_candidate_model
        from unittest.mock import patch

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        initial_current = os.readlink(str(self.models_dir / "current"))

        # Inject failure when updating previous pointer (e.g. permission error during symlink swap)
        real_symlink = os.symlink
        def mock_symlink(src, dst):
            if ".tmp_prev_" in str(dst):
                raise OSError("Injected disk fault on previous pointer")
            return real_symlink(src, dst)

        with patch("os.symlink", side_effect=mock_symlink):
            with self.assertRaises(RuntimeError) as ctx:
                activate_candidate_model(
                    candidate_model_path=cand2,
                    dataset_version="v1.0.0",
                    dataset_yaml=yaml_p,
                    models_dir=self.models_dir,
                    operator_id="op_admin",
                    yolo_factory=MockValidYOLO,
                    _eval_gate_fn=mock_eval_gate,
                )
            self.assertIn("updating rollback pointer", str(ctx.exception))

        # Current pointer must NOT have been switched!
        current_after = os.readlink(str(self.models_dir / "current"))
        self.assertEqual(current_after, initial_current, "Current pointer must be untouched if previous update failed")

    def test_post_switch_audit_failure_preserves_completed_status(self):
        """
        P0 requirement:
        If recording audit event fails AFTER atomic symlink switch has succeeded,
        activation must not fail and job status must not be marked FAILED.
        """
        from dataset_pipeline import activate_candidate_model
        from unittest.mock import patch

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand = self.models_dir / "cand_audit.pt"
        cand.write_bytes(b"CANDIDATE_AUDIT")

        with patch("scripts.dataset_pipeline.record_audit_event", side_effect=OSError("Disk full writing audit trail")):
            # Activation must succeed on disk even if post-switch audit logging fails
            res = activate_candidate_model(
                candidate_model_path=cand,
                dataset_version="v1.0.0",
                dataset_yaml=yaml_p,
                models_dir=self.models_dir,
                operator_id="op_admin",
                yolo_factory=MockValidYOLO,
                _eval_gate_fn=mock_eval_gate,
            )
            self.assertEqual(res["status"], "ACTIVATED")
            self.assertTrue((self.models_dir / "current").is_symlink())

    def test_container_recreate_persistence_and_reconciliation(self):
        """
        P0 requirement:
        Simulate container recreation where persistent volumes are mounted.
        Verify model pointer reconciliation reconstructs pointers from activation_journal.jsonl,
        and resolve_active_dataset_manifest accurately resolves dataset/current/dataset.yaml.
        """
        from dataset_pipeline import (
            activate_candidate_model,
            reconcile_model_pointers,
            resolve_active_dataset_manifest,
        )

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand = self.models_dir / "cand_persist.pt"
        cand.write_bytes(b"PERSISTENT_CANDIDATE")

        res = activate_candidate_model(
            candidate_model_path=cand,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        # Now simulate container recreation:
        # Pointers in models/ might be dropped or out of sync, but releases/ and journal remain on persistent volume
        curr_link = self.models_dir / "current"
        curr_link.unlink()

        # Reconcile on startup
        reconciled = reconcile_model_pointers(self.models_dir)
        self.assertTrue(reconciled["reconciled"])
        self.assertTrue(curr_link.is_symlink())
        self.assertIn(res["releaseId"], os.readlink(str(curr_link)))

        # Dataset manifest resolution inside volume
        resolved_manifest = resolve_active_dataset_manifest(self.dataset_dir)
        self.assertEqual(resolved_manifest.resolve(), (self.dataset_dir / "current" / "dataset.yaml").resolve())
        self.assertTrue(resolved_manifest.is_file())

    def test_previous_update_fails_then_reconcile_runs_current_remains_old(self):
        """
        P0 requirement:
        If previous cache update fails during activation, activation aborts,
        and subsequent reconciliation must NOT switch current to the candidate.
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers
        from unittest.mock import patch

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        initial_current = os.readlink(str(self.models_dir / "current"))

        # Inject failure when updating previous pointer
        real_symlink = os.symlink
        def mock_symlink(src, dst):
            if ".tmp_prev_" in str(dst):
                raise OSError("Injected disk fault on previous pointer")
            return real_symlink(src, dst)

        with patch("os.symlink", side_effect=mock_symlink):
            with self.assertRaises(RuntimeError) as ctx:
                activate_candidate_model(
                    candidate_model_path=cand2,
                    dataset_version="v1.0.0",
                    dataset_yaml=yaml_p,
                    models_dir=self.models_dir,
                    operator_id="op_admin",
                    yolo_factory=MockValidYOLO,
                    _eval_gate_fn=mock_eval_gate,
                )
            self.assertIn("updating rollback pointer", str(ctx.exception))

        # Current pointer was not switched
        self.assertEqual(os.readlink(str(self.models_dir / "current")), initial_current)

        # Subsequent reconciliation must NOT switch current to cand2
        rec = reconcile_model_pointers(self.models_dir)
        self.assertEqual(os.readlink(str(self.models_dir / "current")), initial_current)

    def test_current_swap_fails_then_reconcile_runs_current_remains_old(self):
        """
        P0 requirement:
        If atomic pointer swap of models/current fails, activation aborts,
        and subsequent reconciliation must NOT switch current to the candidate.
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers
        from unittest.mock import patch

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        initial_current = os.readlink(str(self.models_dir / "current"))

        # Inject failure during current pointer replacement
        real_replace = os.replace
        def mock_replace(src, dst):
            if str(dst) == str(self.models_dir / "current"):
                raise OSError("Injected disk failure during current pointer swap")
            return real_replace(src, dst)

        with patch("os.replace", side_effect=mock_replace):
            with self.assertRaises(RuntimeError) as ctx:
                activate_candidate_model(
                    candidate_model_path=cand2,
                    dataset_version="v1.0.0",
                    dataset_yaml=yaml_p,
                    models_dir=self.models_dir,
                    operator_id="op_admin",
                    yolo_factory=MockValidYOLO,
                    _eval_gate_fn=mock_eval_gate,
                )
            self.assertIn("Injected disk failure during current pointer swap", str(ctx.exception))

        # Current pointer was not switched
        self.assertEqual(os.readlink(str(self.models_dir / "current")), initial_current)

        # Reconcile runs: current must REMAIN old!
        reconcile_model_pointers(self.models_dir)
        self.assertEqual(os.readlink(str(self.models_dir / "current")), initial_current)

    def test_crash_before_pointer_swap_prepared_must_not_activate_target(self):
        """
        P0 requirement:
        If process/container crashes after PREPARED entry is written but BEFORE pointer swap,
        recovery must ignore/abort PREPARED and NEVER activate the intended target.
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        initial_current = os.readlink(str(self.models_dir / "current"))

        # Create a candidate release on disk
        fake_rel_id = "release_fake_crash_123"
        (self.models_dir / "releases" / fake_rel_id).mkdir(parents=True, exist_ok=True)
        (self.models_dir / "releases" / fake_rel_id / "vr_headset_yolo.pt").write_bytes(b"FAKE_WEIGHTS")

        # Simulate crash before swap: append PREPARED to journal
        journal_file = self.models_dir / "activation_journal.jsonl"
        prep_entry = {
            "txId": "tx_crashed_before_swap",
            "action": "activate",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": fake_rel_id,
            "target": f"releases/{fake_rel_id}",
            "oldTarget": initial_current,
        }
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(prep_entry) + "\n")

        # Run recovery
        reconcile_model_pointers(self.models_dir)

        # Current must remain the old model (initial_current), NOT fake_rel_id!
        current_after = os.readlink(str(self.models_dir / "current"))
        self.assertEqual(current_after, initial_current)
        self.assertNotIn(fake_rel_id, current_after)

    def test_crash_after_pointer_swap_but_before_committed_recovery_finalizes_target(self):
        """
        P0 requirement:
        If process crashes after pointer swap but before COMMITTED is written,
        recovery deterministically recognizes current == intended and finalizes COMMITTED.
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        old_target = os.readlink(str(self.models_dir / "current"))

        # Create new candidate release on disk
        new_rel_id = "release_crash_after_swap_456"
        (self.models_dir / "releases" / new_rel_id).mkdir(parents=True, exist_ok=True)
        (self.models_dir / "releases" / new_rel_id / "vr_headset_yolo.pt").write_bytes(b"NEW_WEIGHTS")
        intended = f"releases/{new_rel_id}"

        # Write PREPARED to journal
        journal_file = self.models_dir / "activation_journal.jsonl"
        prep_entry = {
            "txId": "tx_crashed_after_swap",
            "action": "activate",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": new_rel_id,
            "target": intended,
            "oldTarget": old_target,
        }
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(prep_entry) + "\n")

        # Swap current pointer to intended (simulating swap succeeded on disk)
        curr_link = self.models_dir / "current"
        curr_link.unlink()
        curr_link.symlink_to(intended)

        # Run recovery
        reconcile_model_pointers(self.models_dir)

        # Recovery should finalize it as COMMITTED and keep current pointing to new release
        self.assertEqual(os.readlink(str(self.models_dir / "current")), intended)

        # Verify journal has COMMITTED for tx_crashed_after_swap
        lines = [json.loads(line) for line in journal_file.read_text().splitlines() if line.strip()]
        last = lines[-1]
        self.assertEqual(last["status"], "COMMITTED")
        self.assertEqual(last["txId"], "tx_crashed_after_swap")

    def test_rollback_crash_windows_before_and_after_swap(self):
        """
        P0 requirement:
        Equivalent crash semantics for rollback transactions:
        - Crash before rollback swap: PREPARED rollback must not switch current
        - Crash after rollback swap: recovery deterministically finalizes rollback as COMMITTED
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        target1 = f"releases/{res1['releaseId']}"
        target2 = f"releases/{res2['releaseId']}"
        self.assertEqual(os.readlink(str(self.models_dir / "current")), target2)

        journal_file = self.models_dir / "activation_journal.jsonl"

        # Window A: Rollback PREPARED, but crashed BEFORE current swap
        rb_prep_a = {
            "txId": "tx_rb_crash_before_swap",
            "action": "rollback",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": res1["releaseId"],
            "target": target1,
            "oldTarget": target2,
        }
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(rb_prep_a) + "\n")

        # Recovery runs: current is target2, does not equal target1 -> abort rollback PREPARED!
        reconcile_model_pointers(self.models_dir)
        self.assertEqual(os.readlink(str(self.models_dir / "current")), target2)

        # Window B: Rollback PREPARED, swap SUCCEEDED to target1, crashed before COMMITTED
        rb_prep_b = {
            "txId": "tx_rb_crash_after_swap",
            "action": "rollback",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": res1["releaseId"],
            "target": target1,
            "oldTarget": target2,
        }
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(rb_prep_b) + "\n")

        curr_link = self.models_dir / "current"
        curr_link.unlink()
        curr_link.symlink_to(target1)

        # Recovery runs: current is target1 == intended -> finalize COMMITTED!
        reconcile_model_pointers(self.models_dir)
        self.assertEqual(os.readlink(str(self.models_dir / "current")), target1)
        lines = [json.loads(line) for line in journal_file.read_text().splitlines() if line.strip()]
        self.assertEqual(lines[-1]["status"], "COMMITTED")
        self.assertEqual(lines[-1]["txId"], "tx_rb_crash_after_swap")

    def test_truncated_corrupt_final_jsonl_line_preserves_earlier_history(self):
        """
        P0 requirement:
        A truncated or corrupt final line in activation_journal.jsonl (from sudden power loss
        during write) must not invalidate earlier committed history or break recovery.
        """
        from dataset_pipeline import activate_candidate_model, rollback_model, reconcile_model_pointers

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        res2 = activate_candidate_model(
            candidate_model_path=cand2,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        journal_file = self.models_dir / "activation_journal.jsonl"
        # Append a single torn / truncated final line at the end of journal
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write('{"txId": "partial_corrupt_tx", "action": "activate", "st\n')

        # 1. Recovery must succeed and preserve valid current
        curr_link = self.models_dir / "current"
        curr_link.unlink() # Simulate missing link to force reconciliation

        rec = reconcile_model_pointers(self.models_dir)
        self.assertTrue(rec["reconciled"])
        self.assertIn(res2["releaseId"], os.readlink(str(self.models_dir / "current")))

        # 2. Rollback must still succeed deterministically reading committed history
        rb_ok = rollback_model(models_dir=self.models_dir, operator_id="op_admin")
        self.assertTrue(rb_ok)
        self.assertIn(res1["releaseId"], os.readlink(str(self.models_dir / "current")))

    def test_corrupted_earlier_journal_entry_raises_journal_corrupt_and_blocks_recovery_and_rollback(self):
        """
        P0 requirement:
        Corruption of any earlier newline-terminated record must raise JOURNAL_CORRUPT
        and block automatic rollback and reconciliation.
        """
        from dataset_pipeline import (
            activate_candidate_model,
            rollback_model,
            reconcile_model_pointers,
            JournalCorruptError,
        )

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        journal_file = self.models_dir / "activation_journal.jsonl"
        # Insert a corrupt record followed by a valid record
        valid_lines = journal_file.read_text().splitlines()
        with open(journal_file, "w", encoding="utf-8") as jf:
            for l in valid_lines:
                jf.write(l + "\n")
            jf.write("CORRUPT_NON_JSON_RECORD_IN_MIDDLE\n")
            jf.write(json.dumps({
                "txId": "tx_later_valid",
                "action": "activate",
                "status": "COMMITTED",
                "target": "releases/some_future_release",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }) + "\n")

        # 1. Reconciliation MUST raise JournalCorruptError ("JOURNAL_CORRUPT")
        with self.assertRaises(RuntimeError) as ctx_rec:
            reconcile_model_pointers(self.models_dir)
        self.assertIn("JOURNAL_CORRUPT", str(ctx_rec.exception))

        # 2. Rollback MUST raise JournalCorruptError ("JOURNAL_CORRUPT")
        with self.assertRaises(RuntimeError) as ctx_rb:
            rollback_model(models_dir=self.models_dir, operator_id="op_admin")
        self.assertIn("JOURNAL_CORRUPT", str(ctx_rb.exception))

    def test_committed_write_failure_after_swap_restores_old_target_and_reports_failure(self):
        """
        P0 requirement:
        On COMMITTED-write failure after pointer swap, atomically restore current to oldTarget,
        fsync, restore previous cache, and report failure.
        """
        from dataset_pipeline import activate_candidate_model, reconcile_model_pointers

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )
        old_target = os.readlink(str(self.models_dir / "current"))

        # Inject failure specifically when appending COMMITTED
        real_open = open
        def mock_open(file, mode="r", *args, **kwargs):
            f_str = str(file)
            if "activation_journal.jsonl" in f_str and "a" in mode:
                # We let PREPARED through, but fail on the second append (COMMITTED)
                # Check contents: if PREPARED is already in file, raise OSError on next open
                if Path(file).is_file() and "PREPARED" in Path(file).read_text():
                    lines = Path(file).read_text().splitlines()
                    last_line = lines[-1] if lines else ""
                    if "PREPARED" in last_line:
                        raise OSError("Disk I/O failure while appending COMMITTED record")
            return real_open(file, mode, *args, **kwargs)

        with patch("builtins.open", side_effect=mock_open):
            with self.assertRaises(RuntimeError) as ctx:
                activate_candidate_model(
                    candidate_model_path=cand2,
                    dataset_version="v1.0.0",
                    dataset_yaml=yaml_p,
                    models_dir=self.models_dir,
                    operator_id="op_admin",
                    yolo_factory=MockValidYOLO,
                    _eval_gate_fn=mock_eval_gate,
                )
            self.assertIn("committed write error", str(ctx.exception))

        # Current pointer MUST have been safely restored to old_target!
        curr_after = os.readlink(str(self.models_dir / "current"))
        self.assertEqual(curr_after, old_target)

        # Reconciliation confirms current remains old_target
        rec = reconcile_model_pointers(self.models_dir)
        self.assertEqual(os.readlink(str(self.models_dir / "current")), old_target)

    def test_committed_write_failure_unproven_restoration_yields_activation_state_uncertain(self):
        """
        P0 requirement:
        If restoration cannot be proven on COMMITTED-write failure, expose ACTIVATION_STATE_UNCERTAIN,
        disable headset inference, and require reconciliation; never report READY or ordinary FAILED.
        """
        from dataset_pipeline import activate_candidate_model, ActivationStateUncertainError
        from server import run_headset_detection
        import server

        yaml_p = self._create_valid_dataset()

        class MockValidYOLO:
            def __init__(self, p):
                self.names = {0: "vr_headset"}
            def __call__(self, img, verbose=False):
                return []

        def mock_eval_gate(*args, **kwargs):
            return True, {"mAP50": 0.90, "precision": 0.85, "recall": 0.85}, []

        cand1 = self.models_dir / "cand1.pt"
        cand1.write_bytes(b"CANDIDATE_MODEL_1")
        cand2 = self.models_dir / "cand2.pt"
        cand2.write_bytes(b"CANDIDATE_MODEL_2")

        res1 = activate_candidate_model(
            candidate_model_path=cand1,
            dataset_version="v1.0.0",
            dataset_yaml=yaml_p,
            models_dir=self.models_dir,
            operator_id="op_admin",
            yolo_factory=MockValidYOLO,
            _eval_gate_fn=mock_eval_gate,
        )

        # Inject failure during COMMITTED append AND fail pointer revert
        real_open = open
        real_replace = os.replace

        def mock_open(file, mode="r", *args, **kwargs):
            f_str = str(file)
            if "activation_journal.jsonl" in f_str and "a" in mode:
                if Path(file).is_file() and "PREPARED" in Path(file).read_text():
                    lines = Path(file).read_text().splitlines()
                    if lines and "PREPARED" in lines[-1]:
                        raise OSError("Disk I/O failure while appending COMMITTED record")
            return real_open(file, mode, *args, **kwargs)

        def mock_replace(src, dst):
            if ".tmp_revert_curr_" in str(src):
                raise OSError("Disk hardware fault during reversion")
            return real_replace(src, dst)

        with patch("builtins.open", side_effect=mock_open):
            with patch("os.replace", side_effect=mock_replace):
                with self.assertRaises(ActivationStateUncertainError) as ctx:
                    activate_candidate_model(
                        candidate_model_path=cand2,
                        dataset_version="v1.0.0",
                        dataset_yaml=yaml_p,
                        models_dir=self.models_dir,
                        operator_id="op_admin",
                        yolo_factory=MockValidYOLO,
                        _eval_gate_fn=mock_eval_gate,
                    )
                self.assertIn("ACTIVATION_STATE_UNCERTAIN", str(ctx.exception))

        orig_status = server.HEADSET_MODEL_STATUS
        orig_error = server.HEADSET_MODEL_ERROR
        orig_model = server.HEADSET_MODEL
        try:
            # When ACTIVATION_STATE_UNCERTAIN is reported to server:
            server.HEADSET_MODEL_STATUS = "ACTIVATION_STATE_UNCERTAIN"
            server.HEADSET_MODEL_ERROR = str(ctx.exception)
            server.HEADSET_MODEL = None

            det = run_headset_detection(b"", "cam-1")
            self.assertEqual(det["status"], "ACTIVATION_STATE_UNCERTAIN")
            self.assertIn("ACTIVATION_STATE_UNCERTAIN", det["error"])
            self.assertEqual(det["headsetCount"], 0)
        finally:
            server.HEADSET_MODEL_STATUS = orig_status
            server.HEADSET_MODEL_ERROR = orig_error
            server.HEADSET_MODEL = orig_model


class TestBackgroundActivityWorker(unittest.TestCase):
    def test_worker_runs_room_scoped_activity_without_browser_and_sends_frame_only_for_event(self):
        session = CameraStreamSession(
            camera_id="cam-1",
            provider="RTSP",
            config={"activity_settings": {"HELP_REQUESTED": {"enabled": True}}},
            api_url="http://api.test",
            semaphore=None,
            activity_semaphore=threading.BoundedSemaphore(1),
        )
        session.is_online = True
        session.detection_fn = lambda *_: {"people": []}
        session.activity_detection_fn = lambda *_: {
            "status": "READY",
            "peopleCount": 1,
            "events": [{"actionType": "HELP_REQUESTED", "confidence": 0.9}],
        }

        with patch("receiver.requests.post") as post:
            session._process_frame_bytes(b"jpeg-confirmation-frame")

        activity_calls = [
            call for call in post.call_args_list
            if call.args[0].endswith("/internal/ai/camera-activity")
        ]
        self.assertEqual(len(activity_calls), 1)
        payload = activity_calls[0].kwargs["json"]
        self.assertEqual(payload["cameraId"], "cam-1")
        self.assertEqual(payload["result"]["events"][0]["actionType"], "HELP_REQUESTED")
        self.assertTrue(payload.get("image"), "Confirmation image is attached only on an event")

    def test_worker_does_not_run_activity_when_room_setting_is_disabled(self):
        session = CameraStreamSession(
            camera_id="cam-1",
            provider="RTSP",
            config={"activity_settings": {"HELP_REQUESTED": {"enabled": False}}},
            api_url="http://api.test",
            semaphore=None,
        )
        session.is_online = True
        session.detection_fn = lambda *_: {"people": []}
        session.activity_detection_fn = MagicMock()

        with patch("receiver.requests.post"):
            session._process_frame_bytes(b"jpeg-frame")

        session.activity_detection_fn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
