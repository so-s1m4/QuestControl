# AI Service Storage Architecture, Persistence, and Backup Guide

This document details the production storage architecture, volume persistence, release symlink model, permission configurations, and backup/restore procedures for the QuestControl AI Service.

---

## 1. Storage Architecture & Named Volumes

The QuestControl `ai-service` container manages state across three dedicated directories mapped to named Docker volumes in both `docker-compose.yml` and `docker-compose.portainer.yml`:

| Directory | Named Volume | Description & Lifecycle |
|---|---|---|
| `/app/data` | `ai_data` | Holds raw PTZ captured frames, sidecar JSON metadata, human-in-the-loop verification queue, `.pipeline_job.lock` file, `pipeline_job_status.json`, and the tamper-evident `audit_trail.jsonl`. |
| Directory | Named Volume | Description & Lifecycle |
|---|---|---|
| `/app/data` | `ai_data` | Holds raw PTZ captured frames, sidecar JSON metadata, human-in-the-loop verification queue, `.pipeline_job.lock` file, `pipeline_job_status.json`, and the tamper-evident `audit_trail.jsonl`. |
| `/app/dataset` | `ai_dataset` | Single persistent root holding immutable versioned dataset releases (`/app/dataset/releases/<version>/`) with `path: .` in each release's `dataset.yaml`, alongside the active atomic relative symlink `/app/dataset/current -> releases/<version>`. The persistent mount root is never deleted or replaced. |
| `/app/models` | `ai_models` | Holds versioned candidate model releases (`/app/models/releases/release_<timestamp>_<microsec>_<sha12>_<uuid8>/`), active symlink pointer `/app/models/current`, previous pointer `/app/models/previous`, append-only `activation_journal.jsonl`, and the base general model weights `yolo11n.pt`. |

### Docker Volume Mapping
In both `docker-compose.yml` and `docker-compose.portainer.yml`:
```yaml
services:
  ai-service:
    build: ./apps/ai-service
    volumes:
      - ai_data:/app/data
      - ai_dataset:/app/dataset
      - ai_models:/app/models
    environment:
      - YOLO_MODEL=/app/models/yolo11n.pt
      - HEADSET_MODEL=/app/models/current/vr_headset_yolo.pt
      - HEADSET_MODEL_METADATA=/app/models/current/model_metadata.json

volumes:
  ai_data:
  ai_dataset:
  ai_models:
```

---

## 2. Base Model Preservation (`/opt/models/base/yolo11n.pt`)

When mounting an empty named volume (or recreating containers), volume contents could mask container files baked into the image. To prevent loss of the base model weights (`yolo11n.pt`):

1. **Dockerfile Bake**:
   The base general model `yolo11n.pt` is baked directly into the container image at an immutable system path:
   `/opt/models/base/yolo11n.pt`
2. **Container Entrypoint (`entrypoint.sh`)**:
   Upon container boot, `entrypoint.sh` inspects `/app/models/yolo11n.pt`. If missing (e.g. initial deployment with fresh volume), it copies the baked weights from `/opt/models/base/yolo11n.pt` into `/app/models/yolo11n.pt` and sets correct user ownership.
3. **Runtime Fallback**:
   If `/app/models/yolo11n.pt` is ever removed while the container is running, `load_general_yolo_model()` and `train_headset_model()` automatically fall back to `/opt/models/base/yolo11n.pt`.

---

## 3. Atomic Pointer Symlink & Journal Architecture

To ensure zero-downtime, crash-safe model activation, and elimination of race conditions:

### Single Atomic Pointer Switch & Volume Topology
- Dataset releases are built under `/app/dataset/releases/<version>/` and activated via an atomic relative symlink swap `/app/dataset/current -> releases/<version>`. The persistent mount root `/app/dataset` is never unlinked or replaced.
- Candidate model releases are prepared in collision-proof immutable directories:
  `/app/models/releases/release_%Y%m%d_%H%M%S_%f_<sha12>_<uuid8>/`
  created exclusively (`mkdir(parents=False, exist_ok=False)`) inside the shared parent `releases/` (`mkdir(parents=True, exist_ok=True)`).
- Model activation creates a temporary symlink (`.tmp_curr_<uuid>`) and executes a single atomic POSIX `os.replace` to replace `/app/models/current`.
- Readers always resolve weights and metadata through `/app/models/current/`, guaranteeing that active weights and metadata are never mismatched.

