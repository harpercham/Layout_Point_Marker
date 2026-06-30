(() => {
  "use strict";

  const PDFJS_VERSION = "3.11.174";
  const CORE_READY_DAYS = 28;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

  const els = {
    pdfInput: document.querySelector("#pdfInput"),
    csvInput: document.querySelector("#csvInput"),
    pdfMeta: document.querySelector("#pdfMeta"),
    zoomRange: document.querySelector("#zoomRange"),
    zoomValue: document.querySelector("#zoomValue"),
    ghUrl: document.querySelector("#ghUrl"),
    thUrl: document.querySelector("#thUrl"),
    tkgUrl: document.querySelector("#tkgUrl"),
    etUrl: document.querySelector("#etUrl"),
    sheetName: document.querySelector("#sheetName"),
    stInput: document.querySelector("#stInput"),
    loadBtn: document.querySelector("#loadBtn"),
    clearBtn: document.querySelector("#clearBtn"),
    clearMappingBtn: document.querySelector("#clearMappingBtn"),
    printBtn: document.querySelector("#printBtn"),
    status: document.querySelector("#status"),
    completedCount: document.querySelector("#completedCount"),
    readyCount: document.querySelector("#readyCount"),
    totalMgCount: document.querySelector("#totalMgCount"),
    matchedCount: document.querySelector("#matchedCount"),
    manualCount: document.querySelector("#manualCount"),
    unmatchedCount: document.querySelector("#unmatchedCount"),
    unmatchedBadge: document.querySelector("#unmatchedBadge"),
    unmatchedList: document.querySelector("#unmatchedList"),
    manualInstruction: document.querySelector("#manualInstruction"),
    emptyViewer: document.querySelector("#emptyViewer"),
    pdfViewer: document.querySelector("#pdfViewer"),
    toast: document.querySelector("#toast"),
  };

  const state = {
    pdfDoc: null,
    pdfFile: null,
    pdfKey: "",
    scale: 1.25,
    pages: [],
    textIndex: new Map(),
    completed: new Map(),
    totalMg: 0,
    placements: new Map(),
    unmatched: [],
    pendingManual: null,
    csvFiles: [],
    renderToken: 0,
  };

  restoreConfig();
  updateMetrics();

  els.pdfInput.addEventListener("change", handlePdfUpload);
  els.csvInput.addEventListener("change", (event) => {
    state.csvFiles = [...event.target.files];
    toast(`${state.csvFiles.length} CSV file(s) selected.`);
  });
  els.zoomRange.addEventListener("input", debounce(async () => {
    state.scale = Number(els.zoomRange.value);
    els.zoomValue.value = `${Math.round(state.scale * 100)}%`;
    if (state.pdfDoc) await renderPdf();
  }, 180));
  els.loadBtn.addEventListener("click", loadAndMark);
  els.clearBtn.addEventListener("click", clearMarks);
  els.clearMappingBtn.addEventListener("click", clearManualMappings);
  els.printBtn.addEventListener("click", () => window.print());

  ["ghUrl", "thUrl", "tkgUrl", "etUrl", "sheetName", "stInput"].forEach((id) => {
    els[id].addEventListener("change", saveConfig);
  });

  async function handlePdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    setStatus("loading", "Loading PDF and extracting point labels…");
    state.pdfFile = file;
    state.pdfKey = `${file.name}|${file.size}|${file.lastModified}`;
    state.placements = loadPlacements();

    try {
      const bytes = await file.arrayBuffer();
      state.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
      els.pdfMeta.textContent = `${file.name} • ${state.pdfDoc.numPages} page(s) • ${formatBytes(file.size)}`;
      els.zoomRange.disabled = false;
      els.printBtn.disabled = false;
      els.clearMappingBtn.disabled = false;
      els.emptyViewer.classList.add("hidden");
      await renderPdf();
      setStatus("success", `PDF ready. ${countIndexEntries()} searchable text candidates extracted.`);
    } catch (error) {
      console.error(error);
      state.pdfDoc = null;
      setStatus("error", `Unable to open PDF: ${error.message}`);
    }
  }

  async function renderPdf() {
    if (!state.pdfDoc) return;
    const token = ++state.renderToken;
    state.pages = [];
    state.textIndex = new Map();
    els.pdfViewer.replaceChildren();

    for (let pageNumber = 1; pageNumber <= state.pdfDoc.numPages; pageNumber += 1) {
      if (token !== state.renderToken) return;

      const page = await state.pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: state.scale });

      const card = document.createElement("section");
      card.className = "page-card";
      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `Page ${pageNumber} of ${state.pdfDoc.numPages}`;

      const stage = document.createElement("div");
      stage.className = "page-stage";
      stage.dataset.page = String(pageNumber);
      stage.style.width = `${viewport.width}px`;
      stage.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const markerLayer = document.createElement("div");
      markerLayer.className = "marker-layer";

      stage.append(canvas, markerLayer);
      card.append(label, stage);
      els.pdfViewer.append(card);

      const ctx = canvas.getContext("2d", { alpha: false });
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      }).promise;

      const textContent = await page.getTextContent();
      const items = textContent.items
        .filter((item) => item.str && item.str.trim())
        .map((item) => textItemToPosition(item, viewport, pageNumber));

      const candidates = buildCandidates(items);
      addCandidatesToIndex(candidates);

      stage.addEventListener("click", (event) => placeManualMarker(event, pageNumber, stage));

      state.pages.push({
        pageNumber,
        viewport,
        stage,
        canvas,
        outputScale,
        markerLayer,
        candidates,
        circleCache: new Map(),
      });
    }

    applyMarkers();
  }

  function textItemToPosition(item, viewport, pageNumber) {
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);

    // Build a viewport-space bounding box using the text-direction and font-height vectors.
    // This handles rotated/vertical point labels much better than assuming horizontal text.
    const p0 = { x: tx[4], y: tx[5] };
    const p1 = { x: tx[4] + tx[0] * item.width, y: tx[5] + tx[1] * item.width };
    const p2 = { x: tx[4] + tx[2], y: tx[5] + tx[3] };
    const p3 = { x: p1.x + tx[2], y: p1.y + tx[3] };

    const xs = [p0.x, p1.x, p2.x, p3.x];
    const ys = [p0.y, p1.y, p2.y, p3.y];

    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    const width = Math.max(6, right - left);
    const height = Math.max(6, bottom - top);

    return {
      page: pageNumber,
      raw: item.str.trim(),
      norm: normalizePoint(item.str),
      left,
      top,
      right,
      bottom,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2,
      rotation: Math.atan2(tx[1], tx[0]),
    };
  }

  function buildCandidates(items) {
    const candidates = [...items];

    // Join nearby text items on the same line for labels split into several PDF text objects.
    const lines = [];
    [...items]
      .sort((a, b) => (a.top - b.top) || (a.left - b.left))
      .forEach((item) => {
        let line = lines.find((candidateLine) =>
          Math.abs(candidateLine.top - item.top) <= Math.max(4, item.height * 0.45)
        );
        if (!line) {
          line = { top: item.top, items: [] };
          lines.push(line);
        }
        line.items.push(item);
      });

    for (const line of lines) {
      line.items.sort((a, b) => a.left - b.left);
      for (let start = 0; start < line.items.length; start += 1) {
        let joined = "";
        let left = line.items[start].left;
        let top = line.items[start].top;
        let right = left;
        let bottom = top;
        for (let size = 1; size <= 5 && start + size - 1 < line.items.length; size += 1) {
          const item = line.items[start + size - 1];
          if (size > 1 && item.left - right > Math.max(24, item.height * 2.2)) break;
          joined += item.raw;
          right = Math.max(right, item.left + item.width);
          bottom = Math.max(bottom, item.top + item.height);
          const norm = normalizePoint(joined);
          if (norm.length >= 4) {
            candidates.push({
              page: item.page,
              raw: joined,
              norm,
              left,
              top,
              width: right - left,
              height: bottom - top,
              centerX: left + (right - left) / 2,
              centerY: top + (bottom - top) / 2,
            });
          }
        }
      }
    }
    return candidates;
  }

  function addCandidatesToIndex(candidates) {
    for (const candidate of candidates) {
      if (!candidate.norm) continue;
      if (!state.textIndex.has(candidate.norm)) state.textIndex.set(candidate.norm, []);
      state.textIndex.get(candidate.norm).push(candidate);
    }
  }

  async function loadAndMark() {
    const st = normalizeSt(els.stInput.value);
    if (!st) {
      setStatus("warning", "Enter an ST number, for example ST406.");
      return;
    }
    if (!state.pdfDoc) {
      setStatus("warning", "Upload the working-layout PDF first.");
      return;
    }

    saveConfig();
    setStatus("loading", `Loading completed points for ${st}…`);
    els.loadBtn.disabled = true;

    try {
      const allRecords = [];
      const sources = [
        ["GH", els.ghUrl.value.trim()],
        ["TH", els.thUrl.value.trim()],
        ["TKG", els.tkgUrl.value.trim()],
        ["ET", els.etUrl.value.trim()],
      ].filter(([, url]) => url);

      for (const [subcon, url] of sources) {
        const csvUrl = buildSheetCsvUrl(url, els.sheetName.value.trim() || "Daily Point Update");
        const response = await fetch(csvUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`${subcon} Sheet returned HTTP ${response.status}`);
        const text = await response.text();
        allRecords.push(...extractCompletedRows(parseCsv(text), st, subcon));
      }

      for (const file of state.csvFiles) {
        const text = await file.text();
        const source = file.name.replace(/\.csv$/i, "");
        allRecords.push(...extractCompletedRows(parseCsv(text), st, source));
      }

      if (!sources.length && !state.csvFiles.length) {
        throw new Error("Paste at least one Google Sheet URL or upload a CSV file.");
      }

      state.completed = new Map();
      for (const record of allRecords) {
        const norm = normalizePoint(record.pointRef);
        if (!norm) continue;
        if (!state.completed.has(norm)) {
          state.completed.set(norm, { ...record, details: [record] });
        } else {
          state.completed.get(norm).details.push(record);
        }
      }

      for (const record of state.completed.values()) {
        Object.assign(record, getCompletionStatus(record.details));
        record.mgPoint = getCompletedPointMg(record.details);
      }

      // Accumulate MG m³/point once for each unique completed point.
      state.totalMg = [...state.completed.values()]
        .reduce((sum, record) => sum + record.mgPoint, 0);

      applyMarkers();
      const count = state.completed.size;
      if (!count) {
        setStatus("warning", `No completed point references found for ${st}. Check the ST value, sharing permission and source tab.`);
      } else {
        setStatus("success", `${count} completed point(s) loaded for ${st}. Completed-point MG: ${formatVolume(state.totalMg)} m³.`);
      }
      els.clearBtn.disabled = count === 0;
    } catch (error) {
      console.error(error);
      setStatus("error",
        `${error.message}. For a static page, each Google Sheet must be viewable by link, or use the CSV fallback.`
      );
    } finally {
      els.loadBtn.disabled = false;
    }
  }

  function extractCompletedRows(rows, selectedSt, source) {
    if (!rows.length) return [];
    let headerIndex = -1;
    let indexes = {};

    for (let r = 0; r < Math.min(rows.length, 20); r += 1) {
      const normalizedHeaders = rows[r].map(normalizeHeader);
      const dateIndex = normalizedHeaders.findIndex((h) => h === "DATE");
      const stIndex = normalizedHeaders.findIndex((h) => h === "ST" || h === "STZONE");
      const pointIndex = normalizedHeaders.findIndex((h) => h === "POINTREF" || h === "POINTREFERENCE");
      if (dateIndex >= 0 && stIndex >= 0 && pointIndex >= 0) {
        headerIndex = r;
        indexes = {
          date: dateIndex,
          st: stIndex,
          point: pointIndex,
          rig: normalizedHeaders.findIndex((h) => h === "RIG" || h === "RIGRIGGROUP"),
          type: normalizedHeaders.findIndex((h) => h === "TYPE" || h === "DSMTYPE"),
          designZone: normalizedHeaders.findIndex((h) => h === "DESIGNZONE"),
          subcon: normalizedHeaders.findIndex((h) => h === "SUBCON"),
          mgPoint: normalizedHeaders.findIndex((h) =>
            h === "MGM3POINT" || h === "MGPOINT" ||
            h === "MGPERPOINT" || h === "MGM3PERPOINT"
          ),
        };
        break;
      }
    }

    if (headerIndex < 0) {
      throw new Error(`${source}: could not find Date, ST and Point Ref headers`);
    }

    return rows.slice(headerIndex + 1)
      .filter((row) => {
        const date = cleanCell(row[indexes.date]);
        const st = normalizeSt(row[indexes.st]);
        const point = cleanCell(row[indexes.point]);
        const designZone = indexes.designZone >= 0 ? cleanCell(row[indexes.designZone]) : "";
        return date && point && st === selectedSt &&
          !designZone.toUpperCase().startsWith("INVALID") &&
          designZone.toUpperCase() !== "CHECK MAPPING";
      })
      .map((row) => ({
        pointRef: cleanCell(row[indexes.point]),
        date: cleanCell(row[indexes.date]),
        st: normalizeSt(row[indexes.st]),
        rig: indexes.rig >= 0 ? cleanCell(row[indexes.rig]) : "",
        type: indexes.type >= 0 ? cleanCell(row[indexes.type]) : "",
        mgPoint: indexes.mgPoint >= 0 ? cleanCell(row[indexes.mgPoint]) : "",
        source: indexes.subcon >= 0 ? cleanCell(row[indexes.subcon]) || source : source,
      }));
  }

  function getCompletedPointMg(details) {
    const values = details
      .map((detail) => parseNumber(detail.mgPoint))
      .filter((value) => Number.isFinite(value) && value > 0);

    // The same completed point may appear more than once in the source.
    // Count its MG m³/point only once, using the first valid recorded value.
    return values.length ? values[0] : 0;
  }

  function applyMarkers() {
    for (const page of state.pages) page.markerLayer.replaceChildren();

    const unmatched = [];
    let autoMatched = 0;
    let manualMatched = 0;
    let readyToCore = 0;

    for (const [norm, record] of state.completed.entries()) {
      if (record.readyToCore) readyToCore += 1;

      const manual = state.placements.get(norm);
      if (manual) {
        drawMarker(record, manual.page, manual.x, manual.y, "manual", true);
        manualMatched += 1;
        continue;
      }

      const candidate = findCandidate(norm);
      if (candidate) {
        const page = state.pages.find((p) => p.pageNumber === candidate.page);
        if (page) {
          const anchor = resolveBelowPointAnchor(candidate);
          drawMarker(
            record,
            candidate.page,
            anchor.x / page.viewport.width,
            anchor.y / page.viewport.height,
            "auto",
            false,
            anchor.badgeSize
          );
          autoMatched += 1;
          continue;
        }
      }
      unmatched.push({ norm, record });
    }

    state.unmatched = unmatched;
    renderUnmatchedList();
    updateMetrics(autoMatched, manualMatched, unmatched.length, readyToCore);
  }

  function findCandidate(pointNorm) {
    const exact = state.textIndex.get(pointNorm);
    if (exact?.length) return chooseBestCandidate(exact);

    // Controlled fallback for punctuation or a small amount of adjacent PDF text.
    if (pointNorm.length >= 6) {
      const alternatives = [];
      for (const [candidateNorm, positions] of state.textIndex.entries()) {
        const diff = Math.abs(candidateNorm.length - pointNorm.length);
        if (diff <= 3 && (candidateNorm.includes(pointNorm) || pointNorm.includes(candidateNorm))) {
          alternatives.push(...positions);
        }
      }
      if (alternatives.length) return chooseBestCandidate(alternatives);
    }
    return null;
  }

  function chooseBestCandidate(candidates) {
    // Prefer a compact text box rather than a title/legend string.
    return [...candidates].sort((a, b) =>
      (a.width * a.height) - (b.width * b.height) || a.page - b.page
    )[0];
  }

  function resolveBelowPointAnchor(candidate) {
    const badgeSize = Math.max(24, Math.min(32, Math.max(candidate.width, candidate.height) * 0.9));
    const gap = Math.max(3, Math.min(10, candidate.height * 0.35));

    return {
      x: candidate.left + candidate.width / 2,
      // Place the badge just below the full point-number bounding box.
      y: (candidate.bottom ?? (candidate.top + candidate.height)) + gap + badgeSize / 2,
      badgeSize,
    };
  }

  function resolveCircleAnchor(page, candidate) {
    const key = [
      candidate.centerX.toFixed(1),
      candidate.centerY.toFixed(1),
      candidate.width.toFixed(1),
      candidate.height.toFixed(1),
    ].join("|");

    if (page.circleCache?.has(key)) return page.circleCache.get(key);

    const detected = detectCircleNearCandidate(page, candidate);
    const fallbackRadius = Math.max(15, Math.min(24, candidate.height * 2.2));
    const result = detected || {
      x: candidate.centerX,
      y: candidate.centerY,
      radius: fallbackRadius,
      detected: false,
    };

    page.circleCache?.set(key, result);
    return result;
  }

  function detectCircleNearCandidate(page, candidate) {
    const canvas = page.canvas;
    if (!canvas) return null;

    const outputScale = page.outputScale || 1;
    const searchDistance = Math.max(32, Math.min(62, candidate.height * 5.5));
    const margin = searchDistance + 50;

    const x0Css = Math.max(0, Math.floor(candidate.centerX - margin));
    const y0Css = Math.max(0, Math.floor(candidate.centerY - margin));
    const x1Css = Math.min(page.viewport.width, Math.ceil(candidate.centerX + margin));
    const y1Css = Math.min(page.viewport.height, Math.ceil(candidate.centerY + margin));

    const x0 = Math.floor(x0Css * outputScale);
    const y0 = Math.floor(y0Css * outputScale);
    const width = Math.max(1, Math.floor((x1Css - x0Css) * outputScale));
    const height = Math.max(1, Math.floor((y1Css - y0Css) * outputScale));

    let imageData;
    try {
      imageData = canvas.getContext("2d").getImageData(x0, y0, width, height);
    } catch (error) {
      console.warn("Circle detection unavailable:", error);
      return null;
    }

    const pixels = imageData.data;
    const patchWidth = imageData.width;
    const patchHeight = imageData.height;

    function isDark(cssX, cssY) {
      const px = Math.round((cssX - x0Css) * outputScale);
      const py = Math.round((cssY - y0Css) * outputScale);
      if (px < 0 || py < 0 || px >= patchWidth || py >= patchHeight) return false;
      const offset = (py * patchWidth + px) * 4;
      const alpha = pixels[offset + 3];
      if (alpha < 30) return false;
      const luminance =
        pixels[offset] * 0.2126 +
        pixels[offset + 1] * 0.7152 +
        pixels[offset + 2] * 0.0722;
      return luminance < 165;
    }

    const minRadius = Math.max(10, candidate.height * 1.15);
    const maxRadius = Math.min(48, Math.max(25, candidate.height * 4.2));
    const centerStep = 4;
    const radiusStep = 3;
    const angleCount = 28;
    let best = null;

    for (
      let centerY = candidate.centerY - searchDistance;
      centerY <= candidate.centerY + searchDistance;
      centerY += centerStep
    ) {
      for (
        let centerX = candidate.centerX - searchDistance;
        centerX <= candidate.centerX + searchDistance;
        centerX += centerStep
      ) {
        if (
          centerX < x0Css + maxRadius ||
          centerY < y0Css + maxRadius ||
          centerX > x1Css - maxRadius ||
          centerY > y1Css - maxRadius
        ) continue;

        const labelDistance = Math.hypot(
          centerX - candidate.centerX,
          centerY - candidate.centerY
        );

        for (let radius = minRadius; radius <= maxRadius; radius += radiusStep) {
          let ringHits = 0;
          let insideHits = 0;

          for (let angleIndex = 0; angleIndex < angleCount; angleIndex += 1) {
            const angle = angleIndex * Math.PI * 2 / angleCount;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            let ringDark = false;
            for (const radialOffset of [-2, -1, 0, 1, 2]) {
              if (isDark(
                centerX + cos * (radius + radialOffset),
                centerY + sin * (radius + radialOffset)
              )) {
                ringDark = true;
                break;
              }
            }
            if (ringDark) ringHits += 1;

            if (isDark(
              centerX + cos * radius * 0.55,
              centerY + sin * radius * 0.55
            )) insideHits += 1;
          }

          const ringFraction = ringHits / angleCount;
          const insideFraction = insideHits / angleCount;
          const containsLabel = labelDistance <= radius * 0.95;

          const score =
            ringFraction -
            insideFraction * 0.12 -
            (labelDistance / searchDistance) * 0.16 +
            (containsLabel ? 0.14 : 0);

          if (
            ringFraction >= 0.43 &&
            (!best || score > best.score)
          ) {
            best = {
              x: centerX,
              y: centerY,
              radius,
              score,
              detected: true,
            };
          }
        }
      }
    }

    return best;
  }

  function drawMarker(record, pageNumber, xRatio, yRatio, kind, manual, requestedBadgeSize = null) {
    const page = state.pages.find((p) => p.pageNumber === pageNumber);
    if (!page) return;

    const statusClass = record.readyToCore ? "ready" : kind;
    const group = document.createElement("div");
    group.className = `mark-group ${statusClass}`;
    group.style.left = `${xRatio * 100}%`;
    group.style.top = `${yRatio * 100}%`;
    group.dataset.point = record.pointRef;

    const badgeSize = requestedBadgeSize
      ? Math.max(24, Math.min(34, requestedBadgeSize))
      : 30;
    group.style.setProperty("--status-size", `${badgeSize}px`);

    const marker = document.createElement("div");
    marker.className = "marker";
    marker.textContent = "✓";

    const dateLabel = document.createElement("div");
    dateLabel.className = "completion-date";
    dateLabel.textContent = record.completionDate
      ? formatMarkerDate(record.completionDate)
      : compactDateText(record.completionDateLabel || record.date || "Date?");
    group.append(marker, dateLabel);

    const detail = record.details
      .map((d) => `${d.source}${d.rig ? ` / ${d.rig}` : ""}${d.date ? ` / ${d.date}` : ""}`)
      .join("\n");
    const coreStatus = record.readyToCore
      ? `Ready to core — ${record.ageDays} days since completion`
      : (Number.isFinite(record.ageDays)
          ? `${Math.max(0, CORE_READY_DAYS - record.ageDays)} day(s) remaining to 28 days`
          : "Completion date could not be parsed");
    group.title = `${record.pointRef}\nCompletion: ${record.completionDateLabel || record.date || "Unknown"}\n${coreStatus}\n${detail}${manual ? "\nManual mapping" : "\nAutomatic text match"}`;
    page.markerLayer.append(group);
  }

  function renderUnmatchedList() {
    els.unmatchedBadge.textContent = String(state.unmatched.length);
    els.unmatchedList.replaceChildren();

    if (!state.completed.size) {
      els.unmatchedList.className = "point-list empty-state";
      els.unmatchedList.textContent = "No completed points loaded.";
      return;
    }
    if (!state.unmatched.length) {
      els.unmatchedList.className = "point-list empty-state";
      els.unmatchedList.textContent = "All completed points are marked.";
      return;
    }

    els.unmatchedList.className = "point-list";
    for (const item of state.unmatched) {
      const row = document.createElement("div");
      row.className = "point-item";

      const text = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = item.record.pointRef;
      const small = document.createElement("small");
      const coreNote = item.record.readyToCore ? " · Ready to core" : "";
      small.textContent = `${item.record.completionDateLabel || item.record.date || "Date unknown"}${coreNote} · ` +
        item.record.details
          .map((d) => `${d.source}${d.rig ? ` · ${d.rig}` : ""}`)
          .join(", ");
      text.append(strong, small);

      const button = document.createElement("button");
      button.className = "place-btn";
      button.textContent = "Place";
      button.addEventListener("click", () => startManualPlacement(item.norm, item.record.pointRef));

      row.append(text, button);
      els.unmatchedList.append(row);
    }
  }

  function startManualPlacement(norm, pointRef) {
    state.pendingManual = { norm, pointRef };
    els.manualInstruction.textContent = `Click the correct location in the PDF for ${pointRef}. Press Esc to cancel.`;
    els.manualInstruction.classList.remove("hidden");
    toast(`Manual placement active for ${pointRef}.`);
  }

  function placeManualMarker(event, pageNumber, stage) {
    if (!state.pendingManual) return;
    const rect = stage.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    state.placements.set(state.pendingManual.norm, { page: pageNumber, x, y });
    savePlacements();
    const pointRef = state.pendingManual.pointRef;
    state.pendingManual = null;
    els.manualInstruction.classList.add("hidden");
    applyMarkers();
    toast(`${pointRef} mapping saved in this browser.`);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.pendingManual) {
      state.pendingManual = null;
      els.manualInstruction.classList.add("hidden");
      toast("Manual placement cancelled.");
    }
  });

  function clearMarks() {
    state.completed = new Map();
    state.totalMg = 0;
    state.unmatched = [];
    state.pendingManual = null;
    els.manualInstruction.classList.add("hidden");
    applyMarkers();
    setStatus("neutral", "Marks cleared. Google Sheet settings are retained.");
    els.clearBtn.disabled = true;
  }

  function clearManualMappings() {
    if (!state.pdfKey) return;
    if (!confirm("Clear all saved manual point locations for this PDF?")) return;
    state.placements = new Map();
    localStorage.removeItem(`dsm-layout-mappings:${state.pdfKey}`);
    applyMarkers();
    toast("Manual mappings cleared.");
  }

  function updateMetrics(
    autoMatched = 0,
    manualMatched = 0,
    unmatched = state.unmatched.length,
    readyToCore = [...state.completed.values()].filter((record) => record.readyToCore).length
  ) {
    els.completedCount.textContent = String(state.completed.size);
    els.readyCount.textContent = String(readyToCore);
    els.totalMgCount.textContent = formatVolume(state.totalMg);
    els.matchedCount.textContent = String(autoMatched);
    els.manualCount.textContent = String(manualMatched);
    els.unmatchedCount.textContent = String(unmatched);
  }

  function getCompletionStatus(details) {
    const parsed = details
      .map((detail) => parseSheetDate(detail.date))
      .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
      .sort((a, b) => a - b);

    if (!parsed.length) {
      return {
        completionDate: null,
        completionDateLabel: cleanCell(details[0]?.date),
        ageDays: NaN,
        readyToCore: false,
      };
    }

    // Use the earliest recorded completion date if the same point appears more than once.
    const completionDate = parsed[0];
    const today = startOfLocalDay(new Date());
    const ageDays = Math.floor((today - startOfLocalDay(completionDate)) / 86400000);
    return {
      completionDate,
      completionDateLabel: formatDateLabel(completionDate),
      ageDays,
      readyToCore: ageDays >= CORE_READY_DAYS,
    };
  }

  function parseSheetDate(value) {
    const text = cleanCell(value);
    if (!text) return null;

    // YYYY-MM-DD or YYYY/MM/DD
    let match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:\s|$)/);
    if (match) {
      return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    // Numeric dates. Singapore-style DD/MM/YYYY is preferred when ambiguous.
    match = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2}|\d{4})(?:\s|$)/);
    if (match) {
      let first = Number(match[1]);
      let second = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;

      let day;
      let month;
      if (first <= 12 && second > 12) {
        month = first;
        day = second;
      } else {
        day = first;
        month = second;
      }
      return validDate(year, month, day);
    }

    const timestamp = Date.parse(text);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }

  function validDate(year, month, day) {
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day ? date : null;
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function formatMarkerDate(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    return `${day}/${month}/${year}`;
  }

  function compactDateText(value) {
    return String(value || "").replace(/\s+/g, "").slice(0, 8);
  }

  function formatDateLabel(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  }

  function parseNumber(value) {
    const text = cleanCell(value).replace(/,/g, "");
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function formatVolume(value) {
    return Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function buildSheetCsvUrl(input, sheetName) {
    if (/(\.csv)(\?|$)/i.test(input) || /gviz\/tq/i.test(input)) return input;
    const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) ||
      input.match(/^([a-zA-Z0-9_-]{20,})$/);
    if (!match) throw new Error("Invalid Google Sheet URL or spreadsheet ID");
    const id = match[1];
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?` +
      `tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=A3:AD&headers=1`;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') {
          value += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          value += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        row.push(value);
        value = "";
      } else if (char === "\n") {
        row.push(value.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        value = "";
      } else {
        value += char;
      }
    }
    if (value.length || row.length) {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
    }
    return rows;
  }

  function normalizePoint(value) {
    return cleanCell(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function normalizeSt(value) {
    const clean = cleanCell(value).toUpperCase().replace(/\s+/g, "");
    if (!clean) return "";
    const number = clean.replace(/^ST-?/, "");
    return number ? `ST${number}` : "";
  }
  function normalizeHeader(value) {
    return cleanCell(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function cleanCell(value) {
    return value == null ? "" : String(value).trim();
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  function countIndexEntries() {
    let count = 0;
    for (const values of state.textIndex.values()) count += values.length;
    return count.toLocaleString();
  }
  function setStatus(type, message) {
    els.status.className = `status ${type}`;
    els.status.textContent = message;
  }
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }
  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function saveConfig() {
    const config = {
      ghUrl: els.ghUrl.value,
      thUrl: els.thUrl.value,
      tkgUrl: els.tkgUrl.value,
      etUrl: els.etUrl.value,
      sheetName: els.sheetName.value,
      st: els.stInput.value,
    };
    localStorage.setItem("dsm-layout-marker-config", JSON.stringify(config));
  }
  function restoreConfig() {
    try {
      const config = JSON.parse(localStorage.getItem("dsm-layout-marker-config") || "{}");
      els.ghUrl.value = config.ghUrl || "";
      els.thUrl.value = config.thUrl || "";
      els.tkgUrl.value = config.tkgUrl || "";
      els.etUrl.value = config.etUrl || "";
      els.sheetName.value = config.sheetName || "Daily Point Update";
      els.stInput.value = config.st || "";
    } catch {
      // Ignore invalid saved settings.
    }
  }
  function loadPlacements() {
    try {
      const raw = JSON.parse(localStorage.getItem(`dsm-layout-mappings:${state.pdfKey}`) || "{}");
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }
  function savePlacements() {
    localStorage.setItem(
      `dsm-layout-mappings:${state.pdfKey}`,
      JSON.stringify(Object.fromEntries(state.placements))
    );
  }
})();
