// 足裏の流れ（かかと→小指→親指）を、圧力6点の生データから1歩ずつ数える。
// 公式のセンサー番号（ORPHE-INSOLE.js の説明）: values[0] つま先内側, [1] 母趾球内側,
// [2] つま先外側, [3] 中足部中央, [4] 中足部外側, [5] 踵。
// 「小指側」＝[4] 中足部外側、「親指側」＝[0][1] の大きいほう、「かかと」＝[5]。
// 1歩＝圧力の合計が上がってから下がるまで（足が床に着いている間）。各部位に
// 「その歩での最大の25%」を超えた最初の時刻を、その部位に乗った時刻とする。
(function attachFootFlow(root) {
  "use strict";

  const HEEL = [5], LITTLE = [4], BIG = [0, 1];
  const ON_RATIO = 0.15, OFF_RATIO = 0.07;   // 合計がふだんの最大の何割で「着いた／離れた」
  const REGION_RATIO = 0.25;                 // 部位の最大の何割で「乗った」
  const REGION_FLOOR = 0.10;                 // 部位の最大が、その部位のふだんの最大の何割未満なら「乗っていない」
  const MIN_STANCE_MS = 200, MAX_STANCE_MS = 2500;
  const PEAK_DECAY = 0.999;                  // ふだんの最大はゆっくり下げる（はき直し等で上がりっぱなしにしない）

  function regionValue(values, idx) {
    let m = 0;
    for (const i of idx) m = Math.max(m, Number(values[i]) || 0);
    return m;
  }

  function createAnalyzer() {
    const st = {
      totalPeak: 0, regionPeak: { heel: 0, little: 0, big: 0 },
      inContact: false, frames: [], stanceStart: 0
    };

    function classify(frames) {
      const peak = { heel: 0, little: 0, big: 0 };
      for (const f of frames) for (const k in peak) peak[k] = Math.max(peak[k], f[k]);
      const onset = {};
      for (const k in peak) {
        if (peak[k] < st.regionPeak[k] * REGION_FLOOR || peak[k] <= 0) { onset[k] = null; continue; }
        const th = peak[k] * REGION_RATIO;
        const hit = frames.find((f) => f[k] >= th);
        onset[k] = hit ? hit.t : null;
      }
      if (onset.heel === null) return "noHeel";
      if (onset.little === null) return "noLittle";
      if (onset.big === null) return "noBig";
      if (onset.heel > onset.little || onset.heel > onset.big) return "notHeelFirst";
      if (onset.little <= onset.big) return "ideal";
      return "bigBeforeLittle";
    }

    // values: 圧力6点、t: ミリ秒。1歩が終わったら分類名を返す（それ以外は null）
    function push(values, t) {
      if (!values || values.length < 6) return null;
      const f = {
        t,
        heel: regionValue(values, HEEL),
        little: regionValue(values, LITTLE),
        big: regionValue(values, BIG)
      };
      let total = 0;
      for (let i = 0; i < 6; i++) total += Number(values[i]) || 0;
      st.totalPeak = Math.max(st.totalPeak * PEAK_DECAY, total);
      for (const k in st.regionPeak) st.regionPeak[k] = Math.max(st.regionPeak[k] * PEAK_DECAY, f[k]);
      if (st.totalPeak <= 0) return null;

      if (!st.inContact) {
        if (total > st.totalPeak * ON_RATIO) {
          st.inContact = true; st.stanceStart = t; st.frames = [f];
        }
        return null;
      }
      st.frames.push(f);
      if (total >= st.totalPeak * OFF_RATIO) {
        if (t - st.stanceStart > MAX_STANCE_MS) st.frames = st.frames.slice(-300); // 立ちっぱなしは数えない
        return null;
      }
      st.inContact = false;
      const dur = t - st.stanceStart;
      const frames = st.frames; st.frames = [];
      if (dur < MIN_STANCE_MS || dur > MAX_STANCE_MS) return null;
      return classify(frames);
    }
    return { push };
  }

  const LABELS = {
    ideal: "かかと→小指→親指",
    bigBeforeLittle: "かかと→親指（小指より先に親指）",
    notHeelFirst: "かかとから着いていない",
    noLittle: "小指側に乗っていない",
    noBig: "親指側に乗っていない",
    noHeel: "かかとに乗っていない"
  };
  const ORDER = ["ideal", "bigBeforeLittle", "notHeelFirst", "noLittle", "noBig", "noHeel"];

  const api = { createAnalyzer, LABELS, ORDER };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FootFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
