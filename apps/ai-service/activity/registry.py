"""
QuestControl Activity Intelligence - Plugin Registry
Extensible registry for behavioral actions with strict failure isolation and health monitoring.
"""

from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional, Set

from activity.base import ActivityEvent, ActivityPlugin, PersonPose
from activity.hand_wave_classifier import HandWaveClassifier

logger = logging.getLogger("questcontrol.ai.activity.registry")


class BaseActivityPlugin(ActivityPlugin):
    def __init__(
        self,
        action_type: str,
        version: str = "1.0.0",
        enabled: bool = False,
    ):
        self._action_type = action_type
        self._version = version
        self._enabled = enabled
        self._last_error: Optional[str] = None
        self._status = "READY" if enabled else "DISABLED"

    @property
    def action_type(self) -> str:
        return self._action_type

    @property
    def version(self) -> str:
        return self._version

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = bool(value)
        if not self._enabled:
            self._status = "DISABLED"
        elif self._status == "DISABLED":
            self._status = "READY"

    def get_health(self) -> Dict[str, Any]:
        return {
            "actionType": self.action_type,
            "version": self.version,
            "enabled": self.enabled,
            "status": self._status,
            "lastError": self._last_error,
        }

    def reset_camera(self, camera_id: str) -> None:
        pass


class HelpRequestedPlugin(BaseActivityPlugin):
    """
    HELP_REQUESTED / HAND_WAVE Action Plugin.
    Detects hand waving gestures as a distress or assistance signal.
    """
    def __init__(self, enabled: bool = False, **classifier_kwargs):
        super().__init__(action_type="HELP_REQUESTED", version="1.0.0", enabled=enabled)
        self.classifier = HandWaveClassifier(**classifier_kwargs)

    def process_frame(
        self,
        camera_id: str,
        room_id: Optional[str],
        preset_name: Optional[str],
        poses: List[PersonPose],
        timestamp: float,
        is_camera_moving: bool,
    ) -> List[ActivityEvent]:
        return self.classifier.process_frame(
            camera_id=camera_id,
            room_id=room_id,
            preset_name=preset_name,
            poses=poses,
            timestamp=timestamp,
            is_camera_moving=is_camera_moving,
        )

    def reset_camera(self, camera_id: str) -> None:
        self.classifier.reset_camera(camera_id)


class FallDetectedPlugin(BaseActivityPlugin):
    def __init__(self, enabled: bool = False):
        super().__init__(action_type="FALL_DETECTED", version="1.0.0", enabled=enabled)

    def process_frame(self, *args, **kwargs) -> List[ActivityEvent]:
        return []


class ProhibitedZoneEntryPlugin(BaseActivityPlugin):
    def __init__(self, enabled: bool = False):
        super().__init__(action_type="PROHIBITED_ZONE_ENTRY", version="1.0.0", enabled=enabled)

    def process_frame(self, *args, **kwargs) -> List[ActivityEvent]:
        return []


class InactivityPlugin(BaseActivityPlugin):
    def __init__(self, enabled: bool = False):
        super().__init__(action_type="INACTIVITY", version="1.0.0", enabled=enabled)

    def process_frame(self, *args, **kwargs) -> List[ActivityEvent]:
        return []


class ObjectLeftBehindPlugin(BaseActivityPlugin):
    def __init__(self, enabled: bool = False):
        super().__init__(action_type="OBJECT_LEFT_BEHIND", version="1.0.0", enabled=enabled)

    def process_frame(self, *args, **kwargs) -> List[ActivityEvent]:
        return []


class ActivityPluginRegistry:
    def __init__(self):
        self._plugins: Dict[str, ActivityPlugin] = {}
        # Pre-register built-in plugins (disabled by default per requirement 10)
        self.register_plugin(HelpRequestedPlugin(enabled=False))
        self.register_plugin(FallDetectedPlugin(enabled=False))
        self.register_plugin(ProhibitedZoneEntryPlugin(enabled=False))
        self.register_plugin(InactivityPlugin(enabled=False))
        self.register_plugin(ObjectLeftBehindPlugin(enabled=False))

    def register_plugin(self, plugin: ActivityPlugin) -> None:
        self._plugins[plugin.action_type] = plugin
        logger.info("Registered activity plugin: %s (v%s, enabled=%s)", plugin.action_type, plugin.version, plugin.enabled)

    def get_plugin(self, action_type: str) -> Optional[ActivityPlugin]:
        return self._plugins.get(action_type)

    def set_plugin_enabled(self, action_type: str, enabled: bool) -> bool:
        plug = self._plugins.get(action_type)
        if not plug:
            return False
        plug.enabled = enabled
        logger.info("Set activity plugin '%s' enabled=%s", action_type, enabled)
        return True

    def get_all_health(self) -> List[Dict[str, Any]]:
        return [p.get_health() for p in self._plugins.values()]

    def reset_camera(self, camera_id: str) -> None:
        for plug in self._plugins.values():
            try:
                plug.reset_camera(camera_id)
            except Exception as e:
                logger.warning("Error resetting plugin %s for camera %s: %s", plug.action_type, camera_id, e)

    def process_frame(
        self,
        camera_id: str,
        room_id: Optional[str],
        preset_name: Optional[str],
        poses: List[PersonPose],
        timestamp: float,
        is_camera_moving: bool,
        enabled_action_types: Optional[Set[str]] = None,
    ) -> List[ActivityEvent]:
        """
        Runs all enabled plugins on the current frame with strict failure isolation.
        """
        all_events: List[ActivityEvent] = []
        for action_type, plugin in self._plugins.items():
            # The registry's `enabled` flag is a capability switch used by the
            # manual endpoint. Background workers receive the effective,
            # room-scoped settings from the API and must not inherit a global
            # in-memory toggle from another room.
            if enabled_action_types is None:
                should_run = plugin.enabled
            else:
                should_run = action_type in enabled_action_types
            if not should_run:
                continue
            try:
                evs = plugin.process_frame(
                    camera_id=camera_id,
                    room_id=room_id,
                    preset_name=preset_name,
                    poses=poses,
                    timestamp=timestamp,
                    is_camera_moving=is_camera_moving,
                )
                if evs:
                    all_events.extend(evs)
            except Exception as plug_err:
                # Failure isolation: Plugin failure never crashes pipeline or other plugins
                logger.error("Activity plugin '%s' failed during execution: %s", action_type, plug_err, exc_info=True)
                if hasattr(plugin, "_last_error"):
                    plugin._last_error = str(plug_err)
                if hasattr(plugin, "_status"):
                    plugin._status = "ERROR"

        return all_events
