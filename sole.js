// 足裏のいま：左右の足を横に並べ、圧力6点を足裏の絵の上で光らせる（上から見た形・親指が内側）。
// センサーの位置は ORPHE の showcase の足型と同じ並び（施主が実物で光る場所を確認済み 2026-10-09）。
// 右足基準（上から見て親指側＝左）。左足は左右を反転する。
(function attachSoleView(root) {
  "use strict";

  const SENSORS_RIGHT = [
    { x: 0.30, y: 0.12, name: "親指" },        // 0 つま先内側
    { x: 0.27, y: 0.33, name: "母趾球" },      // 1 母趾球内側
    { x: 0.64, y: 0.17, name: "指の外側" },    // 2 つま先外側
    { x: 0.50, y: 0.36, name: "中央" },        // 3 中足部中央
    { x: 0.74, y: 0.40, name: "小指側" },      // 4 中足部外側
    { x: 0.47, y: 0.83, name: "かかと" }       // 5 踵
  ];
  // 右足の輪郭（幅100×高さ260。上から見て、内側＝左に土踏まずのくびれ）
  const OUTLINE_RIGHT = "M38,6 C18,8 8,30 9,62 C10,92 20,112 26,132 C31,150 24,170 22,196 " +
    "C20,232 34,256 52,256 C72,256 82,236 80,206 C78,180 86,150 90,120 C94,84 96,46 84,24 C74,8 56,4 38,6 Z";
  const W = 100, H = 260, R = 17;
  const DECAY = 0.998;

  function create(container) {
    if (!container) return null;
    const peaks = { left: [0, 0, 0, 0, 0, 0], right: [0, 0, 0, 0, 0, 0] };
    const latest = { left: null, right: null };
    let raf = null;

    const foot = (side) => {
      const mirror = side === "left";
      const tr = mirror ? ` transform="translate(${W},0) scale(-1,1)"` : "";
      const dots = SENSORS_RIGHT.map((s, i) =>
        `<circle class="sole-dot" data-i="${i}" cx="${s.x * W}" cy="${s.y * H}" r="${R}" />`).join("");
      return `<div class="sole-foot"><svg viewBox="-4 -4 ${W + 8} ${H + 8}" role="img" aria-label="${mirror ? "左足" : "右足"}の足裏">`
        + `<g${tr}><path class="sole-outline" d="${OUTLINE_RIGHT}" />${dots}`
        + `<circle class="sole-cop" cx="-50" cy="-50" r="6" /></g></svg>`
        + `<div class="sole-label">${mirror ? "左足" : "右足"}</div></div>`;
    };
    container.innerHTML = '<h2>足裏のいま</h2>'
      + '<p class="chain-lead">つないでいる間、足裏のどこに乗っているかを光で出します（上から見た形・親指が内側）。白い点は乗っている中心です。</p>'
      + `<div class="sole-pair">${foot("left")}${foot("right")}</div>`;
    const svgs = { left: container.querySelectorAll(".sole-foot")[0], right: container.querySelectorAll(".sole-foot")[1] };

    function draw() {
      raf = null;
      for (const side of ["left", "right"]) {
        const v = latest[side];
        if (!v) continue;
        const el = svgs[side];
        let tot = 0, cx = 0, cy = 0;
        const top = Math.max(...peaks[side]);   // 左右それぞれ、いちばん強かったセンサーを基準に光らせる
        el.querySelectorAll(".sole-dot").forEach((dot) => {
          const i = Number(dot.getAttribute("data-i"));
          const level = top > 0 ? Math.min(1, v[i] / top) : 0;
          dot.style.fillOpacity = (0.08 + level * 0.92).toFixed(2);
          dot.setAttribute("r", (R * (0.75 + level * 0.45)).toFixed(1));
          tot += v[i]; cx += SENSORS_RIGHT[i].x * W * v[i]; cy += SENSORS_RIGHT[i].y * H * v[i];
        });
        const cop = el.querySelector(".sole-cop");
        if (tot > 0) { cop.setAttribute("cx", (cx / tot).toFixed(1)); cop.setAttribute("cy", (cy / tot).toFixed(1)); }
        else { cop.setAttribute("cx", "-50"); cop.setAttribute("cy", "-50"); }
      }
    }

    function update(side, values) {
      if (side !== "left" && side !== "right") return;
      const v = [];
      for (let i = 0; i < 6; i++) {
        const x = Math.max(0, Number(values[i]) || 0);
        v.push(x);
        peaks[side][i] = Math.max(peaks[side][i] * DECAY, x);
      }
      latest[side] = v;
      if (!raf) raf = (root.requestAnimationFrame || ((f) => root.setTimeout(f, 30)))(draw);
    }
    return { update };
  }

  root.SoleView = { create };
})(typeof globalThis !== "undefined" ? globalThis : window);
