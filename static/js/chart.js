/*
 * publish/static/js/chart.js
 *
 * Progressive enhancement for the FT-register hero chart on the landing
 * page. The SVG is rendered server-side by publish/charts.py and is
 * fully functional without this script. This script layers on:
 *
 *   - hover crosshair + cursor mark on the chart itself
 *   - click-to-pin: clicking a chart point swaps the left-column primer
 *     for a live NewsPlanetAI query result panel covering the calendar
 *     month containing the clicked point
 *   - range cycling (YTD / 1Y / All) below the chart; on click the JS
 *     re-renders the chart's data layers (grid / baseline / area / line
 *     / briefs / x-labels / y-labels) for the filtered point window.
 *     The hero stat block above the chart does NOT change -- it is the
 *     publication's identity number for active trading, not a chart
 *     readout.
 *
 * Geometry math is ported from publish/charts.py:render_hero_chart_svg.
 * Both engines anchor zero in Y, pad +/-6%/10% around the data, and
 * place tick marks identically; on the All range a JS re-render is
 * pixel-equivalent to the server-rendered SVG.
 *
 * Fetch policy: a single /api/briefings/daily?from=&to= call per
 * monthly click, session-cached by period key (YYYY-MM). Coverage
 * floor 2025-08-01 -- months entirely before the floor skip the
 * network call.
 *
 * No framework. No dependencies. Bails silently if any required DOM
 * element is missing.
 */

