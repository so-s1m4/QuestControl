# Room-agent automatic updates

The production API publishes the `stable` room-agent release. Downloads require the existing `AGENT_ID` and `AGENT_TOKEN`; no GitHub credential is stored on a Raspberry Pi.

For an existing installation, upload the prepared bootstrap archive, extract it, and run:

```sh
sudo ./bootstrap-auto-update.sh
```

The bootstrap preserves the existing installation as the first rollback release. The timer checks every ten minutes with a randomized delay. Each update verifies SHA-256, installs into a new version directory, switches the `current` symlink atomically, and rolls back if the service does not reconnect.

Useful checks:

```sh
systemctl status quest-room-agent.service
systemctl status quest-room-agent-update.timer
journalctl -u quest-room-agent-update.service -n 50 --no-pager
sudo systemctl start quest-room-agent-update.service
```
