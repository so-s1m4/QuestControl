import { Component, inject, signal, OnDestroy } from "@angular/core";
import { CommonModule } from "@angular/common";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";

interface BBox {
  classId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface QueueSample {
  sampleId: string;
  cameraId: string;
  roomId: string;
  presetName: string;
  captureSessionId?: string | null;
  collectedAt: string;
  bboxes: BBox[];
  verified: boolean;
  approved: boolean;
  negativeConfirmed: boolean;
  operatorId?: string | null;
  notes?: string;
  queueStatus: string;
  hasImage?: boolean;
}

interface PipelineStatus {
  rawFrames: number;
  queuePending: number;
  verifiedSamples: number;
  rejectedSamples: number;
  hasWeights: boolean;
  hasBackup: boolean;
  modelStatus: string;
  modelError?: string | null;
  metrics?: { mAP50?: number; precision?: number; recall?: number } | null;
  jobStatus?: { status?: string; message?: string; progress?: number; error?: string } | null;
}

interface CameraItem {
  id: string;
  name: string;
  room_id?: string;
  location_id?: string;
  status: string;
}

interface WorkerCameraStatus {
  online?: boolean;
  transport?: string;
  lastError?: string | null;
  lastFrame?: number;
}

@Component({
  selector: "app-ai-dataset",
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <main class="ai-page">
    <header class="page-header">
      <div>
        <h2>Разметка датасета и обучение AI</h2>
        <p>Сбор PTZ-кадров, операторская верификация bboxes (vr_headset), экспорт без утечек и контроль качества</p>
      </div>
      <div class="header-actions">
        <button class="secondary" (click)="loadAll()">↻ Обновить</button>
      </div>
    </header>

    @if (error()) { <div class="alert error">{{ error() }}</div> }
    @if (notice()) { <div class="alert success">{{ notice() }}</div> }

    <!-- Pipeline Status Bar -->
    <div class="status-grid">
      <div class="stat-card">
        <span class="label">Статус модели</span>
        <b class="status-badge" [ngClass]="statusClass(status()?.modelStatus)">{{ status()?.modelStatus || 'DATASET_REQUIRED' }}</b>
        <small>{{ status()?.modelError || (status()?.hasWeights ? 'Веса активны' : 'Требуется сбор реальных venue-кадров') }}</small>
      </div>
      <div class="stat-card">
        <span class="label">Очередь разметки</span>
        <b class="stat-num">{{ status()?.queuePending || 0 }}</b>
        <small>Ожидают операторской проверки</small>
      </div>
      <div class="stat-card">
        <span class="label">Проверено (в датасете)</span>
        <b class="stat-num success-num">{{ status()?.verifiedSamples || 0 }}</b>
        <small>Готовы к обучению</small>
      </div>
      <div class="stat-card">
        <span class="label">Отклонено</span>
        <b class="stat-num error-num">{{ status()?.rejectedSamples || 0 }}</b>
        <small>Непригодные кадры</small>
      </div>
      @if (status()?.metrics) {
        <div class="stat-card metrics-card">
          <span class="label">Качество на test-сплите</span>
          <div class="metrics-row">
            <span>mAP50: <b>{{ formatMetric(status()?.metrics?.mAP50) }}</b></span>
            <span>P: <b>{{ formatMetric(status()?.metrics?.precision) }}</b></span>
            <span>R: <b>{{ formatMetric(status()?.metrics?.recall) }}</b></span>
          </div>
        </div>
      }
    </div>

    @if (status()?.jobStatus?.status === 'TRAINING') {
      <div class="job-banner">
        <div class="job-info">
          <b>Идёт обучение модели...</b>
          <span>{{ status()?.jobStatus?.message }}</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" [style.width.%%]="(status()?.jobStatus?.progress || 0.1) * 100"></div></div>
      </div>
    }

    <!-- Main Workspace Layout -->
    <div class="workspace-layout">
      <!-- Left Panel: PTZ Capture & Lifecycle Controls -->
      <aside class="control-panel">
        <section class="panel-section">
          <h3>1. Захват кадра с камеры</h3>
          <p class="section-desc">Получение свежего кадра в заданном пресете и добавление в очередь разметки.</p>
          
          <label>Камера
            <select [(ngModel)]="selectedCameraId" (ngModelChange)="onCameraChange($event)">
              <option value="">Выберите камеру...</option>
              @for (cam of cameras(); track cam.id) {
                <option [value]="cam.id" [disabled]="!cameraReady(cam.id)">{{ cam.name }} — {{ cameraCaptureLabel(cam.id) }}</option>
              }
            </select>
          </label>

          @if (selectedCameraId && !cameraReady(selectedCameraId)) {
            <p class="capture-unavailable">⚠️ Для этой камеры сейчас нет настоящего кадра. Выбери камеру со статусом «Готова · WebRTC».</p>
          }

          <label>Пресет PTZ
            <input type="text" [(ngModel)]="capturePreset" placeholder="default / Base_1 / Shelf" />
          </label>

          <label>Сессия съёмки
            <select [(ngModel)]="selectedSessionId">
              <option value="">(Автоматическая сессия сервера)</option>
              @for (s of activeSessions(); track s.id) {
                <option [value]="s.id">{{ s.camera_name || s.camera_id }} - {{ s.room_name || s.room_id }} ({{ s.id.slice(0, 8) }})</option>
              }
            </select>
          </label>

          <label class="checkbox-label auto-capture-toggle">
            <input type="checkbox" [(ngModel)]="autoCaptureEnabled" />
            AI сам добавляет новые кадры в очередь
          </label>
          @if (autoCaptureEnabled) {
            <label>Интервал автосъёмки (сек.)
              <input type="number" [(ngModel)]="captureIntervalSec" min="3" max="3600" />
            </label>
            <p class="section-desc">Кадры только предлагаются моделью: в датасет попадут после твоего подтверждения.</p>
          }

          <div class="session-actions">
          <button type="button" class="secondary" (click)="startNewSession()" [disabled]="!selectedCameraId || !cameraReady(selectedCameraId)">➕ Начать сессию</button>
            @if (selectedSessionId) {
              <button type="button" class="danger" (click)="stopActiveSession()">⏹ Завершить</button>
            }
          </div>

          <button class="primary btn-block" [disabled]="!selectedCameraId || !cameraReady(selectedCameraId) || capturing()" (click)="captureFrame()">
            {{ capturing() ? 'Захват...' : '📸 Сделать снимок для датасета' }}
          </button>
        </section>

        <section class="panel-section">
          <h3>2. Экспорт и Обучение</h3>
          <label>Версия экспорта
            <input type="text" [(ngModel)]="exportVersion" placeholder="v1.0.0" />
          </label>
          <button class="secondary btn-block" [disabled]="exporting()" (click)="exportSplits()">
            {{ exporting() ? 'Экспорт...' : '📦 Экспортировать сплиты (train/val/test)' }}
          </button>

          <div class="train-controls">
            <label>Эпохи
              <input type="number" [(ngModel)]="trainEpochs" min="1" max="100" />
            </label>
            <label>Batch
              <input type="number" [(ngModel)]="trainBatch" min="1" max="64" />
            </label>
          </div>
          <button class="primary btn-block" [disabled]="training() || status()?.jobStatus?.status === 'TRAINING'" (click)="startTraining()">
            {{ training() ? 'Запуск...' : '🚀 Запустить YOLO-обучение' }}
          </button>
        </section>

        <section class="panel-section">
          <h3>3. Активация и Откат</h3>
          <p class="section-desc">Активация строго перепроверяет метрики на holdout test сплите и выполняет атомарный swap.</p>
          <button class="accent btn-block" [disabled]="activating()" (click)="activateModel()">
            {{ activating() ? 'Активация...' : '✅ Активировать candidate-модель' }}
          </button>
          <button class="danger btn-block" [disabled]="rollingBack() || !status()?.hasBackup" (click)="rollbackModel()">
            {{ rollingBack() ? 'Откат...' : '⏪ Откатить к предыдущему бэкапу' }}
          </button>
        </section>
      </aside>

      <!-- Center & Right: Queue List & Visual BBox Editor -->
      <section class="editor-panel">
        <div class="queue-toolbar">
          <div class="queue-tabs">
            <button [class.active]="queueFilter() === 'pending'" (click)="setFilter('pending')">Очередь ({{ pendingCount() }})</button>
            <button [class.active]="queueFilter() === 'verified'" (click)="setFilter('verified')">Проверенные</button>
            <button [class.active]="queueFilter() === 'rejected'" (click)="setFilter('rejected')">Отклонённые</button>
            <button [class.active]="queueFilter() === 'all'" (click)="setFilter('all')">Все</button>
          </div>
        </div>

        <div class="queue-editor-split">
          <!-- Queue list sidebar -->
          <div class="sample-list">
            @for (item of queueItems(); track item.sampleId) {
              <div class="sample-card" [class.selected]="selectedSample()?.sampleId === item.sampleId" (click)="selectSample(item)">
                <div class="sample-card-head">
                  <span class="sample-id">{{ item.sampleId }}</span>
                  <span class="badge" [ngClass]="item.queueStatus">{{ item.queueStatus }}</span>
                </div>
                <div class="sample-card-meta">
                  <small>{{ item.cameraId }} · {{ item.presetName }}</small>
                  <small>Шлемов: {{ item.bboxes.length || 0 }}</small>
                </div>
                <div class="sample-card-time"><small>{{ formatTime(item.collectedAt) }}</small></div>
              </div>
            } @empty {
              <div class="empty-queue">Кадров в этой категории нет.</div>
            }
          </div>

          <!-- Interactive Bounding Box Review Canvas -->
          <div class="canvas-area">
            @if (selectedSample()) {
              <div class="canvas-wrapper">
                <div class="image-container" (mousedown)="startDrawing($event)" (mousemove)="keepDrawing($event)" (mouseup)="finishDrawing($event)">
                  @if (imageLoading()) {
                    <div class="canvas-loading">Загрузка изображения кадра...</div>
                  }
                  @if (sampleImageUrl()) {
                    <img [src]="sampleImageUrl()!" alt="Venue capture frame" (load)="onImageLoaded($event)" />
                    <svg class="bbox-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                      @for (box of currentBboxes(); track $index) {
                        <g class="bbox-group" (click)="removeBbox($index, $event)">
                          <rect [attr.x]="box.x * 1000" [attr.y]="box.y * 1000" [attr.width]="box.width * 1000" [attr.height]="box.height * 1000" class="bbox-rect" />
                          <text [attr.x]="box.x * 1000 + 4" [attr.y]="box.y * 1000 + 16" class="bbox-label">vr_headset (клик: удалить)</text>
                        </g>
                      }
                      @if (drawingBox()) {
                        <rect [attr.x]="drawingBox()!.x * 1000" [attr.y]="drawingBox()!.y * 1000" [attr.width]="drawingBox()!.width * 1000" [attr.height]="drawingBox()!.height * 1000" class="drawing-rect" />
                      }
                    </svg>
                  }
                </div>

                <!-- BBox editor controls -->
                <div class="sample-actions-bar">
                  <div class="actions-left">
                    <label class="checkbox-label">
                      <input type="checkbox" [(ngModel)]="negativeConfirmed" />
                      Подтвердить отсутствие шлемов (Negative Sample / 0 шт.)
                    </label>
                    <span class="bbox-count-label">Шлемов на кадре: <b>{{ currentBboxes().length }}</b></span>
                  </div>
                  <div class="actions-right">
                    <input type="text" [(ngModel)]="operatorNotes" placeholder="Заметки оператора..." class="notes-input" />
                    <button class="danger" [disabled]="verifying()" (click)="submitVerification(false)">✕ Отклонить кадр</button>
                    <button class="success" [disabled]="verifying() || (!negativeConfirmed && currentBboxes().length === 0)" (click)="submitVerification(true)">✓ Одобрить разметку</button>
                  </div>
                </div>
              </div>
            } @else {
              <div class="no-selection">
                <p>Выберите кадр из списка слева для проверки и редактирования bboxes.</p>
              </div>
            }
          </div>
        </div>
      </section>
    </div>
  </main>
  `,
  styles: [`
    :host { display: block; min-width: 0; }

    /* The main element is the legacy application shell in global styles. This page is
       its own workspace, so it must reset that flex layout explicitly. */
    .ai-page {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 100%;
      padding: 30px 34px 48px;
      margin: 0;
      color: #192235;
      font-family: Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin: 0 0 24px; }
    .page-header h2 { margin: 0; font-size: clamp(24px, 2.2vw, 32px); line-height: 1.15; letter-spacing: -.8px; font-weight: 800; color: #172033; }
    .page-header p { max-width: 760px; margin: 8px 0 0; color: #718096; font-size: 13px; line-height: 1.55; }
    .header-actions { flex: 0 0 auto; }
    
    .status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
    .stat-card { min-width: 0; min-height: 126px; padding: 17px 18px; border: 1px solid #e1e6ef; border-radius: 16px; background: #fff; box-shadow: 0 10px 24px #22305d08; display: flex; flex-direction: column; gap: 7px; }
    .stat-card:first-child { border-color: #d9dcff; background: linear-gradient(135deg, #ffffff, #f4f5ff); }
    .stat-card .label { font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #728096; }
    .stat-num { font-size: 29px; line-height: 1; font-weight: 800; color: #172033; }
    .success-num { color: #16a34a; }
    .error-num { color: #dc2626; }
    .stat-card small { overflow-wrap: anywhere; font-size: 11px; line-height: 1.35; color: #8a97aa; }
    .status-badge { display: inline-flex; align-self: flex-start; max-width: 100%; overflow-wrap: anywhere; padding: 5px 8px; border-radius: 7px; font-size: 11px; line-height: 1.2; font-weight: 800; }
    .status-badge.ready { background: #dcfce7; color: #15803d; }
    .status-badge.required { background: #fef9c3; color: #a16207; }
    .status-badge.error { background: #fee2e2; color: #b91c1c; }
    .metrics-card { grid-column: span 2; }
    .metrics-card .metrics-row { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 13px; color: #46556b; margin-top: 6px; }
    .metrics-row b { color: #2563eb; }

    .job-banner { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; }
    .job-info { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: #1e40af; }
    .progress-bar { height: 8px; background: #dbeafe; border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: #3b82f6; transition: width 0.3s ease; }

    .workspace-layout { display: grid; grid-template-columns: minmax(290px, 350px) minmax(0, 1fr); align-items: start; gap: 20px; min-width: 0; }
    .control-panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .panel-section { min-width: 0; padding: 18px; border: 1px solid #e1e6ef; border-radius: 16px; background: #fff; box-shadow: 0 10px 24px #22305d08; display: flex; flex-direction: column; gap: 12px; }
    .panel-section h3 { margin: 0; font-size: 15px; font-weight: 800; color: #273249; }
    .section-desc { margin: -3px 0 2px; font-size: 11px; color: #78869a; line-height: 1.5; }
    .capture-unavailable { margin: -4px 0 0; padding: 8px 9px; border: 1px solid #fed7aa; border-radius: 8px; background: #fff7ed; color: #9a3412; font-size: 11px; line-height: 1.4; }
    .panel-section label { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 11px; font-weight: 800; color: #56657a; }
    .panel-section select, .panel-section input { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid #d2dae7; border-radius: 8px; background: #fff; color: #273249; font-size: 13px; outline: none; }
    .panel-section select:focus, .panel-section input:focus, .notes-input:focus { border-color: #727af2; box-shadow: 0 0 0 3px #5966e715; }
    .train-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

    .btn-block { width: 100%; min-height: 42px; padding: 10px 12px; border: 0; border-radius: 9px; font-size: 12px; font-weight: 800; cursor: pointer; transition: transform .15s, background .15s, box-shadow .15s; }
    .primary { background: linear-gradient(135deg, #4f5fe8, #6575ef); color: #fff; box-shadow: 0 7px 14px #4f5fe82b; }
    .primary:hover { background: linear-gradient(135deg, #4453d8, #5667e6); transform: translateY(-1px); }
    .secondary { background: #f6f8fc; color: #45556b; border: 1px solid #d7deea; box-shadow: none; }
    .secondary:hover { background: #edf1f8; }
    .accent { background: #16a34a; color: #fff; }
    .accent:hover { background: #15803d; }
    .danger { background: #dc2626; color: #fff; }
    .danger:hover { background: #b91c1c; }
    .success { background: #16a34a; color: #fff; }
    .success:hover { background: #15803d; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    .editor-panel { min-width: 0; border: 1px solid #e1e6ef; border-radius: 16px; background: #fff; box-shadow: 0 10px 24px #22305d08; display: flex; flex-direction: column; overflow: hidden; }
    .queue-toolbar { padding: 13px 16px; border-bottom: 1px solid #e8ecf3; background: linear-gradient(135deg, #fafbff, #f6f7fc); }
    .queue-tabs { display: flex; flex-wrap: wrap; gap: 7px; }
    .queue-tabs button { padding: 7px 11px; border: 1px solid #d9e0eb; background: #fff; color: #64748b; border-radius: 8px; font-size: 11px; font-weight: 800; cursor: pointer; box-shadow: none; }
    .queue-tabs button.active { background: #4f5fe8; color: #fff; border-color: #4f5fe8; }

    .queue-editor-split { display: grid; grid-template-columns: minmax(230px, 280px) minmax(0, 1fr); min-height: 610px; min-width: 0; }
    .sample-list { min-width: 0; border-right: 1px solid #e8ecf3; overflow-y: auto; max-height: 650px; background: #f8f9fc; }
    .sample-card { padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.15s; }
    .sample-card:hover { background: #f1f5f9; }
    .sample-card.selected { background: #e0e7ff; border-left: 4px solid #4f46e5; }
    .sample-card-head { display: flex; justify-content: space-between; align-items: center; }
    .sample-id { font-weight: 700; font-size: 13px; color: #1e293b; }
    .sample-card-meta { display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: #64748b; }
    .sample-card-time { margin-top: 4px; font-size: 11px; color: #94a3b8; }
    .empty-queue { padding: 30px; text-align: center; color: #94a3b8; font-size: 14px; }

    .badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .badge.pending { background: #fef3c7; color: #b45309; }
    .badge.verified { background: #dcfce7; color: #15803d; }
    .badge.rejected { background: #fee2e2; color: #b91c1c; }

    .canvas-area { min-width: 0; display: flex; flex-direction: column; background: #111a2b; position: relative; }
    .canvas-wrapper { display: flex; flex-direction: column; height: 100%; }
    .image-container { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; user-select: none; cursor: crosshair; }
    .image-container img { max-width: 100%; max-height: 560px; object-fit: contain; display: block; }
    .bbox-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: auto; }
    .bbox-rect { fill: rgba(37, 99, 235, 0.25); stroke: #3b82f6; stroke-width: 3; cursor: pointer; }
    .bbox-rect:hover { fill: rgba(220, 38, 38, 0.4); stroke: #ef4444; }
    .bbox-label { fill: #fff; font-size: 14px; font-weight: 700; }
    .drawing-rect { fill: rgba(16, 185, 129, 0.3); stroke: #10b981; stroke-width: 2; stroke-dasharray: 4; }

    .sample-actions-bar { background: #fff; padding: 14px 18px; border-top: 1px solid #e2e8f0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px 16px; }
    .actions-left { display: flex; align-items: center; gap: 16px; }
    .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #334155; cursor: pointer; }
    .bbox-count-label { font-size: 13px; color: #64748b; }
    .actions-right { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
    .notes-input { min-width: 180px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; width: 220px; outline: none; }

    .no-selection { height: 100%; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 15px; }
    .alert { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; font-weight: 600; }
    .alert.error { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
    .alert.success { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }

    .session-actions { display: flex; gap: 8px; }
    .session-actions button { flex: 1; padding: 6px 10px; font-size: 12px; }
    .canvas-loading { color: #94a3b8; font-size: 14px; font-weight: 600; padding: 24px; text-align: center; }

    @media (max-width: 1240px) {
      .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workspace-layout { grid-template-columns: 310px minmax(0, 1fr); }
      .queue-editor-split { grid-template-columns: 230px minmax(0, 1fr); }
    }
    /* Desktop navigation is rendered by app-root as a fixed 280px sidebar,
       while this route is rendered directly by router-outlet. Reserve that
       column here instead of allowing the page to sit underneath it. */
    @media (min-width: 1001px) {
      .ai-page { width: calc(100% - 280px); margin-left: 280px; }
    }
    @media (min-width: 761px) and (max-width: 1000px) {
      .ai-page { width: calc(100% - 228px); margin-left: 228px; }
    }
    @media (max-width: 980px) {
      .ai-page { padding: 24px 20px 42px; }
      .workspace-layout { grid-template-columns: 1fr; }
      .queue-editor-split { grid-template-columns: 1fr; }
      .sample-list { max-height: 250px; }
    }
    @media (max-width: 620px) {
      .ai-page { padding: 20px 14px 96px; }
      .page-header { flex-direction: column; gap: 14px; }
      .header-actions, .header-actions button { width: 100%; }
      .status-grid { grid-template-columns: 1fr; }
      .metrics-card { grid-column: auto; }
      .panel-section { padding: 16px; }
      .session-actions, .actions-left, .actions-right { align-items: stretch; flex-direction: column; }
      .actions-right, .notes-input { width: 100%; }
      .queue-tabs button { flex: 1 1 auto; }
    }
  `]
})
export class AiDatasetComponent implements OnDestroy {
  private http = inject(HttpClient);
  private router = inject(Router);

  status = signal<PipelineStatus | null>(null);
  cameras = signal<CameraItem[]>([]);
  workerStatuses = signal<Record<string, WorkerCameraStatus>>({});
  queueItems = signal<QueueSample[]>([]);
  queueFilter = signal<string>("pending");
  selectedSample = signal<QueueSample | null>(null);

  sampleImageUrl = signal<string | null>(null);
  imageLoading = signal<boolean>(false);
  private currentBlobUrl: string | null = null;

  activeSessions = signal<any[]>([]);
  selectedSessionId = "";
  sessionNotes = "";
  autoCaptureEnabled = true;
  captureIntervalSec = 12;

  selectedCameraId = "";
  capturePreset = "default";
  exportVersion = "v1.0.0";
  trainEpochs = 10;
  trainBatch = 8;

  capturing = signal(false);
  verifying = signal(false);
  exporting = signal(false);
  training = signal(false);
  activating = signal(false);
  rollingBack = signal(false);

  error = signal("");
  notice = signal("");

  currentBboxes = signal<BBox[]>([]);
  negativeConfirmed = false;
  operatorNotes = "";

  drawingBox = signal<BBox | null>(null);
  private isDrawing = false;
  private startX = 0;
  private startY = 0;
  private imgBounds: DOMRect | null = null;
  private pollTimer: any = null;
  private reportedActivationJobId = "";

  constructor() {
    this.loadAll();
    this.pollTimer = setInterval(() => this.checkJobStatus(), 4000);
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
  }

  loadAll() {
    this.loadStatus();
    this.loadCameras();
    this.loadWorkerStatuses();
    this.loadActiveSessions();
    this.loadQueue();
  }

  loadStatus() {
    this.http.get<PipelineStatus>("/api/ai/dataset/status").subscribe({
      next: (s) => this.status.set(s),
      error: () => this.error.set("Не удалось получить статус AI пайплайна."),
    });
  }

  loadCameras() {
    this.http.get<CameraItem[]>("/api/cameras").subscribe({
      next: (cams) => this.cameras.set(cams),
    });
  }

  loadWorkerStatuses() {
    this.http.get<{ cameras: Record<string, WorkerCameraStatus> }>("/api/ai/dataset/camera-status").subscribe({
      next: (result) => this.workerStatuses.set(result.cameras || {}),
      error: () => this.workerStatuses.set({}),
    });
  }

  cameraReady(cameraId: string): boolean {
    const worker = this.workerStatuses()[cameraId];
    // Before the async health endpoint replies, keep the selector usable.
    // Once a worker has reported, require a live WebRTC frame; HLS black
    // placeholders are deliberately rejected by the server.
    if (!worker) return true;
    return worker.online === true && worker.transport === "WEBRTC" && !!worker.lastFrame;
  }

  cameraCaptureLabel(cameraId: string): string {
    const worker = this.workerStatuses()[cameraId];
    if (!worker) return "проверка потока…";
    if (worker.online && worker.transport === "WEBRTC" && worker.lastFrame) return "Готова · WebRTC";
    if (worker.lastError === "FRAME_NOT_READY") return "Нет кадра";
    if (worker.lastError) return "Поток недоступен";
    return "Подключение…";
  }

  loadActiveSessions() {
    this.http.get<{ sessions: any[] }>("/api/ai/dataset/sessions/active").subscribe({
      next: (res) => this.activeSessions.set(res.sessions || []),
      error: () => {},
    });
  }

  startNewSession() {
    if (!this.selectedCameraId) {
      this.error.set("Выберите камеру для старта сессии захвата.");
      return;
    }
    const cam = this.cameras().find((c) => c.id === this.selectedCameraId);
    const roomId = cam?.room_id;
    if (!roomId) {
      this.error.set("Выбранная камера не привязана к комнате.");
      return;
    }

    this.http.post<any>("/api/ai/dataset/sessions/start", {
      roomId,
      cameraId: this.selectedCameraId,
      notes: this.sessionNotes || "Операторская сессия захвата",
      autoCaptureEnabled: this.autoCaptureEnabled,
      captureIntervalSec: this.captureIntervalSec,
    }).subscribe({
      next: (sess) => {
        this.notice.set(`Сессия захвата ${sess.id.slice(0, 8)} успешно запущена.`);
        this.selectedSessionId = sess.id;
        this.loadActiveSessions();
      },
      error: (err) => {
        this.error.set(`Ошибка запуска сессии: ${err.error?.message || err.message}`);
      },
    });
  }

  stopActiveSession() {
    if (!this.selectedSessionId) return;
    const sessId = this.selectedSessionId;
    this.http.post<any>(`/api/ai/dataset/sessions/${sessId}/stop`, {}).subscribe({
      next: () => {
        this.notice.set(`Сессия ${sessId.slice(0, 8)} завершена.`);
        this.selectedSessionId = "";
        this.loadActiveSessions();
      },
      error: (err) => {
        this.error.set(`Ошибка завершения сессии: ${err.error?.message || err.message}`);
      },
    });
  }

  loadQueue() {
    this.http.get<{ items: QueueSample[] }>(`/api/ai/dataset/queue?status=${this.queueFilter()}`).subscribe({
      next: (res) => {
        this.queueItems.set(res.items || []);
        if (this.selectedSample()) {
          const updated = (res.items || []).find((x) => x.sampleId === this.selectedSample()!.sampleId);
          if (updated) this.selectSample(updated);
        }
      },
    });
  }

  checkJobStatus() {
    this.http.get<any>("/api/ai/model/job-status").subscribe({
      next: (js) => {
        if (this.status()) {
          this.status.update((old) => old ? { ...old, jobStatus: js } : null);
        }
        const jobType = js?.jobType || js?.job_type;
        const jobId = js?.jobId || js?.job_id || "";
        const jobState = js?.status;
        if (
          jobType === "activation" &&
          jobId &&
          jobId !== this.reportedActivationJobId &&
          ["COMPLETED", "FAILED", "ACTIVATION_STATE_UNCERTAIN"].includes(jobState)
        ) {
          this.reportedActivationJobId = jobId;
          if (jobState === "COMPLETED") {
            this.notice.set("Активация завершена. Обновляю проверенный статус модели.");
          } else {
            this.error.set(`Активация модели не выполнена: ${js?.error || js?.message || jobState}`);
          }
          this.loadStatus();
        }
      },
    });
  }

  setFilter(filter: string) {
    this.queueFilter.set(filter);
    this.loadQueue();
  }

  pendingCount(): number {
    return this.status()?.queuePending || 0;
  }

  onCameraChange(cameraId: string) {
    this.selectedCameraId = cameraId;
    const active = this.activeSessions().find((s) => s.camera_id === cameraId);
    if (active) {
      this.selectedSessionId = active.id;
    }
  }

  selectSample(sample: QueueSample) {
    this.selectedSample.set(sample);
    this.currentBboxes.set(JSON.parse(JSON.stringify(sample.bboxes || [])));
    this.negativeConfirmed = !!sample.negativeConfirmed;
    this.operatorNotes = sample.notes || "";

    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    this.sampleImageUrl.set(null);
    this.imageLoading.set(true);

    this.http.get(`/api/ai/dataset/samples/${sample.sampleId}/image`, { responseType: "blob" }).subscribe({
      next: (blob) => {
        this.imageLoading.set(false);
        this.currentBlobUrl = URL.createObjectURL(blob);
        this.sampleImageUrl.set(this.currentBlobUrl);
      },
      error: (err) => {
        this.imageLoading.set(false);
        this.error.set(`Не удалось загрузить кадр: ${err.status || err.message}`);
      },
    });
  }

  captureFrame() {
    if (!this.selectedCameraId) return;
    this.capturing.set(true);
    this.error.set("");
    this.notice.set("");

    const cam = this.cameras().find((c) => c.id === this.selectedCameraId);
    const roomId = cam?.room_id;
    if (!roomId) {
      this.capturing.set(false);
      this.error.set("Камера не привязана к комнате");
      return;
    }

    this.http.post<any>("/api/ai/dataset/capture", {
      cameraId: this.selectedCameraId,
      roomId,
      preset: this.capturePreset,
      captureSessionId: this.selectedSessionId || undefined,
    }).subscribe({
      next: (res) => {
        this.capturing.set(false);
        this.notice.set(`Снимок захвачен и добавлен в очередь: ${res.sampleId}`);
        this.loadAll();
      },
      error: (err) => {
        this.capturing.set(false);
        this.error.set(`Ошибка захвата: ${err.error?.message || err.message}`);
      },
    });
  }

  onImageLoaded(event: Event) {
    const img = event.target as HTMLImageElement;
    this.imgBounds = img.getBoundingClientRect();
  }

  startDrawing(event: MouseEvent) {
    const container = event.currentTarget as HTMLElement;
    this.imgBounds = container.getBoundingClientRect();
    if (!this.imgBounds) return;

    this.isDrawing = true;
    this.startX = Math.max(0, Math.min(1, (event.clientX - this.imgBounds.left) / this.imgBounds.width));
    this.startY = Math.max(0, Math.min(1, (event.clientY - this.imgBounds.top) / this.imgBounds.height));
    this.drawingBox.set({ classId: 0, x: this.startX, y: this.startY, width: 0, height: 0 });
  }

  keepDrawing(event: MouseEvent) {
    if (!this.isDrawing || !this.imgBounds) return;
    const currentX = Math.max(0, Math.min(1, (event.clientX - this.imgBounds.left) / this.imgBounds.width));
    const currentY = Math.max(0, Math.min(1, (event.clientY - this.imgBounds.top) / this.imgBounds.height));

    const x = Math.min(this.startX, currentX);
    const y = Math.min(this.startY, currentY);
    const width = Math.abs(currentX - this.startX);
    const height = Math.abs(currentY - this.startY);

    this.drawingBox.set({ classId: 0, x, y, width, height });
  }

  finishDrawing(event: MouseEvent) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const box = this.drawingBox();
    this.drawingBox.set(null);

    if (box && box.width > 0.02 && box.height > 0.02) {
      this.currentBboxes.update((list) => [...list, {
        classId: 0,
        x: Number(box.x.toFixed(4)),
        y: Number(box.y.toFixed(4)),
        width: Number(box.width.toFixed(4)),
        height: Number(box.height.toFixed(4)),
      }]);
    }
  }

  removeBbox(index: number, event: MouseEvent) {
    event.stopPropagation();
    this.currentBboxes.update((list) => list.filter((_, i) => i !== index));
  }

  submitVerification(approved: boolean) {
    const sample = this.selectedSample();
    if (!sample) return;

    this.verifying.set(true);
    this.error.set("");
    this.notice.set("");

    this.http.post<any>(`/api/ai/dataset/samples/${sample.sampleId}/verify`, {
      approved,
      correctedBboxes: this.currentBboxes(),
      negativeConfirmed: this.negativeConfirmed,
      notes: this.operatorNotes,
    }).subscribe({
      next: () => {
        this.verifying.set(false);
        this.notice.set(`Кадр ${sample.sampleId} успешно ${approved ? 'одобрен' : 'отклонён'}.`);
        this.selectedSample.set(null);
        this.loadAll();
      },
      error: (err) => {
        this.verifying.set(false);
        this.error.set(`Ошибка валидации: ${err.error?.message || err.message}`);
      },
    });
  }

  exportSplits() {
    this.exporting.set(true);
    this.error.set("");
    this.notice.set("");

    this.http.post<any>("/api/ai/dataset/export", { version: this.exportVersion }).subscribe({
      next: (res) => {
        this.exporting.set(false);
        this.notice.set(`Датасет ${res.version} успешно экспортирован (train: ${res.splitCounts?.train}, val: ${res.splitCounts?.val}, test: ${res.splitCounts?.test}).`);
        this.loadAll();
      },
      error: (err) => {
        this.exporting.set(false);
        this.error.set(`Ошибка экспорта датасета: ${err.error?.message || err.message}`);
      },
    });
  }

  startTraining() {
    this.training.set(true);
    this.error.set("");
    this.notice.set("");

    this.http.post<any>("/api/ai/model/train", {
      epochs: this.trainEpochs,
      batchSize: this.trainBatch,
      imgSize: 640,
    }).subscribe({
      next: () => {
        this.training.set(false);
        this.notice.set("Фоновое обучение модели запущено.");
        this.loadStatus();
      },
      error: (err) => {
        this.training.set(false);
        this.error.set(`Ошибка запуска обучения: ${err.error?.message || err.message}`);
      },
    });
  }

  activateModel() {
    this.activating.set(true);
    this.error.set("");
    this.notice.set("");

    this.http.post<any>("/api/ai/model/activate", { version: this.exportVersion }).subscribe({
      next: (res) => {
        this.activating.set(false);
        // Activation runs in the AI service background. A 202/STARTED result
        // only means that validation began; it is not proof of an active
        // model. In particular, do not show a fake "release undefined" success
        // while the candidate is missing or fails its holdout quality gate.
        if (res?.status === "STARTED") {
          this.notice.set("Проверка и активация модели запущены. Дождитесь статуса COMPLETED.");
          this.checkJobStatus();
          return;
        }
        if (res?.releaseId && res?.metrics?.mAP50 !== undefined) {
          this.notice.set(`Модель успешно активирована (релиз ${res.releaseId}, mAP50: ${this.formatMetric(res.metrics.mAP50)}).`);
          this.loadAll();
          return;
        }
        this.error.set(res?.message || "Активация не подтверждена: модель не была активирована.");
        this.checkJobStatus();
      },
      error: (err) => {
        this.activating.set(false);
        this.error.set(`Ошибка активации модели: ${err.error?.message || err.message}`);
      },
    });
  }

  rollbackModel() {
    if (!confirm("Вы уверены, что хотите откатить модель к предыдущему бэкапу?")) return;
    this.rollingBack.set(true);
    this.error.set("");
    this.notice.set("");

    this.http.post<any>("/api/ai/model/rollback", {}).subscribe({
      next: () => {
        this.rollingBack.set(false);
        this.notice.set("Модель успешно возвращена к предыдущей версии.");
        this.loadAll();
      },
      error: (err) => {
        this.rollingBack.set(false);
        this.error.set(`Ошибка отката: ${err.error?.message || err.message}`);
      },
    });
  }

  statusClass(st?: string): string {
    if (st === "READY") return "ready";
    if (st === "DATASET_REQUIRED") return "required";
    return "error";
  }

  formatMetric(val?: number): string {
    return val !== undefined && val !== null ? (val * 100).toFixed(1) + "%" : "—";
  }

  formatTime(iso?: string): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("ru-RU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }
}