(function () {
  "use strict";

  // ----- Constants -----

  var NPAI_API_BASE = "https://api.newsplanetai.com/api/briefings";
  var NPAI_BRIEFING_URL = "https://newsplanetai.com/briefing/";
  var NPAI_COVERAGE_FLOOR = "2025-08-01";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MONTHS_SHORT = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  var MONTHS_LONG = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // ----- Boot -----

  function init() {
    var dataEl = document.getElementById("hero-chart-data");
    var svg = document.getElementById("hero-chart-svg");
    if (!dataEl || !svg) return;

    var data;
    try {
      data = JSON.parse(dataEl.textContent);
    } catch (err) {
      return;
    }
    if (!data || !data.points || !data.points.length) return;

    var cursorGroup = svg.querySelector(".chart-cursor");
    if (!cursorGroup) return;

    var padL = data.pad.l;
    var padT = data.pad.t;
    var plotW = data.plot.w;
    var plotH = data.plot.h;
    var stroke = data.stroke_color || "#1a4d8c";
    var bg = data.bg_color || "#fdfdfb";
    var colors = data.colors || {};
    var fontSans = data.font_sans || "sans-serif";
    var strokeWidth = data.stroke_width || 1.6;

    var allPoints = data.points; // immutable raw source: [{date, value, px, py}]

    // visiblePoints is the chart's current px/value reference. On init
    // it matches the server-rendered All view exactly; on range change
    // it gets recomputed against the new visible subset. Hit-test and
    // crosshair-render both read from this.
    var visiblePoints = allPoints;
    var currentRange = "all";

    // Benchmark overlay state. benchmarkSeries holds the two raw
    // monthly composite arrays from publish/benchmarks.py (cmu_broad and
    // tmu_thesis). currentBenchmark is null (off) or one of those keys.
    // visibleBenchmark mirrors visiblePoints: it's the date-aligned
    // subset for the current range, with recomputed px/py.
    var benchmarkSeries = data.benchmark_series || { cmu_broad: [], tmu_thesis: [] };
    var benchmarkAvailable = !!(
      (benchmarkSeries.cmu_broad && benchmarkSeries.cmu_broad.length) ||
      (benchmarkSeries.tmu_thesis && benchmarkSeries.tmu_thesis.length)
    );
    var currentBenchmark = null; // null | "cmu_broad" | "tmu_thesis"
    var visibleBenchmark = [];

    // Caption strings live as constants so the weight breakdown
    // matches CMU_SPEC_v01.md authoritatively. Methodology link
    // points at the about.md anchor where the formula is explained.
    var BENCHMARK_LABELS = {
      cmu_broad: "CMU-Broad",
      tmu_thesis: "TMU-Thesis",
    };
    var BENCHMARK_CAPTIONS = {
      cmu_broad:
        'vs <strong>CMU-Broad</strong> &mdash; 40% SPY &middot; 25% IWM &middot; 15% DIA &middot; 10% QQQ &middot; 10% SGOV. ' +
        'Passive-indexing opportunity-cost baseline. ' +
        '<a href="/about.html#how-we-benchmark">Methodology &rarr;</a>',
      tmu_thesis:
        'vs <strong>TMU-Thesis</strong> &mdash; 30% IWM &middot; 20% SPY &middot; 15% XLE &middot; 15% XME &middot; 10% ITA &middot; 10% QQQ. ' +
        'Thesis-sector opportunity-cost baseline. ' +
        '<a href="/about.html#how-we-benchmark">Methodology &rarr;</a>',
    };

    // Left-column elements (landing page). Code guards every access so
    // this script is harmless on non-landing pages that include it.
    var primerEl   = document.getElementById("landing-primer");
    var readoutEl  = document.getElementById("landing-readout");
    var periodEl   = document.getElementById("readout-period");
    var contextEl  = document.getElementById("readout-context");
    var loadingEl  = document.getElementById("readout-loading");
    var errorEl    = document.getElementById("readout-error");
    var emptyEl    = document.getElementById("readout-empty");
    var listEl     = document.getElementById("readout-briefings");
    var backBtn    = document.getElementById("readout-back");

    // Range-control elements (landing page).
    var rangeControls = document.getElementById("chart-range-controls");

    // Benchmark-overlay control + caption elements (landing page).
    var benchmarkControls = document.getElementById("chart-benchmark-controls");
    var benchmarkCaptionEl = document.getElementById("chart-benchmark-caption");

    // Hover readout (small floating box top-left of the chart that
    // shows the date + cumulative-return % of the point under the
    // cursor). Distinct from the left-column click-readout: hover is
    // ephemeral and scan-oriented, click is pinned and detail-oriented.
    var hoverReadout = document.getElementById("hero-chart-readout");
    var hoverReadoutDate = document.getElementById("hero-chart-readout-date");
    var hoverReadoutValue = document.getElementById("hero-chart-readout-value");
    var hoverReadoutBenchmark = document.getElementById("hero-chart-readout-benchmark");

    var briefingsCache = {}; // key: "YYYY-MM" -> Promise<RenderResult>

    // The most recent period the user clicked into. Every async fetch
    // result checks this before rendering so a slow fetch from an
    // earlier click can never overwrite a newer click's display.
    var activePeriodKey = null;

    // ----- Hit-test (binary search on visiblePoints[i].px) -----

    function nearestIndex(clientX, rect) {
      var renderedWidth = rect.width || svg.getBoundingClientRect().width;
      var scale = data.width / renderedWidth;
      var svgX = (clientX - rect.left) * scale;

      var pts = visiblePoints;
      var lo = 0, hi = pts.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (pts[mid].px < svgX) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(pts[lo - 1].px - svgX) < Math.abs(pts[lo].px - svgX)) {
        lo = lo - 1;
      }
      return lo;
    }

    // ----- Crosshair render -----

    function renderCrosshair(idx) {
      while (cursorGroup.firstChild) cursorGroup.removeChild(cursorGroup.firstChild);
      var pts = visiblePoints;
      if (idx == null || idx < 0 || idx >= pts.length) return;
      var p = pts[idx];

      var line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", p.px);
      line.setAttribute("x2", p.px);
      line.setAttribute("y1", padT);
      line.setAttribute("y2", padT + plotH);
      line.setAttribute("stroke", "rgba(0,0,0,0.25)");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "2 2");
      cursorGroup.appendChild(line);

      var dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", p.px);
      dot.setAttribute("cy", p.py);
      dot.setAttribute("r", "4");
      dot.setAttribute("fill", bg);
      dot.setAttribute("stroke", stroke);
      dot.setAttribute("stroke-width", "2");
      cursorGroup.appendChild(dot);

      if (hoverReadout) {
        hoverReadout.hidden = false;
        if (hoverReadoutDate)  hoverReadoutDate.textContent  = formatMonthYear(p.date);
        if (hoverReadoutValue) hoverReadoutValue.textContent = formatPct(p.value);
        if (hoverReadoutBenchmark) {
          var bp = lookupBenchmarkAtDate(p.date);
          if (currentBenchmark && bp) {
            hoverReadoutBenchmark.hidden = false;
            hoverReadoutBenchmark.textContent =
              BENCHMARK_LABELS[currentBenchmark].toUpperCase() + " " + formatPct(bp.value);
          } else {
            hoverReadoutBenchmark.hidden = true;
          }
        }
      }
    }

    function clearCrosshair() {
      while (cursorGroup.firstChild) cursorGroup.removeChild(cursorGroup.firstChild);
      if (hoverReadout) hoverReadout.hidden = true;
    }

    function lookupBenchmarkAtDate(iso) {
      // visibleBenchmark is expected to be 1:1 with visiblePoints when
      // a benchmark is active, but defend against any sparkline/benchmark
      // misalignment by searching by date rather than index.
      if (!visibleBenchmark || !visibleBenchmark.length) return null;
      for (var i = 0; i < visibleBenchmark.length; i++) {
        if (visibleBenchmark[i].date === iso) return visibleBenchmark[i];
      }
      return null;
    }

    // ----- Geometry (mirror of publish/charts.py:render_hero_chart_svg) -----

    function isoToTs(iso) {
      var p = iso.split("-");
      var y = parseInt(p[0], 10);
      var m = parseInt(p[1], 10) - 1;
      var d = parseInt(p[2], 10);
      return Date.UTC(y, m, d, 12) / 1000;
    }

    function round2(v) { return Math.round(v * 100) / 100; }

    function computeGeometry(points, benchmarkPoints) {
      var values = points.map(function (p) { return p.value; });
      var tsList = points.map(function (p) { return isoToTs(p.date); });

      var xMin = tsList[0];
      var xMax = tsList[tsList.length - 1];
      var xSpan = Math.max(1, xMax - xMin);

      // Y-range anchors at zero and includes both portfolio and benchmark
      // values when a benchmark is active, so the chart auto-scales to fit
      // both lines.
      var yAnchor = values.concat([0]);
      if (benchmarkPoints && benchmarkPoints.length) {
        for (var bi = 0; bi < benchmarkPoints.length; bi++) {
          yAnchor.push(benchmarkPoints[bi].value);
        }
      }
      var yMinRaw = Math.min.apply(null, yAnchor);
      var yMaxRaw = Math.max.apply(null, yAnchor);
      if (yMinRaw === yMaxRaw) { yMinRaw -= 1; yMaxRaw += 1; }
      var ySpanRaw = yMaxRaw - yMinRaw;
      var yMin = yMinRaw - ySpanRaw * 0.06;
      var yMax = yMaxRaw + ySpanRaw * 0.10;
      var yRange = (yMax - yMin) || 1;

      function xPx(ts) { return padL + ((ts - xMin) / xSpan) * plotW; }
      function yPx(v) { return padT + (1 - (v - yMin) / yRange) * plotH; }

      // X-axis ticks: prefer Jan-1 year labels; fall back to MMM-YYYY
      // endpoints when fewer than two year ticks land in range. Mirrors
      // publish/charts.py:_x_ticks so SSR and JS paths produce
      // pixel-equivalent axis labels.
      var startYear = new Date(xMin * 1000).getUTCFullYear();
      var endYear = new Date(xMax * 1000).getUTCFullYear();
      var span = endYear - startYear;
      var step = span <= 4 ? 1 : (span <= 8 ? 2 : 4);
      var xTicks = [];
      for (var y = startYear; y <= endYear; y += step) {
        var ts = Date.UTC(y, 0, 1, 12) / 1000;
        if (ts >= xMin && ts <= xMax) xTicks.push({ label: String(y), ts: ts });
      }
      if (xTicks.length < 2) {
        var monthsShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        function monthYear(ts) {
          var dt = new Date(ts * 1000);
          return monthsShort[dt.getUTCMonth()] + " " + dt.getUTCFullYear();
        }
        xTicks = [
          { label: monthYear(xMin), ts: xMin },
          { label: monthYear(xMax), ts: xMax },
        ];
      }

      var yTicks = [];
      for (var k = 0; k <= 4; k++) {
        yTicks.push(yMin + (yMax - yMin) * (k / 4));
      }

      var showBaseline = yMin < 0 && yMax > 0;
      var baselineY = showBaseline ? yPx(0) : null;

      var visible = points.map(function (p, i) {
        return {
          date: p.date,
          value: p.value,
          px: round2(xPx(tsList[i])),
          py: round2(yPx(p.value)),
        };
      });

      var briefs = [];
      (data.briefs || []).forEach(function (b) {
        var bts = isoToTs(b.date);
        if (bts >= xMin && bts <= xMax) {
          briefs.push({ date: b.date, x: round2(xPx(bts)) });
        }
      });

      var benchmarkVisible = null;
      if (benchmarkPoints && benchmarkPoints.length) {
        benchmarkVisible = benchmarkPoints.map(function (bp) {
          return {
            date: bp.date,
            value: bp.value,
            px: round2(xPx(isoToTs(bp.date))),
            py: round2(yPx(bp.value)),
          };
        });
      }

      return {
        visible: visible,
        benchmarkVisible: benchmarkVisible,
        briefs: briefs,
        xPx: xPx, yPx: yPx,
        xMin: xMin, xMax: xMax,
        yMin: yMin, yMax: yMax,
        xTicks: xTicks,
        yTicks: yTicks,
        baselineY: baselineY,
      };
    }

    function buildLinePath(visible) {
      if (!visible.length) return "";
      var parts = ["M " + visible[0].px.toFixed(2) + " " + visible[0].py.toFixed(2)];
      for (var i = 1; i < visible.length; i++) {
        parts.push("L " + visible[i].px.toFixed(2) + " " + visible[i].py.toFixed(2));
      }
      return parts.join(" ");
    }

    function buildAreaPath(visible, geom) {
      if (!visible.length) return "";
      var zeroY = geom.yPx(Math.max(0, geom.yMin));
      var parts = ["M " + visible[0].px.toFixed(2) + " " + zeroY.toFixed(2)];
      for (var i = 0; i < visible.length; i++) {
        parts.push("L " + visible[i].px.toFixed(2) + " " + visible[i].py.toFixed(2));
      }
      parts.push("L " + visible[visible.length - 1].px.toFixed(2) + " " + zeroY.toFixed(2));
      parts.push("Z");
      return parts.join(" ");
    }

    function fmtYAxis(v) {
      if (Math.abs(v) < 0.5) return "0%";
      var sign = v >= 0 ? "+" : "−"; // proper minus
      return sign + Math.round(Math.abs(v)) + "%";
    }

    function svgEl(tag, attrs, textContent) {
      var el = document.createElementNS(SVG_NS, tag);
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          el.setAttribute(k, attrs[k]);
        }
      }
      if (textContent != null) el.textContent = textContent;
      return el;
    }

    // ----- SVG re-render (replaces every data layer; keeps cursor group) -----

    function rerender(geom) {
      var toRemove = svg.querySelectorAll(
        ".chart-grid, .chart-baseline, .chart-brief-mark, .chart-benchmark-line, .chart-area, .chart-line, .chart-x-label, .chart-y-label"
      );
      for (var i = 0; i < toRemove.length; i++) {
        toRemove[i].parentNode.removeChild(toRemove[i]);
      }

      var frag = document.createDocumentFragment();

      // Y grid (drawn first so everything sits over it).
      geom.yTicks.forEach(function (yv) {
        var y = geom.yPx(yv);
        frag.appendChild(svgEl("line", {
          "class": "chart-grid",
          "x1": padL,
          "x2": padL + plotW,
          "y1": y.toFixed(2),
          "y2": y.toFixed(2),
          "stroke": colors.grid || "rgba(0,0,0,0.05)",
          "stroke-width": "1",
        }));
      });

      if (geom.baselineY != null) {
        frag.appendChild(svgEl("line", {
          "class": "chart-baseline",
          "x1": padL,
          "x2": padL + plotW,
          "y1": geom.baselineY.toFixed(2),
          "y2": geom.baselineY.toFixed(2),
          "stroke": colors.baseline || "rgba(0,0,0,0.18)",
          "stroke-width": "1",
          "stroke-dasharray": "2 3",
        }));
      }

      geom.briefs.forEach(function (m) {
        var g = svgEl("g", {
          "class": "chart-brief-mark",
          "data-date": m.date,
        });
        g.appendChild(svgEl("line", {
          "x1": m.x.toFixed(2),
          "x2": m.x.toFixed(2),
          "y1": padT,
          "y2": padT + plotH,
          "stroke": colors.brief_line || "rgba(26,77,140,0.35)",
          "stroke-width": "1",
          "stroke-dasharray": "2 3",
        }));
        g.appendChild(svgEl("circle", {
          "cx": m.x.toFixed(2),
          "cy": padT - 1,
          "r": "2.5",
          "fill": colors.brief_dot || "rgba(26,77,140,0.9)",
        }));
        frag.appendChild(g);
      });

      // Benchmark line (drawn before the portfolio area+line so it
      // sits behind, visually subordinate). Dashed warm-brown to
      // distinguish from the portfolio's solid accent-blue.
      if (geom.benchmarkVisible && geom.benchmarkVisible.length) {
        var benchPath = buildLinePath(geom.benchmarkVisible);
        if (benchPath) {
          frag.appendChild(svgEl("path", {
            "class": "chart-benchmark-line",
            "d": benchPath,
            "fill": "none",
            "stroke": colors.benchmark || "#9b8a6e",
            "stroke-width": "1.2",
            "stroke-dasharray": "4 3",
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
          }));
        }
      }

      var areaPath = buildAreaPath(geom.visible, geom);
      if (areaPath) {
        frag.appendChild(svgEl("path", {
          "class": "chart-area",
          "d": areaPath,
          "fill": colors.area_fill || "rgba(26,77,140,0.10)",
          "stroke": "none",
        }));
      }

      var linePath = buildLinePath(geom.visible);
      frag.appendChild(svgEl("path", {
        "class": "chart-line",
        "d": linePath,
        "fill": "none",
        "stroke": colors.accent || stroke,
        "stroke-width": String(strokeWidth),
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }));

      geom.xTicks.forEach(function (t) {
        frag.appendChild(svgEl("text", {
          "class": "chart-x-label",
          "x": geom.xPx(t.ts).toFixed(2),
          "y": padT + plotH + 16,
          "fill": colors.text_muted || "#5a5a5a",
          "font-size": "11",
          "font-family": fontSans,
          "text-anchor": "middle",
        }, t.label));
      });

      geom.yTicks.forEach(function (yv) {
        frag.appendChild(svgEl("text", {
          "class": "chart-y-label",
          "x": padL + plotW + 6,
          "y": (geom.yPx(yv) + 4).toFixed(2),
          "fill": colors.text_muted || "#5a5a5a",
          "font-size": "11",
          "font-family": fontSans,
          "text-anchor": "start",
        }, fmtYAxis(yv)));
      });

      // Insert before the cursor group so it remains topmost.
      svg.insertBefore(frag, cursorGroup);
    }

    // ----- Range filtering -----

    function filterForRange(range) {
      if (range === "all" || !allPoints.length) return allPoints;
      if (range === "ytd") {
        var latestYear = allPoints[allPoints.length - 1].date.substring(0, 4);
        return allPoints.filter(function (p) { return p.date >= latestYear + "-01-01"; });
      }
      if (range === "1y") {
        // Chart cadence is monthly; "trailing 12 months" = last 12 closes.
        return allPoints.length > 12 ? allPoints.slice(allPoints.length - 12) : allPoints;
      }
      return allPoints;
    }

    function filterBenchmarkForDates(benchmarkArray, dates) {
      if (!benchmarkArray || !benchmarkArray.length || !dates.length) return [];
      var byDate = {};
      for (var i = 0; i < benchmarkArray.length; i++) {
        byDate[benchmarkArray[i].date] = benchmarkArray[i];
      }
      var out = [];
      for (var j = 0; j < dates.length; j++) {
        var p = byDate[dates[j]];
        if (p) out.push({ date: p.date, value: p.value });
      }
      return out;
    }

    function refresh() {
      // Single render path used by both setRange and setBenchmark so the
      // filter + geometry + draw + crosshair-clear sequence stays in one
      // place. visiblePoints and visibleBenchmark are the cached results
      // hit-test and renderCrosshair read from.
      var filtered = filterForRange(currentRange);
      if (!filtered.length) return;
      var benchmarkArray = currentBenchmark ? (benchmarkSeries[currentBenchmark] || []) : null;
      var filteredBenchmark = benchmarkArray
        ? filterBenchmarkForDates(benchmarkArray, filtered.map(function (p) { return p.date; }))
        : null;
      var geom = computeGeometry(filtered, filteredBenchmark);
      visiblePoints = geom.visible;
      visibleBenchmark = geom.benchmarkVisible || [];
      rerender(geom);
      clearCrosshair(); // crosshair indexes into the old px space; invalidate.
    }

    function setRange(range) {
      if (range === currentRange) return;
      currentRange = range;
      refresh();
      updateRangeButtons();
    }

    function setBenchmark(key) {
      // Mutually exclusive: clicking the active pill deselects (off);
      // clicking an inactive pill switches to it.
      var next = (currentBenchmark === key) ? null : key;
      if (next === currentBenchmark) return;
      currentBenchmark = next;
      refresh();
      updateBenchmarkButtons();
      updateBenchmarkCaption();
    }

    function updateRangeButtons() {
      if (!rangeControls) return;
      var buttons = rangeControls.querySelectorAll(".chart-range-btn");
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var isActive = b.getAttribute("data-range") === currentRange;
        b.classList.toggle("chart-range-btn-active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      }
    }

    function updateBenchmarkButtons() {
      if (!benchmarkControls) return;
      var buttons = benchmarkControls.querySelectorAll(".chart-benchmark-btn");
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var isActive = b.getAttribute("data-benchmark") === currentBenchmark;
        b.classList.toggle("chart-benchmark-btn-active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
      }
    }

    function updateBenchmarkCaption() {
      if (!benchmarkCaptionEl) return;
      if (currentBenchmark && BENCHMARK_CAPTIONS[currentBenchmark]) {
        benchmarkCaptionEl.innerHTML = BENCHMARK_CAPTIONS[currentBenchmark];
        benchmarkCaptionEl.hidden = false;
      } else {
        benchmarkCaptionEl.hidden = true;
        benchmarkCaptionEl.innerHTML = "";
      }
    }

    // ----- Period derivation (for NPAI readout) -----

    function periodForPoint(idx) {
      // Today the chart is monthly; period_end is the last day of a month.
      // Period = calendar month containing period_end.
      var p = visiblePoints[idx];
      var parts = p.date.split("-");
      var year = parseInt(parts[0], 10);
      var month = parseInt(parts[1], 10); // 1-12
      var lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

      var days = [];
      for (var d = 1; d <= lastDay; d++) {
        var iso = year + "-" + pad2(month) + "-" + pad2(d);
        days.push(iso);
      }
      return {
        key:    year + "-" + pad2(month),
        label:  MONTHS_LONG[month - 1] + " " + year,
        days:   days,
        value:  p.value,  // cumulative return % at period_end
      };
    }

    function pad2(n) { return n < 10 ? "0" + n : "" + n; }

    // ----- NPAI fetch -----

    // One request covers the entire calendar month. Server returns one
    // briefing per day in [from, to] (latest of each day), matching the
    // single-day endpoint's per-item shape.
    function fetchBriefingsForPeriod(period) {
      var coveredDays = period.days.filter(function (d) { return d >= NPAI_COVERAGE_FLOOR; });

      if (coveredDays.length === 0) {
        return Promise.resolve({ briefings: [], empty: true, error: false });
      }

      var from = coveredDays[0];
      var to = coveredDays[coveredDays.length - 1];
      var url = NPAI_API_BASE + "/daily?from=" + from + "&to=" + to;

      return fetch(url, { mode: "cors" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) {
          var briefings = (data && data.briefings) ? data.briefings.slice() : [];
          // Defensive newest-first sort; server already returns this order.
          briefings.sort(function (a, b) {
            return (a.generated_at < b.generated_at) ? 1 : -1;
          });
          return {
            briefings: briefings,
            empty: briefings.length === 0,
            error: false,
          };
        });
    }

    // ----- Render -----

    function showPrimer() {
      if (!readoutEl || !primerEl) return;
      readoutEl.hidden = true;
      primerEl.hidden = false;
      // Clear active intent so any still-in-flight fetches from prior
      // clicks won't render into the now-hidden readout.
      activePeriodKey = null;
    }

    function clearList() {
      if (!listEl) return;
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    }

    function setStatus(state) {
      // state: "loading" | "error" | "empty" | "ok"
      if (loadingEl) loadingEl.hidden = state !== "loading";
      if (errorEl)   errorEl.hidden   = state !== "error";
      if (emptyEl)   emptyEl.hidden   = state !== "empty";
      if (listEl)    listEl.hidden    = state !== "ok";
    }

    function showReadout(idx) {
      if (!primerEl || !readoutEl || idx == null || idx < 0 || idx >= visiblePoints.length) return;
      var period = periodForPoint(idx);

      // Stamp this click as the active intent. Every async resolver
      // below will check this before rendering.
      activePeriodKey = period.key;

      // Open the readout, set heading. The heading change is the
      // first visible feedback the user gets on each click.
      primerEl.hidden = true;
      readoutEl.hidden = false;
      if (periodEl)  periodEl.textContent  = period.label;
      if (contextEl) contextEl.textContent = "Cumulative return at period end: " + formatPct(period.value);

      // Clear any prior briefings list and show the loading status,
      // unconditionally. Without this, a previous render's list rows
      // are still visible under the new period heading until the new
      // fetch lands -- which reads to the user as "the date didn't
      // change." On cache hits the loading flash is a single tick.
      clearList();
      setStatus("loading");

      if (briefingsCache[period.key]) {
        briefingsCache[period.key].then(function (result) {
          if (activePeriodKey === period.key) renderResult(result);
        });
        return;
      }

      var p = fetchBriefingsForPeriod(period).catch(function () {
        return { briefings: [], empty: false, error: true };
      });
      briefingsCache[period.key] = p;
      p.then(function (result) {
        if (activePeriodKey === period.key) renderResult(result);
      });
    }

    function renderResult(result) {
      if (!listEl) return;
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

      if (result.error) {
        setStatus("error");
        return;
      }
      if (result.empty) {
        setStatus("empty");
        return;
      }

      result.briefings.forEach(function (b) {
        var li = document.createElement("li");
        li.className = "readout-brief";

        var a = document.createElement("a");
        a.href = NPAI_BRIEFING_URL + b.id;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "readout-brief-link";

        var dateEl = document.createElement("p");
        dateEl.className = "readout-brief-date";
        dateEl.textContent = formatDateForRow(b.generated_at);

        var snippetEl = document.createElement("p");
        snippetEl.className = "readout-brief-snippet";
        snippetEl.textContent = firstSentence(b.world_watches || "");

        a.appendChild(dateEl);
        a.appendChild(snippetEl);
        li.appendChild(a);
        listEl.appendChild(li);
      });

      setStatus("ok");
    }

    // ----- Formatting helpers -----

    function formatPct(v) {
      var sign = v >= 0 ? "+" : "−"; // proper minus
      return sign + Math.abs(v).toFixed(1) + "%";
    }

    function formatMonthYear(iso) {
      // "2026-04-30" -> "APR 2026"  (CSS .readout-date uppercases,
      // but MONTHS_SHORT is already uppercase -- consistent either way.)
      var parts = iso.split("-");
      var m = parseInt(parts[1], 10);
      return MONTHS_SHORT[m - 1] + " " + parts[0];
    }

    function formatDateForRow(iso) {
      // "2025-09-15T03:36:13.270Z" -> "SEP 15"
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return MONTHS_SHORT[d.getUTCMonth()] + " " + d.getUTCDate();
    }

    function firstSentence(text) {
      if (!text) return "";
      // Take up to the first sentence terminator; cap at ~180 chars.
      var s = text.replace(/\s+/g, " ").trim();
      var m = s.match(/^[^.!?]{20,180}[.!?]/);
      if (m) return m[0];
      return s.length > 180 ? s.slice(0, 180) + "…" : s;
    }

    // ----- Event wiring -----

    svg.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      renderCrosshair(nearestIndex(e.clientX, rect));
    });
    svg.addEventListener("mouseleave", function () { clearCrosshair(); });

    svg.addEventListener("click", function (e) {
      var rect = svg.getBoundingClientRect();
      var idx = nearestIndex(e.clientX, rect);
      renderCrosshair(idx);
      showReadout(idx);
    });

    svg.style.cursor = "pointer";

    svg.addEventListener("touchstart", function (e) {
      if (!e.touches.length) return;
      var t = e.touches[0];
      var rect = svg.getBoundingClientRect();
      var idx = nearestIndex(t.clientX, rect);
      renderCrosshair(idx);
      showReadout(idx);
    }, { passive: true });

    if (backBtn) {
      backBtn.addEventListener("click", function () {
        clearCrosshair();
        showPrimer();
      });
    }

    // Reveal and wire the range controls. They render with [hidden]
    // server-side so non-JS readers don't see inert buttons.
    if (rangeControls) {
      rangeControls.hidden = false;
      rangeControls.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest && e.target.closest(".chart-range-btn");
        if (!btn) return;
        var range = btn.getAttribute("data-range");
        if (range) setRange(range);
      });
    }

    // Reveal and wire the benchmark controls only when the build
    // shipped benchmark data in hero_chart_data. Older builds without
    // the benchmark pipeline leave the pills hidden rather than show
    // controls that would render a blank line.
    if (benchmarkControls && benchmarkAvailable) {
      benchmarkControls.hidden = false;
      benchmarkControls.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest && e.target.closest(".chart-benchmark-btn");
        if (!btn) return;
        var key = btn.getAttribute("data-benchmark");
        if (key) setBenchmark(key);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
