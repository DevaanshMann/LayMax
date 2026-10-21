(() => {
  const $ = (sel) => document.querySelector(sel);
  const form = $("#trip-form");
  const screens = { input: $("#input-screen"), loading: $("#loading-screen"), output: $("#output-screen") };
  const isMock = !!document.querySelector(".mock-badge");
  let lastResult = null;
  let loadingTimer = null;
  let demoSample = null;

  const VERDICT_TEXT = {
    GO: { stamp: "GO", title: "Get out and explore." },
    CAUTION: { stamp: "CAUTION", title: "Go, but keep it tight." },
    NO_GO: { stamp: "NO GO", title: "Stay at the airport this time." },
  };
  const ENTRY_TEXT = {
    visa_free: ["Visa-free entry", "ok"],
    visa_on_arrival: ["Visa on arrival", "warn"],
    transit_exemption: ["Transit exemption", "ok"],
    visa_required: ["Visa required", "bad"],
    uncertain: ["Check before you fly", "warn"],
  };
  const STOP_LABEL = { transit: "Transit", food: "Food", sight: "Sight", activity: "Activity", airport: "Airport", rest: "Rest" };
  // Rough rates, only used to highlight the matching budget tier as the user types.
  const USD_PER = { USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012, CAD: 0.73, AUD: 0.66, SGD: 0.74, AED: 0.27, JPY: 0.0067, CNY: 0.14 };
  const SHORT_COST = 22;

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "style") node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }
  const fill = (sel, items) => $(sel).replaceChildren(...items.map((t) => el("li", {}, t)));
  const hhmm = (iso) => iso.slice(11, 16);
  function dayOffset(iso, baseIso) {
    const d = Math.round((new Date(iso.slice(0, 10)) - new Date(baseIso.slice(0, 10))) / 864e5);
    return d === 1 ? "next day" : d > 1 ? `+${d} days` : "";
  }
  function duration(min) {
    if (min <= 0) return "0m";
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h${m ? ` ${String(m).padStart(2, "0")}m` : ""}` : `${m}m`;
  }
  function toLocalInput(date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }
  function restartAnimation(node) {
    node.style.animation = "none";
    void node.offsetWidth;
    node.style.animation = "";
  }
  function show(name) {
    for (const [k, s] of Object.entries(screens)) s.hidden = k !== name;
    $("#sky").classList.toggle("compact", name !== "input");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- light / dark theme ----------
  const themeBtn = $("#theme-toggle");
  function setTheme(theme, save) {
    document.documentElement.setAttribute("data-theme", theme);
    themeBtn.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
    if (save) try { localStorage.setItem("laymax-theme", theme); } catch (e) {}
  }
  setTheme(document.documentElement.getAttribute("data-theme") || "light", false);
  themeBtn.addEventListener("click", () =>
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark", true));
  // Follow the system setting until the user picks a theme themselves.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try { saved = localStorage.getItem("laymax-theme"); } catch (err) {}
    if (!saved) setTheme(e.matches ? "dark" : "light", false);
  });

  // ---------- Solari (split-flap) wordmark ----------
  const solari = $("#solari");
  const FLAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const word = solari.dataset.word;
  const tiles = [...word].map((ch, i) =>
    el("span", { class: `solari-tile${i >= +solari.dataset.accentFrom ? " accent" : ""}` }, ch));
  solari.replaceChildren(...tiles);
  let solariRunning = false;

  function runSolari() {
    if (solariRunning || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    solariRunning = true;
    let done = 0;
    tiles.forEach((tile, i) => {
      let flips = 8 + i * 3; // later tiles settle later, like a real board
      const step = () => {
        tile.classList.remove("flip");
        void tile.offsetWidth;
        tile.classList.add("flip");
        tile.textContent = flips > 0 ? FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)] : word[i];
        if (flips-- > 0) setTimeout(step, 65);
        else if (++done === tiles.length) solariRunning = false;
      };
      setTimeout(step, i * 40);
    });
  }
  runSolari();
  solari.closest(".brand").addEventListener("mouseenter", runSolari);

  // ---------- hero rotator ----------
  const ROTATE = [["9 hours", "Istanbul"], ["11 hours", "Singapore"], ["7 hours", "Doha"], ["14 hours", "Tokyo"], ["8 hours", "Amsterdam"], ["10 hours", "Seoul"]];
  let rotIdx = 0;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => {
      if (screens.input.hidden) return;
      rotIdx = (rotIdx + 1) % ROTATE.length;
      const nodes = [$("#rot-hours"), $("#rot-city")];
      nodes.forEach((n) => n.classList.add("out"));
      setTimeout(() => {
        nodes.forEach((n, i) => {
          n.textContent = ROTATE[rotIdx][i];
          n.classList.remove("out");
          n.classList.add("in");
        });
        requestAnimationFrame(() => requestAnimationFrame(() => nodes.forEach((n) => n.classList.remove("in"))));
      }, 350);
    }, 3200);
  }

  // ---------- layover preview ----------
  function updatePreview() {
    const a = form.arrival_local.value, d = form.departure_local.value;
    const out = $("#layover-preview");
    out.classList.remove("bad");
    if (!a || !d) return (out.textContent = "");
    const min = Math.round((new Date(d) - new Date(a)) / 60000);
    if (min <= 0) {
      out.classList.add("bad");
      out.textContent = "Departure must be after arrival.";
    } else {
      out.textContent = `${duration(min)} layover. Let's see how much of it is really yours.`;
    }
  }
  form.arrival_local.addEventListener("input", updatePreview);
  form.departure_local.addEventListener("input", updatePreview);

  // ---------- passport combobox ----------
  const pInput = $("#passport"), pList = $("#passport-list"), pFlag = $("#passport-flag");
  let pMatches = [], pActive = -1;

  function countryByName(name) {
    const q = (name || "").trim().toLowerCase();
    return COUNTRIES.find((c) => c.name.toLowerCase() === q);
  }
  function searchCountries(q) {
    q = q.trim().toLowerCase();
    if (!q) return COUNTRIES;
    const starts = [], contains = [];
    for (const c of COUNTRIES) {
      const name = c.name.toLowerCase();
      const alias = COUNTRY_ALIASES[c.code] || "";
      if (name.startsWith(q) || c.code.toLowerCase() === q) starts.push(c);
      else if (name.includes(q) || alias.includes(q)) contains.push(c);
    }
    return starts.concat(contains);
  }
  function renderCountryList() {
    pList.replaceChildren(
      ...(pMatches.length
        ? pMatches.map((c, i) =>
            el("li", { role: "option", id: `opt-${c.code}`, "data-i": i, "aria-selected": String(i === pActive) },
              el("span", { class: "f", "aria-hidden": "true" }, c.flag), c.name))
        : [el("li", { class: "empty" }, "No match. You can still type any country.")])
    );
    if (pActive >= 0) {
      pInput.setAttribute("aria-activedescendant", `opt-${pMatches[pActive].code}`);
      pList.children[pActive].scrollIntoView({ block: "nearest" });
    } else {
      pInput.removeAttribute("aria-activedescendant");
    }
  }
  function openCountries(all = false) {
    pMatches = searchCountries(all ? "" : pInput.value);
    pActive = -1;
    renderCountryList();
    pList.hidden = false;
    pInput.setAttribute("aria-expanded", "true");
  }
  function closeCountries() {
    pList.hidden = true;
    pInput.setAttribute("aria-expanded", "false");
    pInput.removeAttribute("aria-activedescendant");
  }
  function pickCountry(c) {
    pInput.value = c.name;
    pFlag.textContent = c.flag;
    closeCountries();
  }
  function syncFlag() {
    const c = countryByName(pInput.value);
    pFlag.textContent = c ? c.flag : "";
  }
  pInput.addEventListener("input", () => { syncFlag(); openCountries(); });
  pInput.addEventListener("focus", () => openCountries(!countryByName(pInput.value) ? false : true));
  pInput.addEventListener("blur", closeCountries);
  pInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (pList.hidden) openCountries();
      if (!pMatches.length) return;
      pActive = e.key === "ArrowDown" ? (pActive + 1) % pMatches.length : (pActive - 1 + pMatches.length) % pMatches.length;
      renderCountryList();
    } else if (e.key === "Enter" && !pList.hidden && pActive >= 0) {
      e.preventDefault();
      pickCountry(pMatches[pActive]);
    } else if (e.key === "Escape") {
      closeCountries();
    }
  });
  pList.addEventListener("mousedown", (e) => e.preventDefault());
  pList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) pickCountry(pMatches[+li.dataset.i]);
  });
  const pToggle = $("#passport-combo .combo-toggle");
  pToggle.addEventListener("mousedown", (e) => e.preventDefault());
  pToggle.addEventListener("click", () => {
    if (!pList.hidden) return closeCountries();
    pInput.focus();
    openCountries(true);
  });

  // ---------- visited before ----------
  function syncVisited() {
    const yes = form.querySelector('input[name="visited"]:checked').value === "yes";
    $("#seen-field").hidden = !yes;
  }
  form.querySelectorAll('input[name="visited"]').forEach((r) => r.addEventListener("change", syncVisited));

  // ---------- budget ----------
  function syncBudget() {
    const amount = parseFloat(form.budget_amount.value);
    const cur = form.budget_currency.value;
    const hint = $("#budget-hint");
    if (!(amount > 0)) return (hint.textContent = "");
    const usd = amount * (USD_PER[cur] || 1);
    const tier = usd < 40 ? "shoestring" : usd <= 120 ? "moderate" : "splurge";
    form.querySelector(`input[name="budget"][value="${tier}"]`).checked = true;
    hint.textContent = `${cur === "USD" ? "" : `About $${Math.round(usd)}. `}We'll keep the whole plan under ${cur} ${amount.toLocaleString()}.`;
  }
  form.budget_amount.addEventListener("input", syncBudget);
  form.budget_currency.addEventListener("change", syncBudget);

  // ---------- read / fill form ----------
  function readForm() {
    const fd = new FormData(form);
    const visited = fd.get("visited") === "yes";
    return {
      airport: fd.get("airport"),
      arrival_local: fd.get("arrival_local"),
      departure_local: fd.get("departure_local"),
      passport: fd.get("passport"),
      visa_status: fd.get("visa_status"),
      mobility: fd.get("mobility"),
      bags_checked_through: form.bags_checked_through.checked,
      terminal_change: form.terminal_change.checked,
      visited_before: visited,
      already_seen: visited ? fd.get("already_seen") : "",
      interests: fd.getAll("interests"),
      budget: fd.get("budget"),
      budget_amount: fd.get("budget_amount") || null,
      budget_currency: fd.get("budget_currency"),
      pace: fd.get("pace"),
      risk_tolerance: fd.get("risk_tolerance"),
      notes: fd.get("notes"),
      demo_sample: demoSample || undefined,
    };
  }

  function fillTrip(t) {
    const blank = (v) => !v || v === "not specified" || v === "no limitations";
    for (const name of ["airport", "arrival_local", "departure_local", "passport", "visa_status", "mobility", "notes", "already_seen"]) {
      form[name].value = blank(t[name]) ? (name === "visa_status" ? "unsure" : "") : t[name];
    }
    form.budget_amount.value = t.budget_amount || "";
    form.budget_currency.value = t.budget_currency || "USD";
    form.bags_checked_through.checked = t.bags_checked_through !== false;
    form.terminal_change.checked = !!t.terminal_change;
    form.querySelector(`input[name="visited"][value="${t.visited_before ? "yes" : "no"}"]`).checked = true;
    for (const name of ["budget", "pace", "risk_tolerance"]) {
      const radio = form.querySelector(`input[name="${name}"][value="${t[name]}"]`);
      if (radio) radio.checked = true;
    }
    form.querySelectorAll('input[name="interests"]').forEach((c) => (c.checked = (t.interests || []).includes(c.value)));
    syncFlag();
    syncVisited();
    syncBudget();
    updatePreview();
  }

  $("#example-btn").addEventListener("click", () => {
    if (isMock) {
      fillTrip({ airport: "DOH", arrival_local: "2026-11-03T07:10", departure_local: "2026-11-03T16:40", passport: "United Kingdom",
        visa_status: "not_needed", interests: ["local food", "culture and history"], budget: "moderate", pace: "balanced", risk_tolerance: "balanced" });
      return;
    }
    const day = new Date(); day.setDate(day.getDate() + 7); day.setHours(8, 25, 0, 0);
    const dep = new Date(day); dep.setHours(19, 5);
    fillTrip({ airport: "IST (Istanbul Airport)", arrival_local: toLocalInput(day), departure_local: toLocalInput(dep), passport: "United States",
      visa_status: "unsure", interests: ["local food", "culture and history", "markets and shopping"], budget: "moderate", pace: "balanced", risk_tolerance: "balanced" });
  });

  // ---------- submit ----------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#form-error");
    err.hidden = true;
    const data = readForm();
    const problem =
      !data.airport.trim() ? "Please enter your layover airport." :
      !data.arrival_local || !data.departure_local ? "Please enter both your arrival and departure times." :
      new Date(data.departure_local) <= new Date(data.arrival_local) ? "Departure must be after arrival." : "";
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      err.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    demoSample = null;
    show("loading");
    startLoadingSteps();
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({ error: "The server sent an unexpected response." }));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
      lastResult = body;
      show("output");
      render(body);
    } catch (ex) {
      err.textContent = ex.message || "Something went wrong. Please try again.";
      err.hidden = false;
      show("input");
    } finally {
      clearInterval(loadingTimer);
    }
  });

  function startLoadingSteps() {
    const steps = [...document.querySelectorAll("#loading-steps li")];
    const started = Date.now();
    let i = 0;
    steps.forEach((s) => (s.className = ""));
    steps[0].className = "active";
    $("#elapsed").textContent = "0";
    clearInterval(loadingTimer);
    loadingTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      $("#elapsed").textContent = sec;
      const target = Math.min(steps.length - 1, Math.floor(sec / 8));
      while (i < target) {
        steps[i].className = "done";
        steps[++i].className = "active";
      }
    }, 250);
  }

  // ---------- output ----------
  function flaps(text, rowIdx) {
    return el("div", { class: "flaps", "aria-label": text },
      ...[...text].map((ch, i) =>
        el("span", { class: ch === ":" ? "flap sep" : "flap", style: `animation-delay:${rowIdx * 140 + i * 55}ms`, "aria-hidden": "true" }, ch)));
  }

  function render(r) {
    const m = r.math, tb = r.time_budget, trip = r.trip, base = trip.arrival_local;
    const blocked = !r.entry_requirements.can_exit_airport;
    const noTime = r.verdict === "NO_GO" && !blocked;
    const v = VERDICT_TEXT[r.verdict];

    // boarding pass
    const pass = $("#pass");
    pass.className = `pass ${r.verdict}`;
    restartAnimation(pass);
    $("#pass-date").textContent = new Date(base).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    $("#pass-from").textContent = hhmm(base);
    $("#pass-to").textContent = hhmm(trip.departure_local);
    const depOff = dayOffset(trip.departure_local, base);
    if (depOff) $("#pass-to").append(el("small", {}, depOff));
    $("#pass-city").textContent = r.city.split(",")[0];
    $("#pass-airport").textContent = `${r.airport_name} · ${r.city}`;
    $("#verdict-reason").textContent = r.verdict_reason;
    $("#f-layover").textContent = duration(m.layover_min);
    $("#f-usable").textContent = blocked ? "Not allowed" : m.usable_city_min > 0 ? duration(m.usable_city_min) : "None";
    const country = countryByName(trip.passport);
    $("#f-passport").textContent = country ? `${country.flag} ${country.name}` : trip.passport;
    $("#f-spend").textContent = r.estimated_total_spend || "";
    $("#f-spend-wrap").hidden = !r.estimated_total_spend;
    const stamp = $("#stamp");
    stamp.textContent = v.stamp;
    restartAnimation(stamp);
    $("#verdict-title").textContent = v.title;

    // departures board
    const rows = blocked
      ? [
          { t: base, what: "You land", status: "Arrived" },
          { t: null, what: "Entry to the country", status: "Not allowed", cls: "bad" },
          { t: m.at_gate_by, what: "At the gate by", status: "Boarding" },
        ]
      : [
          { t: m.exit_airport_at, what: "Out of the airport", status: "Immigration", cls: noTime ? "dim" : "" },
          { t: m.arrive_city_at, what: "Arrive in the city", status: "City time", cls: noTime ? "dim" : "" },
          { t: m.leave_city_by, what: "Leave the city by", status: noTime ? "Not enough time" : "Hard deadline", cls: noTime ? "dim bad" : "deadline" },
          { t: m.at_gate_by, what: "At the gate by", status: "Boarding" },
        ];
    $("#board-rows").replaceChildren(
      ...rows.map((row, i) => {
        const off = row.t ? dayOffset(row.t, base) : "";
        return el("div", { class: `board-row ${row.cls || ""}` },
          flaps(row.t ? hhmm(row.t) : "--:--", i),
          el("span", { class: "what" }, row.what, off ? el("small", {}, ` · ${off}`) : null),
          el("span", { class: "status" }, row.status));
      })
    );

    // time budget bar
    $("#layover-total").textContent = `${duration(m.layover_min)} layover`;
    const usable = $("#usable");
    usable.className = "usable" + (blocked || m.usable_city_min < 60 ? " none" : m.usable_city_min < 150 ? " low" : "");
    usable.textContent = blocked ? "Entry not allowed: airside only"
      : m.usable_city_min > 0 ? `${duration(m.usable_city_min)} usable in the city` : "No usable city time";
    const boarding = m.segments.find((s) => s.key === "boarding");
    const segs = (blocked
      ? [{ key: "airside", label: "Airside free time", min: m.layover_min - boarding.min }, boarding]
      : m.segments
    ).filter((s) => s.min > 0);
    const total = segs.reduce((a, s) => a + s.min, 0);
    const bar = $("#budget-bar");
    bar.replaceChildren(...segs.map((s) => el("div", { class: `seg-${s.key}`, style: `flex:${s.min / total}`, title: `${s.label}: ${duration(s.min)}` })));
    bar.setAttribute("aria-label", segs.map((s) => `${s.label} ${duration(s.min)}`).join(", "));
    restartAnimation(bar);
    $("#budget-legend").replaceChildren(
      ...segs.map((s) => el("li", {}, el("i", { class: `seg-${s.key}` }), `${s.label} `, el("b", {}, duration(s.min))))
    );

    // timeline
    const stops = r.itinerary;
    $("#timeline").replaceChildren(
      ...stops.map((s, i) => {
        const isFinal = !blocked && !noTime && i === stops.length - 1 && s.type === "transit";
        const off = dayOffset(s.start, base);
        const shortCost = s.cost_estimate && s.cost_estimate.length <= SHORT_COST;
        return el("li", { class: `stop ${s.type}${isFinal ? " final" : ""}`, style: `animation-delay:${200 + i * 70}ms` },
          el("div", { class: "stop-time" }, hhmm(s.start), el("small", {}, `to ${hhmm(s.end)}`), off ? el("small", {}, off) : null),
          el("div", { class: "stop-dot", "aria-hidden": "true" }),
          el("div", { class: "stop-body" },
            el("div", { class: "stop-head" },
              el("div", {},
                el("span", { class: "tag" }, isFinal ? "Hard deadline" : STOP_LABEL[s.type] || s.type),
                el("h4", {}, s.title)),
              shortCost ? el("span", { class: "cost" }, s.cost_estimate) : null),
            el("div", { class: "stop-meta" }, s.location),
            el("p", {}, s.description),
            s.cost_estimate && !shortCost ? el("div", { class: "stop-note" }, el("b", {}, "Cost: "), s.cost_estimate) : null,
            s.tip ? el("div", { class: "stop-note" }, el("b", {}, "Tip: "), s.tip) : null
          )
        );
      })
    );

    // side cards
    const [entryLabel, entryClass] = ENTRY_TEXT[r.entry_requirements.status] || ["Entry rules", ""];
    $("#entry-status").className = `pill ${blocked ? "bad" : entryClass}`;
    $("#entry-status").textContent = blocked ? `${entryLabel}: you can't leave the airport` : entryLabel;
    $("#entry-summary").textContent = r.entry_requirements.summary;
    $("#transit-card").hidden = blocked;
    $("#transit-mode").textContent = tb.transit_mode;
    $("#transit-cost").textContent = `${tb.transit_cost_estimate} · about ${tb.transit_to_city_min} min in, ${tb.transit_back_min} min back`;
    fill("#late-list", r.running_late_plan);
    fill("#tips-list", r.practical_tips);
    fill("#fallback-list", r.airport_fallback);
    fill("#assumptions-list", [
      ...(tb.deadline_math ? [`Deadline: ${tb.deadline_math}.`] : []),
      ...tb.assumptions,
      `Deplane and immigration: ${tb.deplane_and_immigration_min} min. Security and exit immigration: ${tb.reentry_security_min} min.`,
      `Your safety margin: ${m.safety_margin_min} min, added on top of every estimate.`,
    ]);
    const q = r.quality_check;
    const secs = q.stage_seconds;
    $("#quality-note").textContent =
      (secs ? `Two-step check: Claude estimated the times (${Math.round(secs.time_check)}s), the server did the math, then Claude built the plan (${Math.round(secs.plan)}s). ` : "Every time was recomputed on the server. ") +
      (q.refinement_rounds ? `The first draft had ${q.issues_found[0].length} timing issue(s), so Claude revised it. ` : "The first draft passed all timing checks. ") +
      (q.remaining_issues.length ? `Still flagged: ${q.remaining_issues.join(" ")}` : "");
  }

  // ---------- demo mode: replay saved real plans from demo_samples/ ----------
  if (isMock) {
    const bar = $("#demo-buttons");
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sample]");
      if (!btn) return;
      if (btn.dataset.sample) fillTrip(JSON.parse(btn.dataset.trip));
      else $("#example-btn").click();
      demoSample = btn.dataset.sample || null;
      form.requestSubmit();
    });
    fetch("/api/demo-samples").then((r) => r.json()).then((list) => {
      for (const s of list) {
        bar.append(el("button", { type: "button", class: "btn ghost small", "data-sample": s.id, "data-trip": JSON.stringify(s.trip) }, s.label));
      }
      // /?autoplay=1 replays Doha; /?autoplay=<sample id> replays that saved plan.
      const auto = new URLSearchParams(location.search).get("autoplay");
      if (auto !== null) (bar.querySelector(`[data-sample="${CSS.escape(auto)}"]`) || bar.querySelector('[data-sample=""]')).click();
    });
  }

  // ---------- toolbar ----------
  $("#back-btn").addEventListener("click", () => show("input"));
  $("#print-btn").addEventListener("click", () => window.print());
  $("#json-btn").addEventListener("click", () => {
    if (!lastResult) return;
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "laymax-plan.json" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