### Crash-Safe Rollback via Append-Only Activation Journal
- All model activations and rollbacks persist an append-only, fsynced record to `/app/models/activation_journal.jsonl` **before** switching the `current` pointer.
- If updating the `previous` rollback pointer fails, the activation transaction immediately aborts before `current` is modified.
- `rollback_model` derives the rollback target deterministically from `activation_journal.jsonl`, ensuring that a missing, deleted, or stale `previous` pointer can never misdirect a rollback.
- On startup, `reconcile_model_pointers()` automatically reconstructs `current` and `previous` pointers from the journal if they were desynchronized during an unexpected crash.

### Stable Inode File Locking
- Pipeline operations (`training`, `activation`, `rollback`) acquire mutual exclusion via `PipelineJobLock` using POSIX `fcntl.flock` on `/app/data/.pipeline_job.lock`.
- The lock file maintains a stable inode and is **never unlinked** upon release, preventing race conditions where processes lock distinct inodes.
- Stale jobs interrupted by container restarts are automatically reconciled to `INTERRUPTED` on startup.

---

## 4. Permissions & User ID

The container executes as non-root user `appuser` (UID `1000`, GID `1000`):
- All volume mounts (`/app/data`, `/app/dataset`, `/app/models`) must be owned by `1000:1000`.
- Host volume permissions (if using bind mounts):
  ```bash
  sudo chown -R 1000:1000 /path/to/volumes/ai_data /path/to/volumes/ai_dataset /path/to/volumes/ai_models
  sudo chmod -R 775 /path/to/volumes/ai_data /path/to/volumes/ai_dataset /path/to/volumes/ai_models
  ```

---

## 5. Backup Procedures

### 5.1 Online Snapshot Backup
Because the AI service uses single atomic pointer switches and append-only audit trails, backups can be performed while containers are running:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DEST="/backups/questcontrol/ai_service/$(date -u +%Y%m%d_%H%M%SZ)"
mkdir -p "$BACKUP_DEST"

echo "Backing up AI Service volumes to $BACKUP_DEST..."

# Back up ai_data volume
docker run --rm \
  -v ai_data:/source:ro \
  -v "$BACKUP_DEST":/backup \
  alpine tar -czf /backup/ai_data.tar.gz -C /source .

# Back up ai_dataset volume
docker run --rm \
  -v ai_dataset:/source:ro \
  -v "$BACKUP_DEST":/backup \
  alpine tar -czf /backup/ai_dataset.tar.gz -C /source .

# Back up ai_models volume
docker run --rm \
  -v ai_models:/source:ro \
  -v "$BACKUP_DEST":/backup \
  alpine tar -czf /backup/ai_models.tar.gz -C /source .

# Generate checksums
(cd "$BACKUP_DEST" && sha256sum *.tar.gz > SHA256SUMS)

echo "Backup completed successfully."
```

### 5.2 Scheduled Cron Example
Run backup daily at 03:00 UTC:
```cron
0 3 * * * /usr/local/bin/backup_ai_service.sh >> /var/log/ai_service_backup.log 2>&1
```

---

## 6. Restore Procedures

### 6.1 Step-by-Step Restoration

1. **Stop AI Service container**:
   ```bash
   docker compose stop ai-service
   ```

2. **Verify Backup Archive Checksums**:
   ```bash
   cd /backups/questcontrol/ai_service/<snapshot_timestamp>
   sha256sum -c SHA256SUMS
   ```

3. **Restore Volumes**:
   ```bash
   # Restore ai_data
   docker run --rm \
     -v ai_data:/target \
     -v "$(pwd)":/backup \
     alpine sh -c "rm -rf /target/* && tar -xzf /backup/ai_data.tar.gz -C /target && chown -R 1000:1000 /target"

   # Restore ai_dataset
   docker run --rm \
     -v ai_dataset:/target \
     -v "$(pwd)":/backup \
     alpine sh -c "rm -rf /target/* && tar -xzf /backup/ai_dataset.tar.gz -C /target && chown -R 1000:1000 /target"

   # Restore ai_models
   docker run --rm \
     -v ai_models:/target \
     -v "$(pwd)":/backup \
     alpine sh -c "rm -rf /target/* && tar -xzf /backup/ai_models.tar.gz -C /target && chown -R 1000:1000 /target"
   ```

4. **Restart Container & Verify State**:
   ```bash
   docker compose up -d ai-service
   docker compose logs -f ai-service
   ```

5. **Post-Restore Verification**:
   Execute a status probe to verify health and model status:
   ```bash
   curl -s http://localhost:8088/pipeline/status | jq .
   curl -s http://localhost:8088/health | jq .
   ```
   Check that `/app/models/current` resolves to the restored release and base model `yolo11n.pt` is present.
