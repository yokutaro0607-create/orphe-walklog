(function gaitReportApp(root) {
  "use strict";

  const Stats = root.GaitReportStats;
  const I18n = root.GaitReportI18n;
  const Sound = root.GaitReportSound || null;   // optional: sound.js が無いページでも動く

  if (!Stats) {
    throw new Error("gait-report: report.js must be loaded before app.js");
  }
  if (!I18n) {
    throw new Error("gait-report: i18n.js must be loaded before app.js");
  }

  const TARGET = Infinity;  // 連続記録版: 20歩で止めず「記録を止める」まで全歩を残す
  const SIDES = Stats.SIDES;
  const DEVICE_IDS = [0, 1];
  const DEMO_STEP_INTERVAL_MS = 530;
  const PAGE_PARAMS = new URLSearchParams(root.location ? root.location.search : "");
  // ?verify=0: FW疎通デバッグ用。Step Analysis のliveness検証を外して接続を維持し、
  // 通知が「いつか来るのか/一切来ないのか」を観察できるようにする。
  const VERIFY_GAIT = PAGE_PARAMS.get("verify") !== "0";

  const state = {
    sessions: [null, null],
    deviceSides: ["left", "right"],
    connected: [false, false],
    recording: false,
    complete: false,
    startedAt: null,
    completedAt: null,
    lastStepAt: null,
    idleReceiving: false,
    sessionSource: null,
    rows: { left: [], right: [] },
    source: "waiting",
    sourceCopy: null,
    demo: {
      running: false,
      timer: null,
      nextStepAt: 0,
      nextSide: "left",
      counts: { left: 0, right: 0 }
    },
    dom: {}
  };

  // ---------------------------------------------------------------- helpers

  function t(key, params, fallback) {
    return I18n.t(key, params, fallback);
  }

  function locale() {
    return I18n.getLanguage() === "ja" ? "ja-JP" : "en-US";
  }

  function nowMs() {
    return root.performance && typeof root.performance.now === "function"
      ? root.performance.now()
      : Date.now();
  }

  function fmt(value, decimals) {
    return Stats.formatNumber(value, decimals);
  }

  function cue(name, detail) {
    if (!Sound || typeof Sound.play !== "function") return;
    try {
      Sound.play(name, detail);
    } catch {
      // 効果音の失敗で計測を止めない
    }
  }

  function soundEnabled() {
    return Boolean(Sound && typeof Sound.isEnabled === "function" && Sound.isEnabled());
  }

  function cacheDom() {
    const byId = (id) => document.getElementById(id);
    state.dom = {
      sourceBadge: byId("source-badge"),
      sourceTitle: byId("source-title"),
      sourceDetail: byId("source-detail"),
      recordButton: byId("record-button"),
      demoToggle: byId("demo-toggle"),
      clearButton: byId("clear-button"),
      printButton: byId("print-button"),
      csvButton: byId("csv-button"),
      soundToggle: byId("sound-toggle"),
      progressStrip: document.querySelector(".progress-strip"),
      progressStatus: byId("progress-status"),
      progLeftBar: byId("prog-left-bar"),
      progRightBar: byId("prog-right-bar"),
      progLeftCount: byId("prog-left-count"),
      progRightCount: byId("prog-right-count"),
      reportFrame: byId("report-frame"),
      reportStatus: byId("report-status"),
      reportDate: byId("report-date"),
      reportSource: byId("report-source"),
      reportSteps: byId("report-steps"),
      statGrid: byId("stat-grid"),
      lrBody: byId("lr-body"),
      distStrike: byId("dist-strike"),
      distPronation: byId("dist-pronation"),
      lastStepTime: byId("last-step-time")
    };
  }

  // ------------------------------------------------------------ source copy

  function applySourceCopy() {
    const copy = state.sourceCopy;
    if (!copy) return;
    state.dom.sourceBadge.className = `source-badge ${copy.badge}`;
    state.dom.sourceBadge.textContent = copy.badge.toUpperCase();
    state.dom.sourceTitle.textContent = t(copy.titleKey, copy.titleParams);
    if (copy.detailRaw) {
      state.dom.sourceDetail.textContent = copy.detailRaw;
    } else if (copy.detailKey) {
      const params = copy.detailSideKey
        ? { ...copy.detailParams, side: t(copy.detailSideKey) }
        : copy.detailParams;
      state.dom.sourceDetail.textContent = t(copy.detailKey, params);
    } else {
      state.dom.sourceDetail.textContent = "";
    }
  }

  function setSourceCopy(badge, titleKey, detailKey, options = {}) {
    state.sourceCopy = {
      badge,
      titleKey,
      detailKey,
      titleParams: options.titleParams || null,
      detailParams: options.detailParams || null,
      detailSideKey: options.detailSideKey || null,
      detailRaw: options.detailRaw || null
    };
    applySourceCopy();
  }

  function connectedDeviceIds() {
    return DEVICE_IDS.filter((deviceId) => state.connected[deviceId]);
  }

  function insoleAt(deviceId) {
    return Array.isArray(root.insoles) && deviceId >= 0 ? root.insoles[deviceId] || null : null;
  }

  // SDK が getFirmwareVersion() で解決した版（insole.firmware_version にキャッシュされる）を読む。
  function deviceFirmwareVersion(deviceId) {
    const insole = insoleAt(deviceId);
    return insole && insole.firmware_version ? String(insole.firmware_version) : null;
  }

  // 接続のたびに FW 版の取得を促す（Toolkit の Step 有効化でも読まれるが、CSV の列に確実に載せるため）。
  function refreshFirmwareVersion(deviceId) {
    const insole = insoleAt(deviceId);
    if (!insole || typeof insole.getFirmwareVersion !== "function") return;
    let pending;
    try {
      pending = insole.getFirmwareVersion();
    } catch {
      return;
    }
    if (pending && typeof pending.catch === "function") pending.catch(() => null);
  }

  function resolveDeviceSide(deviceId) {
    const insole = insoleAt(deviceId);
    const mount = insole && insole.device_information
      ? insole.device_information.mount_position
      : null;
    const side = Stats.sideFromMountPosition(mount, deviceId);
    state.deviceSides[deviceId] = side;
    return side;
  }

  function updateConnectionSource() {
    if (state.demo.running) {
      state.source = "demo";
      setSourceCopy("demo", "demoPlayingTitle", "demoPlayingDetail");
      return;
    }
    const ids = connectedDeviceIds();
    if (ids.length === 0) {
      state.source = "waiting";
      setSourceCopy("waiting", "sourceConnectTitle", "sourceConnectDetail");
      return;
    }
    state.source = "live";
    const sides = ids.map((deviceId) => state.deviceSides[deviceId]);
    if (ids.length === 2 && sides[0] === sides[1]) {
      setSourceCopy("warning", "sourceLiveTitle", "sourceDuplicateSide", {
        titleParams: { count: ids.length }
      });
      return;
    }
    if (ids.length === 2) {
      setSourceCopy("live", "sourceLiveTitle", "sourceLiveBoth", {
        titleParams: { count: 2 }
      });
      return;
    }
    setSourceCopy("live", "sourceLiveTitle", "sourceLiveOne", {
      titleParams: { count: 1 },
      detailSideKey: sides[0] === "right" ? "sideRight" : "sideLeft"
    });
  }

  // Optional, page-local observer channel; no SDK callback replacement or recorder coupling.
  function notifyCG(type, detail = {}) {
    if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
      root.dispatchEvent(new root.CustomEvent("gait-report:cg-" + type, { detail }));
    }
  }

  // -------------------------------------------------------------- recording

  function expectedSides() {
    const set = new Set();
    for (const deviceId of DEVICE_IDS) {
      if (state.connected[deviceId]) set.add(state.deviceSides[deviceId]);
    }
    for (const side of SIDES) {
      if (state.rows[side].length > 0) set.add(side);
    }
    return SIDES.filter((side) => set.has(side));
  }

  // ---- 連続記録版の追加: 画面が消えないようにする（Wake Lock）
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && root.navigator && root.navigator.wakeLock) {
        wakeLock = await root.navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch (e) { wakeLock = null; }
  }
  root.document.addEventListener("visibilitychange", () => {
    if (root.document.visibilityState === "visible" && state.recording) keepAwake(true);
  });
  root.addEventListener("beforeunload", (ev) => {
    if (state.recording || (state.complete && recordedStepCount() > 0 && !state.saved)) {
      ev.preventDefault(); ev.returnValue = "";
    }
  });

  function onRecordButton() {
    if (state.recording) { completeReport(); return; }
    if (recordedStepCount() > 0 && !state.saved
      && !root.confirm(`記録した${recordedStepCount()}歩はまだCSV保存されていません。消して新しく記録しますか？`)) return;
    startRecording();
  }

  function startRecording() {
    state.saved = false;
    keepAwake(true);
    notifyCG("reset");
    state.rows = { left: [], right: [] };
    resetFlow();
    state.recording = true;
    state.complete = false;
    state.startedAt = Date.now();
    state.completedAt = null;
    state.idleReceiving = false;
    state.sessionSource = state.demo.running ? "demo" : "live";
    cue("start");
    renderAll();
  }

  function completeReport() {
    keepAwake(false);
    state.recording = false;
    state.complete = true;
    state.completedAt = Date.now();
    if (state.demo.running) stopDemo({ preserveSource: true });
    // CG は確定したレポートの平均を保持し続ける（以降の歩は反映しない）。recorder の行はコピーで渡す。
    notifyCG("complete", {
      source: state.sessionSource,
      rows: { left: state.rows.left.slice(), right: state.rows.right.slice() }
    });
    cue("complete");
    renderAll();
  }

  function clearData() {
    notifyCG("reset");
    state.rows = { left: [], right: [] };
    resetFlow();
    state.recording = false;
    state.complete = false;
    state.startedAt = null;
    state.completedAt = null;
    state.idleReceiving = false;
    state.sessionSource = null;
    renderAll();
  }

  function recordedStepCount() {
    return state.rows.left.length + state.rows.right.length;
  }

  // 記録した歩をそのまま CSV にする（確定前でも、そこまでの歩を書き出す）。
  function downloadCsv() {
    if (recordedStepCount() === 0) return;
    const csv = Stats.buildRowsCsv(state.rows, {
      source: state.sessionSource,
      firmwareVersions: DEVICE_IDS.map(deviceFirmwareVersion),
      sdkVersion: root.OrpheInsole && root.OrpheInsole.SDK_VERSION ? root.OrpheInsole.SDK_VERSION : null
    });
    const filename = Stats.csvFilename(state.startedAt || Date.now());
    // iPhone（Bluefy など）はリンクでの保存が効かないので、共有メニューで渡す。
    // 共有も使えなければ、CSVの文字を画面に出してコピーできるようにする。
    const nav = root.navigator || {};
    const isIOS = /iPhone|iPad|iPod/.test(nav.userAgent || "")
      || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
    // iPhone は端末ごとに保存の効き方が違うので、まず中身の画面を出し、そこから「コピー」「ファイルで共有」を選ぶ
    if (isIOS) { showCsvText(csv, filename); return; }
    const blob = new root.Blob([csv], { type: "text/csv" });
    const url = root.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    state.saved = true;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    root.setTimeout(() => {
      root.URL.revokeObjectURL(url);
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    }, 1000);
  }

  // 保存できない端末向け：CSVを画面に出して「コピー」「共有」で持ち出す
  function showCsvText(csv, filename) {
    const old = document.getElementById("csv-text-box");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "csv-text-box";
    box.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    box.innerHTML = '<div style="background:#fff;color:#111;border-radius:14px;padding:16px;width:100%;max-width:560px">'
      + '<p style="margin:0 0 8px;font-weight:700">CSVの中身（' + filename + '）</p>'
      + '<p style="margin:0 0 8px;font-size:14px">「コピー」を押して、メモやメールに貼り付けて送ってください。</p>'
      + '<textarea readonly style="width:100%;height:40vh;font-size:11px;font-family:monospace"></textarea>'
      + '<div style="display:flex;gap:8px;margin-top:10px">'
      + '<button type="button" data-act="copy" class="button secondary" style="flex:1">コピー</button>'
      + '<button type="button" data-act="share" class="button ghost" style="flex:1">ファイルで共有</button>'
      + '<button type="button" data-act="close" class="button ghost" style="flex:1">閉じる</button></div></div>';
    const ta = box.querySelector("textarea");
    ta.value = csv;
    const nav = root.navigator || {};
    const shareBtn = box.querySelector('[data-act="share"]');
    if (!nav.share) shareBtn.style.display = "none";
    box.addEventListener("click", async (ev) => {
      const act = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-act");
      if (act === "close" || ev.target === box) { box.remove(); return; }
      if (act === "copy") {
        let ok = false;
        try { await nav.clipboard.writeText(csv); ok = true; } catch (e) {
          ta.focus(); ta.select(); ta.setSelectionRange(0, csv.length);
          try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
        }
        ev.target.textContent = ok ? "コピーしました" : "長押しで全選択→コピー";
        if (ok) state.saved = true;
      }
        if (act === "share") {
        let file = null;
        try { file = new root.File([csv], filename, { type: "text/csv" }); } catch (e) { file = null; }
        // ファイルで渡せなければ、文字のまま共有メニューへ（メモ・メール・ファイルに保存を選べる）
        const tries = [];
        if (file && nav.canShare && nav.canShare({ files: [file] })) tries.push({ files: [file], title: filename });
        tries.push({ title: filename, text: csv });
        let done = false;
        for (const data of tries) {
          try { await nav.share(data); done = true; break; } catch (e) { if (e && e.name === "AbortError") { done = true; break; } }
        }
        if (done) state.saved = true;
        else ev.target.textContent = "共有できません→コピーへ";
      }
    });
    document.body.appendChild(box);
  }

  function pulseReport(side) {
    const frame = state.dom.reportFrame;
    const cls = side === "right" ? "is-stepping-right" : "is-stepping-left";
    frame.classList.remove("is-stepping-left", "is-stepping-right");
    void frame.offsetWidth;
    frame.classList.add(cls);
  }

  function handleStepRow(deviceId, incomingRow, options = {}) {
    const side = options.side || resolveDeviceSide(deviceId);
    if (options.source !== "demo") noteLiveData(deviceId);

    // Notify even before Record and after the 20-cycle report is complete.
    notifyCG("step", { side, source: options.source === "demo" ? "demo" : "live", row: { ...incomingRow } });
    state.lastStepAt = Date.now();
    state.dom.lastStepTime.textContent =
      new Date(state.lastStepAt).toLocaleTimeString(locale(), { hour12: false });

    if (!state.recording) {
      if (!state.complete && !state.idleReceiving) {
        state.idleReceiving = true;
        renderProgress();
      }
      return;
    }
    if (state.rows[side].length >= TARGET) return;

    state.rows[side].push({
      ...incomingRow,
      _side: side,
      _device_id: deviceId,
      _fw_version: deviceFirmwareVersion(deviceId),
      _received_at: state.lastStepAt
    });
    pulseReport(side);
    cue("step", { side });

    const expected = expectedSides();
    const done = expected.length > 0
      && expected.every((expectedSide) => state.rows[expectedSide].length >= TARGET);
    if (done) {
      completeReport();
      return;
    }
    renderAll();
  }

  // ------------------------------------------------------------------- demo

  function demoRow(side, stepNumber) {
    const sidePhase = side === "left" ? 0 : 0.73;
    const wave = Math.sin(stepNumber * 0.72 + sidePhase);
    const cycle = (side === "left" ? 1.06 : 1.08) + wave * 0.028;
    const stanceRatio = (side === "left" ? 0.605 : 0.615)
      + Math.sin(stepNumber * 0.38 + sidePhase) * 0.012;
    const stride = (side === "left" ? 1.28 : 1.24)
      + Math.cos(stepNumber * 0.55 + sidePhase) * 0.05;
    const pronation = (side === "left" ? -8.6 : -10.2) + wave * 1.8;
    const strike = (side === "left" ? -5.2 : -4.5) + Math.cos(stepNumber * 0.44) * 2.4;
    const footStrike = strike > 2 ? "forefoot" : strike > -3 ? "midfoot" : "heelStrike";
    const pronationType = pronation > -5.9 ? "over" : pronation < -12.9 ? "under" : "neutral";
    return {
      step_number: stepNumber,
      gait_type: "walk",
      stride_direction: "forward",
      distance_m: stepNumber * stride,
      stance_phase_s: cycle * stanceRatio,
      swing_phase_s: cycle * (1 - stanceRatio),
      duration_s: cycle,
      cadence_hz: 1 / cycle,
      speed_mps: stride / cycle,
      foot_angle_deg: 8.5 + wave * 2.2,
      stride_x_m: stride * 0.98,
      stride_y_m: (side === "left" ? -1 : 1) * 0.05,
      stride_z_m: 0.035,
      stride_norm_m: stride,
      landing_force: (side === "left" ? 1.18 : 1.24) + Math.abs(wave) * 0.16,
      strike_angle_deg: strike,
      foot_strike: footStrike,
      pronation_deg: pronation,
      pronation_type: pronationType,
      pronation_z_deg: (side === "left" ? -2 : 2) + wave,
      calorie: stepNumber * 0.0015
    };
  }

  function demoTick() {
    const now = nowMs();
    if (now < state.demo.nextStepAt) return;
    const side = state.demo.nextSide;
    state.demo.counts[side] += 1;
    handleStepRow(-1, demoRow(side, state.demo.counts[side]), {
      side,
      source: "demo"
    });
    state.demo.nextSide = side === "left" ? "right" : "left";
    state.demo.nextStepAt = now + DEMO_STEP_INTERVAL_MS;
  }

  function startDemo() {
    if (connectedDeviceIds().length > 0) {
      setSourceCopy("live", "demoBlockedTitle", "demoBlockedDetail");
      return;
    }
    state.demo.running = true;
    state.demo.nextStepAt = nowMs() + 350;
    state.demo.nextSide = "left";
    state.demo.counts = { left: 0, right: 0 };
    state.demo.timer = root.setInterval(demoTick, 60);
    updateConnectionSource();
    startRecording();
  }

  function stopDemo(options = {}) {
    if (state.demo.timer) {
      root.clearInterval(state.demo.timer);
      state.demo.timer = null;
    }
    state.demo.running = false;
    if (!options.preserveSource) updateConnectionSource();
    renderButtons();
  }

  function toggleDemo() {
    if (state.demo.running) {
      stopDemo();
      renderAll();
    } else {
      startDemo();
    }
  }

  // -------------------------------------------------------------- live glue

  function activateLiveConnection(deviceId, options = {}) {
    const demoWasRunning = state.demo.running;
    if (demoWasRunning) {
      stopDemo({ preserveSource: true });
      clearData();
    }
    state.connected[deviceId] = true;
    resolveDeviceSide(deviceId);
    refreshFirmwareVersion(deviceId);
    if (
      options.forceSource
      || demoWasRunning
      || (state.source !== "live")
    ) {
      updateConnectionSource();
    }
  }

  function noteLiveData(deviceId) {
    if (deviceId >= 0 && !state.connected[deviceId]) {
      activateLiveConnection(deviceId);
    }
  }

  function installDevice(deviceId) {
    if (typeof root.buildInsoleToolkit !== "function" || !Array.isArray(root.insoles)) {
      setSourceCopy("error", "toolkitLoadErrorTitle", "toolkitLoadErrorDetail");
      return;
    }

    root.buildInsoleToolkit(
      document.getElementById(`toolkit${deviceId}`),
      `INSOLE 0${deviceId + 1}`,
      deviceId,
      {
        profile: "realtime-full-step",
        autoReconnect: true,
        reconnectIntervalMs: 2000,
        gait: {
          verifyNotifications: VERIFY_GAIT,
          onGait(id, row) {
            handleStepRow(id, row);
          },
          onError(error) {
            const message = error && error.message ? error.message : String(error);
            setSourceCopy("error", "stepErrorTitle", "", {
              titleParams: { device: deviceId + 1 },
              detailRaw: message
            });
          }
        },
        onStateChange(snapshot) {
          if (snapshot.connected) {
            activateLiveConnection(deviceId, { forceSource: true });
          } else {
            notifyCG("disconnect", { side: state.deviceSides[deviceId] });
            state.connected[deviceId] = false;
            resolveDeviceSide(deviceId);
            updateConnectionSource();
          }
        },
        onError(error) {
          if (error && error.name === "NotFoundError") {
            updateConnectionSource();
            return;
          }
          const message = error && error.message ? error.message : String(error);
          setSourceCopy("error", "toolkitErrorTitle", "", {
            titleParams: { device: deviceId + 1 },
            detailRaw: message
          });
        }
      }
    );

    state.sessions[deviceId] = root.getInsoleToolkitSession(deviceId);
    const insole = root.insoles[deviceId];
    insole.setup();

    insole.onConnect = function onConnect() {
      activateLiveConnection(this.id, { forceSource: true });
    };
    insole.onDisconnect = function onDisconnect() {
      notifyCG("disconnect", { side: state.deviceSides[this.id] });
      if (!state.demo.running) {
        setSourceCopy("waiting", "reconnectTitle", "reconnectWait", {
          titleParams: { device: this.id + 1 }
        });
      }
    };
    insole.onReconnectAttempt = function onReconnectAttempt(info) {
      if (!state.demo.running) {
        setSourceCopy("waiting", "reconnectTitle", "reconnectAttempt", {
          titleParams: { device: this.id + 1 },
          detailParams: { attempt: info.attempt, maxAttempts: info.maxAttempts }
        });
      }
    };
    insole.onReconnectSuccess = function onReconnectSuccess() {
      activateLiveConnection(this.id, { forceSource: true });
    };
    insole.onReconnectFailed = function onReconnectFailed(info) {
      state.connected[this.id] = false;
      const message = info && info.error && info.error.message ? info.error.message : null;
      setSourceCopy("error", "reconnectFailedTitle", "reconnectFailedFallback", {
        titleParams: { device: this.id + 1 },
        ...(message ? { detailRaw: message } : {})
      });
    };
    insole.onError = function onError(error) {
      if (error && error.name === "NotFoundError") return;
      const message = error && error.message ? error.message : String(error);
      setSourceCopy("error", "toolkitErrorTitle", "", {
        titleParams: { device: this.id + 1 },
        detailRaw: message
      });
    };
  }

  // -------------------------------------------------------------- rendering

  const TILE_FIELDS = ["speed_mps", "cadence_spm", "stride_m", "cycle_s", "stance_pct"];

  function refLine(fieldId) {
    const range = Stats.REFERENCE_RANGES[fieldId];
    if (!range) return "";
    const field = Stats.fieldById(fieldId);
    return t("refRangeLabel", {
      min: range.min,
      max: range.max,
      unit: field ? field.unit : ""
    });
  }

  function renderButtons() {
    const record = state.dom.recordButton;
    if (state.complete) {
      record.innerHTML = t("recordAgainHtml");
    } else if (state.recording) {
      record.innerHTML = t("recordStopHtml");
    } else {
      record.innerHTML = t("recordStartHtml");
    }
    record.classList.toggle("recording", state.recording);

    const demoButton = state.dom.demoToggle;
    demoButton.innerHTML = state.demo.running ? t("demoStopHtml") : t("demoPlayHtml");
    demoButton.classList.toggle("active", state.demo.running);

    state.dom.csvButton.disabled = recordedStepCount() === 0;

    const soundButton = state.dom.soundToggle;
    if (soundButton) {
      if (!Sound) {
        soundButton.hidden = true;
      } else {
        const on = soundEnabled();
        soundButton.innerHTML = t(on ? "soundOnHtml" : "soundOffHtml");
        soundButton.classList.toggle("active", on);
        if (typeof soundButton.setAttribute === "function") soundButton.setAttribute("aria-pressed", String(on));
      }
    }
  }

  function toggleSound() {
    if (!Sound) return;
    Sound.setEnabled(!soundEnabled());
    if (soundEnabled()) cue("start");   // ON にした瞬間に鳴らして音量を確認できるようにする
    renderButtons();
  }

  function renderProgress() {
    const dom = state.dom;
    let statusKey = "progressIdle";
    if (state.complete) statusKey = "progressComplete";
    else if (state.recording) statusKey = "progressRecording";
    else if (state.idleReceiving) statusKey = "progressIdleReceiving";
    dom.progressStatus.textContent = t(statusKey, { target: TARGET, count: recordedStepCount(),
      minutes: state.startedAt ? Math.round(((state.completedAt || Date.now()) - state.startedAt) / 60000) : 0 });
    dom.progressStrip.classList.toggle("is-complete", state.complete);

    const bars = { left: dom.progLeftBar, right: dom.progRightBar };
    const counts = { left: dom.progLeftCount, right: dom.progRightCount };
    for (const side of SIDES) {
      const count = state.rows[side].length;
      bars[side].style.width = count > 0 ? "100%" : "0%";
      counts[side].textContent = t("progressSide", { count, target: TARGET });
    }
  }

  function summaryText(summary, decimals) {
    if (!summary || summary.count === 0 || summary.mean === null) return null;
    return {
      mean: fmt(summary.mean, decimals),
      sd: summary.sd === null ? "—" : fmt(summary.sd, decimals),
      count: summary.count
    };
  }

  function renderStatGrid(report) {
    const parts = [];
    for (const fieldId of TILE_FIELDS) {
      const field = Stats.fieldById(fieldId);
      const text = summaryText(report.combined.fields[fieldId], field.decimals);
      const value = text
        ? `${text.mean} <small>${field.unit}</small>`
        : `${t("noData")}`;
      const sub = text
        ? `${t("meanSdPattern", { sd: text.sd })} ・ ${t("nOfSteps", { count: text.count })}`
        : "";
      parts.push(`<div class="stat-tile">
        <span class="stat-label">${t(`metric_${fieldId}_label`)}</span>
        <span class="stat-value">${value}</span>
        <span class="stat-sub">${sub}</span>
        <span class="stat-ref">${refLine(fieldId)}</span>
      </div>`);
    }

    const cvLeft = report.sides.left.cv;
    const cvRight = report.sides.right.cv;
    const cvValue = (cvLeft === null && cvRight === null)
      ? t("noData")
      : `${t("cvTileValue", {
        left: cvLeft === null ? "—" : `${fmt(cvLeft, 1)}%`,
        right: cvRight === null ? "—" : `${fmt(cvRight, 1)}%`
      })}`;
    parts.push(`<div class="stat-tile">
      <span class="stat-label">${t("cvTileLabel")}</span>
      <span class="stat-value" style="font-size:0.95rem">${cvValue}</span>
      <span class="stat-sub"></span>
      <span class="stat-ref">${t("refCvLabel", { max: Stats.REFERENCE_RANGES.cv_pct.max })}</span>
    </div>`);

    state.dom.statGrid.innerHTML = parts.join("");
  }

  function symmetryCell(value) {
    if (value === null) {
      return `<span class="sym-value">${t("noData")}</span>`;
    }
    const abs = Math.abs(value);
    const label = abs < 0.05
      ? t("symEven")
      : t(value > 0 ? "symLeftLarger" : "symRightLarger", { value: fmt(abs, 1) });
    const width = Math.min(abs, 20) / 20 * 50;
    const fill = value > 0
      ? `<div class="sym-bar-fill toward-left" style="width:${width}%"></div>`
      : `<div class="sym-bar-fill toward-right" style="width:${width}%"></div>`;
    return `<span class="sym-value">${label}</span><div class="sym-bar">${fill}</div>`;
  }

  const LR_TABLE_FIELDS = ["stride_m", "stance_s", "swing_s", "pronation_deg", "landing_force"];

  function deltaCell(value, unit) {
    if (value === null) {
      return `<span class="sym-value">${t("noData")}</span>`;
    }
    return `<span class="sym-value">${t("symDelta", { value: fmt(Math.abs(value), 1), unit })}</span>`;
  }

  function renderLrTable(report) {
    const rows = [];
    for (const fieldId of LR_TABLE_FIELDS) {
      const field = Stats.fieldById(fieldId);
      const left = summaryText(report.sides.left.fields[fieldId], field.decimals);
      const right = summaryText(report.sides.right.fields[fieldId], field.decimals);
      const cell = (text) => (text
        ? `${text.mean} <span class="lr-sd">± ${text.sd}</span>`
        : t("noData"));
      const sym = Stats.DELTA_FIELDS.includes(fieldId)
        ? deltaCell(report.deltas[fieldId], field.unit)
        : symmetryCell(report.symmetry[fieldId]);
      rows.push(`<tr>
        <th scope="row">${t(`metric_${fieldId}_label`)}${field.unit ? ` <span class="lr-unit">(${field.unit})</span>` : ""}</th>
        <td class="lr-left">${cell(left)}</td>
        <td class="lr-right">${cell(right)}</td>
        <td class="sym-cell">${sym}</td>
      </tr>`);
    }
    state.dom.lrBody.innerHTML = rows.join("");
  }

  function distBlock(titleKey, distBySide, keys) {
    const rows = SIDES.map((side) => {
      const dist = distBySide[side];
      const chips = keys.map((key) => {
        const count = dist.counts[key] || 0;
        return `<span class="dist-chip${count > 0 ? " has-count" : ""}">${t(`text${key.charAt(0).toUpperCase()}${key.slice(1)}`)} <b>${count}</b></span>`;
      }).join("");
      return `<div class="dist-row ${side}">
        <span class="dist-side">${side === "left" ? "LEFT" : "RIGHT"}</span>
        <span class="dist-chips">${chips}</span>
      </div>`;
    }).join("");
    return `<h4>${t(titleKey)}</h4>${rows}`;
  }

  function renderDistributions(report) {
    state.dom.distStrike.innerHTML = distBlock("distStrike", {
      left: report.sides.left.strike,
      right: report.sides.right.strike
    }, Stats.STRIKE_KEYS);
    state.dom.distPronation.innerHTML = distBlock("distPronation", {
      left: report.sides.left.pronation,
      right: report.sides.right.pronation
    }, Stats.PRONATION_KEYS);
  }

  function renderReportHead(report) {
    const dom = state.dom;
    let statusKey = "statusIdle";
    let statusClass = "idle";
    if (state.complete) {
      statusKey = "statusComplete";
      statusClass = "complete";
    } else if (state.recording) {
      statusKey = "statusRecording";
      statusClass = "recording";
    }
    dom.reportStatus.textContent = t(statusKey);
    dom.reportStatus.className = `report-status ${statusClass}`;

    if (state.startedAt) {
      const start = new Date(state.startedAt).toLocaleString(locale(), { hour12: false });
      dom.reportDate.textContent = state.completedAt
        ? `${start} – ${new Date(state.completedAt).toLocaleTimeString(locale(), { hour12: false })}`
        : start;
    } else {
      dom.reportDate.textContent = t("noData");
    }

    if (state.sessionSource === "demo") {
      dom.reportSource.textContent = t("sourceValueDemo");
    } else if (state.sessionSource === "live") {
      dom.reportSource.textContent = t("sourceValueLive");
    } else {
      dom.reportSource.textContent = t("sourceValueNone");
    }

    dom.reportSteps.textContent = report.combined.count > 0
      ? t("reportStepsValue", {
        left: report.sides.left.count,
        right: report.sides.right.count
      })
      : t("noData");
  }

  // ---- 足裏の流れ（かかと→小指→親指）。圧力6点の生データを1歩ずつ数える（flow.js）
  const Flow = root.FootFlow || null;
  const flowAnalyzers = [null, null];
  let soleView = null;   // 足裏のいま（sole.js）。init で作る
  function emptyFlow() { const c = {}; if (Flow) for (const k of Flow.ORDER) c[k] = 0; return c; }
  function resetFlow() {
    state.flow = { left: emptyFlow(), right: emptyFlow() };
    if (Flow) for (const id of DEVICE_IDS) flowAnalyzers[id] = Flow.createAnalyzer();
  }
  resetFlow();
  let flowRenderTimer = null;
  function attachFlow(deviceId) {
    const ins = root.insoles && root.insoles[deviceId];
    if (!Flow || !ins || ins._walklogFlow || typeof ins.addSensorDataListener !== "function") return;
    ins._walklogFlow = true;
    ins.addSensorDataListener((ev) => {
      const samples = ev && ev.packet && ev.packet.samples;
      if (!Array.isArray(samples)) return;
      const an = flowAnalyzers[deviceId];
      let lastPress = null;
      for (const s of samples) {
        if (!s || !s.press || !s.press.values) continue;
        lastPress = s.press.values;
        const t = Number.isFinite(s.timestamp) ? s.timestamp : ev.receivedAt;
        const kind = an.push(s.press.values, t);
        if (kind && state.recording && state.sessionSource !== "demo") {
          const side = state.deviceSides[deviceId];
          if (state.flow[side] && kind in state.flow[side]) state.flow[side][kind]++;
          if (!flowRenderTimer) flowRenderTimer = root.setTimeout(() => { flowRenderTimer = null; renderFlow(); }, 500);
        }
      }
      if (lastPress && soleView) soleView.update(state.deviceSides[deviceId], lastPress);
    });
  }
  function renderFlow() {
    const box = root.document.getElementById("flow-panel");
    if (!box || !Flow) return;
    const sideName = { left: "左足", right: "右足" };
    const cols = SIDES.map((side) => {
      const c = state.flow[side];
      const n = Flow.ORDER.reduce((a, k) => a + c[k], 0);
      if (n === 0) return `<div class="chain-col"><h3>${sideName[side]}</h3><p class="chain-mix">まだ数えた歩がありません。</p></div>`;
      const pct = (k) => Math.round(c[k] / n * 100);
      const rows = Flow.ORDER.filter((k) => c[k] > 0).map((k) =>
        `<li><span class="chain-tag ${k === "ideal" ? "measured" : "none"}">${pct(k)}%</span>${Flow.LABELS[k]}（${c[k]}歩）</li>`);
      return `<div class="chain-col"><h3>${sideName[side]}（${n}歩）</h3><p class="chain-mix">かかと→小指→親指の順だった歩：<b>${pct("ideal")}%</b></p><ol>${rows.join("")}</ol></div>`;
    });
    box.innerHTML = '<h2>足裏の流れ（かかと→小指→親指）</h2>'
      + '<p class="chain-lead">整った歩きは、かかと→小指→親指の順に着きます。足裏の圧力センサーで、1歩ごとにどこへ先に乗ったかを数えています（インソールで測った値）。</p>'
      + `<div class="chain-cols">${cols.join("")}</div>`
      + '<p class="chain-note">小指側＝中足部の外側、親指側＝つま先の内側と母趾球の内側のセンサー。立ち止まっている間は数えません。デモでは数えません。</p>';
  }

  // ---- 代償運動とのつながり（連続記録版の追加）
  // 測っているのは①（着地の足の倒れ方）だけ。②〜⑦は社内の連動の考え方
  // （距骨→アーチ→すね→膝→骨盤→腰→肋骨。3D解剖ビューアと同じ並び）による理屈での見立て。
  const CHAIN = ["距骨が内へ倒れる", "内側アーチが落ちる", "すねが内へねじれる",
    "膝が内に入る", "骨盤が前に倒れる", "腰が反る", "肋骨が開く"];
  const CHAIN_MIN_STEPS = 20;
  function pronationMix(rows) {
    const c = { inward: 0, middle: 0, outward: 0 };
    for (const r of rows) {
      const t = r.pronation_type;
      if (t === "over" || t === "severeOver") c.inward++;
      else if (t === "neutral") c.middle++;
      else if (t === "under" || t === "severeUnder") c.outward++;
    }
    const n = c.inward + c.middle + c.outward;
    const pct = (k) => (n ? Math.round(c[k] / n * 100) : 0);
    let lean = "middle";
    if (n && c.inward >= c.middle && c.inward >= c.outward) lean = "inward";
    else if (n && c.outward > c.middle && c.outward > c.inward) lean = "outward";
    return { n, lean, inward: pct("inward"), middle: pct("middle"), outward: pct("outward") };
  }
  function renderChain() {
    const box = root.document.getElementById("chain-panel");
    if (!box) return;
    const sideName = { left: "左足", right: "右足" };
    const cols = SIDES.map((side) => {
      const m = pronationMix(state.rows[side]);
      let head, items;
      if (m.n < CHAIN_MIN_STEPS) {
        head = `<p class="chain-mix">記録が${m.n}歩のため、まだ見立てません（${CHAIN_MIN_STEPS}歩から）。</p>`;
        items = CHAIN.map((t, i) => `<li><span class="chain-tag none">—</span>${i + 1}. ${t}</li>`);
      } else {
        head = `<p class="chain-mix">着地の足の倒れ方（${m.n}歩）：内へ ${m.inward}%／真ん中 ${m.middle}%／外へ ${m.outward}%</p>`;
        items = CHAIN.map((t, i) => {
          if (i === 0) {
            const word = m.lean === "inward" ? "内へ倒れる歩きが多い" : m.lean === "outward" ? "外へ倒れる歩きが多い" : "真ん中が多い";
            return `<li><span class="chain-tag measured">インソールで測った</span>1. ${t} → ${word}</li>`;
          }
          if (m.lean === "inward") return `<li><span class="chain-tag inferred">理屈での見立て</span>${i + 1}. ${t}（起きやすい）</li>`;
          if (m.lean === "middle") return `<li><span class="chain-tag none">見立てなし</span>${i + 1}. ${t}</li>`;
          return `<li><span class="chain-tag none">当てはまらない</span>${i + 1}. ${t}</li>`;
        });
        if (m.lean === "middle") head += '<p class="chain-mix">足元が真ん中なので、足元から始まる崩れの流れは見えにくい歩きです。</p>';
        if (m.lean === "outward") head += '<p class="chain-mix">内へ倒れる流れとは逆の、外側に乗る歩きです。この7段階の見立ては当てはまりません。</p>';
      }
      return `<div class="chain-col"><h3>${sideName[side]}</h3>${head}<ol>${items.join("")}</ol></div>`;
    });
    box.innerHTML = '<h2>代償運動とのつながり</h2>'
      + '<p class="chain-lead">インソールで測れるのは①の足元だけです。②〜⑦は、足元から膝・骨盤・腰・肋骨へ順に伝わる連動の考え方で見立てたものです（測った値ではありません）。</p>'
      + `<div class="chain-cols">${cols.join("")}</div>`
      + '<p class="chain-note">足の倒れ方の「内へ／真ん中／外へ」は ORPHE の基準（平均 −9.4°±3.5°）で分けています。良し悪しの判定ではありません。</p>';
  }

  function renderReport() {
    renderChain();
    renderFlow();
    const report = Stats.buildReport(state.rows, TARGET);
    renderReportHead(report);
    renderStatGrid(report);
    renderLrTable(report);
    renderDistributions(report);
  }

  function renderAll() {
    renderButtons();
    renderProgress();
    renderReport();
  }

  // ------------------------------------------------------------------- init

  function refreshLanguage() {
    applySourceCopy();
    renderAll();
    if (state.lastStepAt) {
      state.dom.lastStepTime.textContent =
        new Date(state.lastStepAt).toLocaleTimeString(locale(), { hour12: false });
    }
  }

  function init() {
    cacheDom();
    state.dom.recordButton.addEventListener("click", onRecordButton);
    state.dom.demoToggle.addEventListener("click", toggleDemo);
    state.dom.clearButton.addEventListener("click", clearData);
    state.dom.printButton.addEventListener("click", () => root.print());
    state.dom.csvButton.addEventListener("click", downloadCsv);
    if (state.dom.soundToggle) state.dom.soundToggle.addEventListener("click", toggleSound);

    // i18n.js の初期 setLanguage は DOMContentLoaded の先頭で発火するため、
    // languagechange の購読は cacheDom() 後（=描画できる状態）に登録する。
    root.addEventListener("gait-report:languagechange", refreshLanguage);

    for (const deviceId of DEVICE_IDS) installDevice(deviceId);
    if (root.SoleView) soleView = root.SoleView.create(root.document.getElementById("sole-panel"));
    root.setInterval(() => { for (const id of DEVICE_IDS) attachFlow(id); }, 1000);
    updateConnectionSource();
    renderAll();

    if (PAGE_PARAMS.get("demo") === "1" && connectedDeviceIds().length === 0) {
      startDemo();
    }
  }

  if (root.document) {
    root.document.addEventListener("DOMContentLoaded", init);
  }

  root.GaitReportLive = {
    state,
    handleStepRow,
    startRecording,
    clearData,
    downloadCsv,
    toggleSound,
    startDemo,
    stopDemo,
    demoRow,
    renderAll
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
