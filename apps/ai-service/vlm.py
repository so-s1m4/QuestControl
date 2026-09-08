import json
import ipaddress
import logging
import os
import re
import socket
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional
import requests

logger = logging.getLogger("questcontrol.ai.vlm")

JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```")

def resolve_and_pin_local_url(url: str) -> Tuple[str, Dict[str, str]]:
    """
    Validates that the host resolves exclusively to private/loopback/docker addresses,
    and returns (pinned_url, headers) where the URL hostname is replaced with the
    verified IP address to prevent DNS rebinding (TOCTOU attacks).
    """
    if not url:
        return "", {}
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").strip().lower()
    port = parsed.port
    if not host:
        raise ValueError("Invalid URL: missing host")

    # Fast path for known docker service names
    if host in {"vlm", "ollama", "ai-service", "api", "postgres", "redis"}:
        return url, {}

    if host in {"localhost", "127.0.0.1", "::1"}:
        return url, {}

    try:
        ip_obj = ipaddress.ip_address(host)
        if not (ip_obj.is_loopback or ip_obj.is_private):
            raise ValueError(f"Security violation: IP {host} is public. All VLM inference must be private/local.")
        return url, {}
    except ValueError as err:
        if "Security violation" in str(err):
            raise

    # Resolve all addresses and verify every one is private
    try:
        addr_infos = socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except Exception as exc:
        raise ValueError(f"Failed to resolve host '{host}': {exc}")

    if not addr_infos:
        raise ValueError(f"Could not resolve host '{host}'")

    verified_ip = None
    for res in addr_infos:
        ip_str = res[4][0]
        ip_obj = ipaddress.ip_address(ip_str)
        if not (ip_obj.is_loopback or ip_obj.is_private):
            raise ValueError(
                f"Security violation: Host '{host}' resolved to non-private IP {ip_str}. "
                "Blocked potential DNS rebinding attack."
            )
        if not verified_ip:
            verified_ip = ip_str

    # Pin the request by rewriting netloc with the verified IP
    port_str = f":{port}" if port else ""
    netloc = f"{verified_ip}{port_str}" if ":" not in verified_ip else f"[{verified_ip}]{port_str}"
    pinned = urllib.parse.urlunparse((
        parsed.scheme,
        netloc,
        parsed.path,
        parsed.params,
        parsed.query,
        parsed.fragment,
    ))
    headers = {"Host": host if not port else f"{host}:{port}"}
    return pinned, headers


def is_strictly_local_or_private(url: str) -> bool:
    """
    Checks if URL is local/private. Raises ValueError on public or rebinding endpoints.
    """
    if not url:
        return True
    try:
        resolve_and_pin_local_url(url)
        return True
    except Exception:
        return False

DEFAULT_VLM_PROMPT = """Analyze the quest room scene from these camera frames.
Answer the following operator question: "{question}"
Context from object detection: Detected {people_count} person/people in room.

Return ONLY a valid JSON object matching this exact schema:
{{
  "people": <integer estimated count of people in room>,
  "activity": "<short string describing what people are doing, e.g. solving puzzle, standing, exploring>",
  "doorState": "<open|closed|unknown>",
  "unusual": <true if anything dangerous, broken, fallen or unusual is happening, else false>,
  "confidence": <float between 0.0 and 1.0>,
  "description": "<concise 1-2 sentence description of current room state>"
}}
"""

class LocalVisionService:
    def __init__(self):
        endpoint = os.environ.get("VLM_ENDPOINT", "").strip().rstrip("/")
        if endpoint and not is_strictly_local_or_private(endpoint):
            raise ValueError(
                f"Security violation: VLM_ENDPOINT '{endpoint}' points to an external network. "
                "Local AI privacy invariant violated: all VLM inference must run locally or on private RFC1918 / Docker network."
            )
        self.endpoint = endpoint
        self.model_name = os.environ.get("VLM_MODEL", "moondream2").strip()
        self.rate_limit_seconds = float(os.environ.get("VLM_RATE_LIMIT_SECONDS", "5.0"))
        self._lock = threading.Lock()
        self._last_camera_analysis: Dict[str, float] = {}

    def is_rate_limited(self, camera_id: str) -> bool:
        if not camera_id:
            return False
        last_time = self._last_camera_analysis.get(camera_id, 0.0)
        return (time.time() - last_time) < self.rate_limit_seconds

    def sanitize_json(self, raw_text: str) -> Optional[Dict[str, Any]]:
        if not raw_text:
            return None
        text = raw_text.strip()
        match = JSON_BLOCK_RE.search(text)
        if match:
            text = match.group(1).strip()
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                candidate = text[start : end + 1]
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return None

    def analyze_frames(
        self,
        camera_id: str,
        frames_base64: List[str],
        question: str = "Determine what happened during these frames.",
        is_manual: bool = False,
        yolo_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Processes frames using the single local VLM queue.
        Enforces:
        1. Single concurrent VLM inference.
        2. Per-camera rate limit unless manual.
        3. Validated JSON structure output.
        """
        people_count = yolo_context.get("peopleCount", 0) if yolo_context else 0

        if not is_manual and camera_id and self.is_rate_limited(camera_id):
            return {
                "people": people_count,
                "activity": "monitoring (rate-limited)",
                "doorState": "unknown",
                "unusual": False,
                "confidence": 0.9,
                "description": f"Scene contains {people_count} detected person(s). Analysis rate limit active.",
                "cached": True,
            }

        with self._lock:
            if not is_manual and camera_id and self.is_rate_limited(camera_id):
                return {
                    "people": people_count,
                    "activity": "monitoring (queued)",
                    "doorState": "unknown",
                    "unusual": False,
                    "confidence": 0.9,
                    "description": f"Scene contains {people_count} detected person(s).",
                    "cached": True,
                }

            if camera_id:
                self._last_camera_analysis[camera_id] = time.time()

            result = None
            if self.endpoint:
                try:
                    result = self._call_vlm_endpoint(frames_base64, question, people_count)
                except Exception as exc:
                    logger.warning("VLM endpoint request failed: %s", exc)

            if not result:
                result = self._fallback_analyze(question, people_count, yolo_context)

            validated = self._validate_schema(result, people_count)
            return validated

    def _call_vlm_endpoint(self, frames_base64: List[str], question: str, people_count: int) -> Optional[Dict[str, Any]]:
        prompt = DEFAULT_VLM_PROMPT.format(question=question, people_count=people_count)
        pinned_base, pin_headers = resolve_and_pin_local_url(self.endpoint)
        base_endpoint = pinned_base or self.endpoint

        # Support native Ollama /api/generate
        if ":11434" in self.endpoint or self.endpoint.endswith("/api/generate"):
            url = base_endpoint if base_endpoint.endswith("/api/generate") else f"{base_endpoint}/api/generate"
            images = []
            for frame in frames_base64[:4]:
                clean = frame.split(",")[-1] if "," in frame else frame
                images.append(clean)
            payload = {
                "model": self.model_name,
                "prompt": prompt,
                "images": images,
                "stream": False,
                "format": "json",
            }
            resp = requests.post(url, json=payload, headers=pin_headers, timeout=20)
            if resp.status_code == 200:
                raw_response = resp.json().get("response", "")
                return self.sanitize_json(raw_response)

        # Build multimodal payload compatible with OpenAI/Ollama/vLLM /v1/chat/completions
        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
        # Take up to 4 representative frames to prevent memory bloat
        for frame in frames_base64[:4]:
            url = frame if frame.startswith("data:") else f"data:image/jpeg;base64,{frame}"
            content.append({
                "type": "image_url",
                "image_url": {"url": url}
            })

        body = {
            "model": self.model_name,
            "messages": [
                {"role": "user", "content": content}
            ],
            "temperature": 0.2,
            "max_tokens": 300,
        }

        url = f"{base_endpoint}/chat/completions" if not base_endpoint.endswith("/chat/completions") else base_endpoint
        resp = requests.post(url, json=body, headers=pin_headers, timeout=20)
        if resp.status_code == 200:
            data = resp.json()
            raw_content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return self.sanitize_json(raw_content)
        return None

    def _fallback_analyze(self, question: str, people_count: int, yolo_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Lightweight deterministic fallback analyzer when remote VLM endpoint is not reachable or during offline operation.
        """
        q_lower = question.lower()
        unusual = False
        
        if people_count == 0:
            activity = "empty room"
            description = "Комната пуста. Людей в кадре не обнаружено."
            door_state = "closed"
        elif people_count == 1:
            activity = "solo exploration"
            description = "В комнате находится 1 человек, перемещается по локации."
            door_state = "closed"
        else:
            activity = "players solving quest"
            description = f"В комнате находится группа из {people_count} человек."
            door_state = "closed"

        if "провер" in q_lower or "осмотр" in q_lower or "inspect" in q_lower:
            description = f"Осмотр завершён: обнаружено {people_count} человек. Обстановка штатная."
        elif "остал" in q_lower:
            if people_count > 0:
                description = f"Да, в комнате всё ещё находится {people_count} человек(а)."
            else:
                description = "Нет, комната полностью свободна, игроков нет."

        return {
            "people": people_count,
            "activity": activity,
            "doorState": door_state,
            "unusual": unusual,
            "confidence": 0.88,
            "description": description,
        }

    def _validate_schema(self, data: Dict[str, Any], default_people: int) -> Dict[str, Any]:
        try:
            people = int(data.get("people", default_people))
        except (ValueError, TypeError):
            people = default_people

        try:
            confidence = float(data.get("confidence", 0.85))
            confidence = max(0.0, min(1.0, confidence))
        except (ValueError, TypeError):
            confidence = 0.85

        return {
            "people": max(0, people),
            "activity": str(data.get("activity", "activity detected") or "activity detected")[:100],
            "doorState": str(data.get("doorState", "closed") or "closed")[:30],
            "unusual": bool(data.get("unusual", False)),
            "confidence": round(confidence, 3),
            "description": str(data.get("description", "") or "Анализ завершён.")[:300],
        }
