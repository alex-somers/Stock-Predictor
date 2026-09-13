(function () {
  // ---- Configuration ----------------------------------------------------
  const TICKERS = ["MU", "NVDA", "CRWV", "SKHY", "AAOI", "SNDK", "VOO", "AAPL", "META", "TSLA"];
  const REFRESH_SECONDS = 20;
  const TREND_WINDOW = 30; // trading days used for the trend line

  // ---- DOM references -----------------------------------------------------
  const rowsEl = document.getElementById("rows");
  const clockEl = document.getElementById("clock");
  const refreshStatusEl = document.getElementById("refresh-status");
  const overlayEl = document.getElementById("modal-overlay");
  const modalContentEl = document.getElementById("modal-content");
  const modalCloseEl = document.getElementById("modal-close");

  const state = {}; // ticker -> { name, price, prevClose, closes, dates, trendPerDay, target, ... }
  let chartInstance = null;

  // ---- Clock ----------------------------------------------------------
  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ---- Networking (Yahoo Finance via CORS fallback proxy) ---------------
  async function fetchJsonWithFallback(directUrl) {
    const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;
    for (const url of [directUrl, proxied]) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("bad status " + res.status);
        return await res.json();
      } catch (e) {
        // try next
      }
    }
    throw new Error("all fetch attempts failed for " + directUrl);
  }

  async function fetchChart(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
    const json = await fetchJsonWithFallback(url);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error("no chart data");
    return result;
  }

  // Best-effort: real fundamentals / analyst data. This endpoint is less
  // reliable (Yahoo sometimes requires an auth handshake), so callers should
  // treat a failure here as "financial context unavailable" and carry on.
  async function fetchFinancials(ticker) {
    const modules = "summaryDetail,defaultKeyStatistics,financialData,price";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
    const json = await fetchJsonWithFallback(url);
    const result = json?.quoteSummary?.result?.[0];
    if (!result) throw new Error("no financials");
    return result;
  }

  // ---- Math helpers -----------------------------------------------------

  // Ordinary least squares over index vs price. Returns slope ($/day),
  // intercept, and R^2 (how well a straight line actually fits the data --
  // low R^2 means the "trend" is mostly noise).
  function linearRegression(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: values[0] || 0, r2: 0 };
    const xs = values.map((_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (values[i] - meanY);
      den += (xs[i] - meanX) * (xs[i] - meanX);
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;

    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const predicted = intercept + slope * xs[i];
      ssRes += (values[i] - predicted) ** 2;
      ssTot += (values[i] - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    return { slope, intercept, r2 };
  }

  // Annualized volatility from daily closes (stdev of daily returns * sqrt(252)).
  function annualizedVolatility(closes) {
    if (closes.length < 3) return 0;
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  function computeEta(price, target, trendPerDay) {
    const distance = target - price;
    if (Math.abs(distance) < 0.005) return { status: "at-target" };
    const movingTowards = (distance > 0 && trendPerDay > 0) || (distance < 0 && trendPerDay < 0);
    if (!movingTowards || trendPerDay === 0) return { status: "off-pace" };
    const tradingDays = Math.abs(distance / trendPerDay);
    const calendarDays = Math.round((tradingDays * 7) / 5);
    if (calendarDays > 3650) return { status: "too-far" };
    const date = new Date();
    date.setDate(date.getDate() + calendarDays);
    return { status: "ok", date, calendarDays, tradingDays };
  }

  // ---- Board rows ---------------------------------------------------------
  function buildRowSkeleton(ticker) {
    const row = document.createElement("div");
    row.className = "row";
    row.id = "row-" + ticker;
    row.innerHTML = `
      <div class="row-inner">
        <div class="ticker" data-ticker="${ticker}">${ticker}</div>
        <div class="name loading-txt">Loading…</div>
        <div class="price">—</div>
        <div class="chg">—</div>
        <div class="target-wrap">
          <span>$</span><input class="target-input" data-ticker="${ticker}" placeholder="—" disabled />
        </div>
        <div class="eta"><span class="eta-main">—</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
      </div>
    `;
    return row;
  }

  TICKERS.forEach((t) => rowsEl.appendChild(buildRowSkeleton(t)));

  function renderRow(ticker) {
    const s = state[ticker];
    const row = document.getElementById("row-" + ticker);
    if (!s || s.error) {
      const nameEl = row.querySelector(".name");
      nameEl.textContent = "Unavailable";
      nameEl.classList.remove("loading-txt");
      nameEl.classList.add("err-txt");
      return;
    }
    const nameEl = row.querySelector(".name");
    nameEl.classList.remove("loading-txt", "err-txt");
    nameEl.textContent = s.name;
    row.querySelector(".price").textContent = "$" + s.price.toFixed(2);

    const chgEl = row.querySelector(".chg");
    const chg = s.price - s.prevClose;
    const pct = (chg / s.prevClose) * 100;
    chgEl.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)";
    chgEl.classList.remove("up", "down");
    chgEl.classList.add(chg >= 0 ? "up" : "down");

    const input = row.querySelector(".target-input");
    input.disabled = false;
    input.value = s.target.toFixed(2);

    updateEtaDisplay(ticker);
  }

  function updateEtaDisplay(ticker) {
    const s = state[ticker];
    const row = document.getElementById("row-" + ticker);
    const etaEl = row.querySelector(".eta");
    const barFill = row.querySelector(".bar-fill");

    const baseline = Math.min(s.price, s.target) * 0.8;
    const span = Math.max(s.target, s.price) - baseline || 1;
    const progress = Math.max(0, Math.min(100, ((s.price - baseline) / span) * 100));
    barFill.style.width = progress + "%";

    const eta = computeEta(s.price, s.target, s.trendPerDay);
    if (eta.status === "at-target") {
      etaEl.innerHTML = `<span class="eta-main">At target</span>`;
    } else if (eta.status === "off-pace") {
      etaEl.innerHTML = `<span class="eta-main">—</span><br><span class="eta-off">not on pace</span>`;
    } else if (eta.status === "too-far") {
      etaEl.innerHTML = `<span class="eta-main">—</span><br><span class="eta-off">10y+</span>`;
    } else {
      const dateStr = eta.date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      etaEl.innerHTML = `<span class="eta-main">${dateStr}</span><br><span class="eta-off">~${eta.calendarDays}d at current trend</span>`;
    }
  }

  // ---- Loading a ticker's price/trend data ---------------------------------
  async function loadTicker(ticker, preserveTarget) {
    const prevTarget = preserveTarget && state[ticker] && !state[ticker].error ? state[ticker].target : null;
    try {
      const result = await fetchChart(ticker);
      const meta = result.meta;
      const timestamps = result.timestamp || [];
      const closesRaw = result.indicators?.quote?.[0]?.close || [];

      // Drop any null candles (holidays / gaps) and keep dates aligned.
      const dates = [];
      const closes = [];
      for (let i = 0; i < closesRaw.length; i++) {
        if (closesRaw[i] != null) {
          dates.push(new Date(timestamps[i] * 1000));
          closes.push(closesRaw[i]);
        }
      }

      const recentCloses = closes.slice(-TREND_WINDOW);
      const { slope, r2 } = linearRegression(recentCloses.length >= 2 ? recentCloses : closes);
      const price = meta.regularMarketPrice ?? closes[closes.length - 1];
      const prevClose = meta.previousClose ?? closes[closes.length - 2] ?? price;

      state[ticker] = {
        name: meta.longName || meta.shortName || ticker,
        price,
        prevClose,
        dates,
        closes,
        trendPerDay: slope,
        trendR2: r2,
        volatility: annualizedVolatility(closes.slice(-60)),
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        target: prevTarget != null ? prevTarget : Math.round(price * 1.2 * 100) / 100,
        error: false,
      };
    } catch (e) {
      state[ticker] = { error: true };
    }
    renderRow(ticker);
  }

  // ---- Target price editing ----------------------------------------------
  rowsEl.addEventListener("input", (e) => {
    if (!e.target.classList.contains("target-input")) return;
    const t = e.target.dataset.ticker;
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && state[t]) {
      state[t].target = v;
      updateEtaDisplay(t);
    }
  });

  // ---- Ticker click -> detail modal ---------------------------------------
  rowsEl.addEventListener("click", (e) => {
    const el = e.target.closest(".ticker");
    if (!el) return;
    openModal(el.dataset.ticker);
  });

  modalCloseEl.addEventListener("click", closeModal);
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  function closeModal() {
    overlayEl.classList.add("hidden");
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
  }

  function fmtBig(n) {
    if (n == null || isNaN(n)) return "—";
    if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    return "$" + n.toFixed(0);
  }

  async function openModal(ticker) {
    const s = state[ticker];
    if (!s || s.error) return;

    overlayEl.classList.remove("hidden");
    modalContentEl.innerHTML = `
      <h2 class="modal-title">${ticker}</h2>
      <p class="modal-sub">${s.name}</p>
      <div class="chart-wrap"><canvas id="detail-chart"></canvas></div>
      <div class="confidence-line" id="confidence-line">Loading trend confidence…</div>
      <div class="fin-grid" id="fin-grid">
        <div class="fin-item"><div class="fin-label">Loading financials…</div></div>
      </div>
      <p class="modal-note">
        The dashed line is a straight-line extension of the last ${TREND_WINDOW} trading days — it assumes
        tomorrow looks like the recent past, which is a big assumption for any stock. R² and volatility below
        describe how well that assumption has been holding, not whether the target will actually be hit.
        Analyst figures (when available) are third-party estimates, not a confirmation of this chart's math.
      </p>
    `;

    renderConfidenceLine(ticker);
    renderDetailChart(ticker);
    renderFinancialsPlaceholder(ticker);

    try {
      const fin = await fetchFinancials(ticker);
      renderFinancials(ticker, fin);
    } catch (e) {
      document.getElementById("fin-grid").innerHTML = `
        <div class="fin-item"><div class="fin-label">Financials</div><div class="fin-value err-txt">Unavailable right now</div></div>
      `;
    }
  }

  function renderConfidenceLine(ticker) {
    const s = state[ticker];
    const el = document.getElementById("confidence-line");
    const r2Pct = (s.trendR2 * 100).toFixed(0);
    const volPct = (s.volatility * 100).toFixed(0);
    let read;
    if (s.trendR2 > 0.6) read = "trend fits recent data closely";
    else if (s.trendR2 > 0.3) read = "trend fits loosely -- treat with caution";
    else read = "trend barely fits -- recent moves are mostly noise";
    el.innerHTML = `<span class="label">Trend fit (R²):</span> ${r2Pct}% (${read}) &nbsp;·&nbsp; <span class="label">Annualized volatility:</span> ${volPct}%`;
  }

  function renderFinancialsPlaceholder(ticker) {
    const s = state[ticker];
    document.getElementById("fin-grid").innerHTML = `
      <div class="fin-item"><div class="fin-label">52-week range</div><div class="fin-value">$${(s.fiftyTwoWeekLow ?? 0).toFixed(2)} – $${(s.fiftyTwoWeekHigh ?? 0).toFixed(2)}</div></div>
      <div class="fin-item"><div class="fin-label">Current price</div><div class="fin-value">$${s.price.toFixed(2)}</div></div>
    `;
  }

  function renderFinancials(ticker, fin) {
    const summary = fin.summaryDetail || {};
    const keyStats = fin.defaultKeyStatistics || {};
    const financialData = fin.financialData || {};
    const g = (obj, key) => obj?.[key]?.raw ?? obj?.[key] ?? null;

    const marketCap = g(summary, "marketCap");
    const trailingPE = g(summary, "trailingPE");
    const beta = g(keyStats, "beta");
    const avgVolume = g(summary, "averageVolume");
    const targetMean = g(financialData, "targetMeanPrice");
    const recommendation = financialData?.recommendationKey;
    const numAnalysts = g(financialData, "numberOfAnalystOpinions");

    document.getElementById("fin-grid").innerHTML = `
      <div class="fin-item"><div class="fin-label">Market cap</div><div class="fin-value">${fmtBig(marketCap)}</div></div>
      <div class="fin-item"><div class="fin-label">Trailing P/E</div><div class="fin-value">${trailingPE ? trailingPE.toFixed(1) : "—"}</div></div>
      <div class="fin-item"><div class="fin-label">Beta</div><div class="fin-value">${beta ? beta.toFixed(2) : "—"}</div></div>
      <div class="fin-item"><div class="fin-label">Avg. daily volume</div><div class="fin-value">${avgVolume ? (avgVolume / 1e6).toFixed(1) + "M" : "—"}</div></div>
      <div class="fin-item"><div class="fin-label">Analyst mean target</div><div class="fin-value">${targetMean ? "$" + targetMean.toFixed(2) : "—"}</div></div>
      <div class="fin-item"><div class="fin-label">Analyst consensus</div><div class="fin-value">${recommendation ? recommendation.replace(/_/g, " ") + (numAnalysts ? ` (${numAnalysts})` : "") : "—"}</div></div>
    `;
  }

  function renderDetailChart(ticker) {
    const s = state[ticker];
    const ctx = document.getElementById("detail-chart").getContext("2d");

    // Historical points
    const histLabels = s.dates.map((d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const histData = s.closes;

    // Projection: extend from the last real point to the ETA date (or 90 days
    // out if off-pace, just to show the flat/wrong-direction line).
    const eta = computeEta(s.price, s.target, s.trendPerDay);
    const projectionDays = eta.status === "ok" ? eta.calendarDays : 90;
    const projLabels = [];
    const projData = [];
    const lastDate = s.dates[s.dates.length - 1];
    const stepDays = Math.max(1, Math.round(projectionDays / 20));
    for (let d = 0; d <= projectionDays; d += stepDays) {
      const date = new Date(lastDate);
      date.setDate(date.getDate() + d);
      projLabels.push(date.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      const tradingDayEquiv = d * (5 / 7);
      projData.push(s.price + s.trendPerDay * tradingDayEquiv);
    }

    const labels = [...histLabels, ...projLabels.slice(1)];
    const historySeries = [...histData, ...Array(projLabels.length - 1).fill(null)];
    const projectionSeries = [...Array(histData.length - 1).fill(null), s.price, ...projData.slice(1)];
    const targetSeries = labels.map(() => s.target);

    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Price history",
            data: historySeries,
            borderColor: "#E9E4D8",
            borderWidth: 1.5,
            pointRadius: 0,
            spanGaps: false,
          },
          {
            label: "Projection",
            data: projectionSeries,
            borderColor: "#E8A33D",
            borderDash: [5, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            spanGaps: true,
          },
          {
            label: "Target",
            data: targetSeries,
            borderColor: "#C1666B",
            borderWidth: 1,
            pointRadius: 0,
            borderDash: [2, 2],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { color: "#8C9AA0", maxTicksLimit: 8 }, grid: { color: "#2B363C" } },
          y: { ticks: { color: "#8C9AA0" }, grid: { color: "#2B363C" } },
        },
        plugins: {
          legend: { labels: { color: "#E9E4D8", boxWidth: 12, font: { size: 11 } } },
        },
      },
    });
  }

  // ---- Boot + auto-refresh -------------------------------------------------
  async function initialLoad() {
    await Promise.all(TICKERS.map((t) => loadTicker(t, false)));
  }

  let secondsLeft = REFRESH_SECONDS;
  initialLoad().then(() => {
    setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        refreshStatusEl.textContent = "refreshing…";
        Promise.all(TICKERS.map((t) => loadTicker(t, true))).then(() => {
          secondsLeft = REFRESH_SECONDS;
        });
      } else {
        refreshStatusEl.textContent = "next refresh in " + secondsLeft + "s";
      }
    }, 1000);
  });
})();
