let teksData = [];
let selectedTEKS = new Set();

// Cache: videoId -> transcript (cleared when source/link changes)
const ytTranscriptCache = new Map();
let lastYouTubeId = null;

fetch("teks.csv")
  .then(response => response.text())
  .then(data => {
    const rows = data
      .split("\n")
      .slice(1)
      .filter(row => row.trim() !== "");

    teksData = rows.map(row => {
      const [grade, subject, tek, standard] = row
        .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
        .map(s => s.replace(/"/g, '').trim());
      return { grade, subject, tek, standard };
    });

    populateDropdowns();
  });

function populateDropdowns() {
  const gradeSet = new Set();
  const subjectSet = new Set();

  teksData.forEach(entry => {
    gradeSet.add(entry.grade);
    subjectSet.add(entry.subject);
  });

  const gradeSelect = document.getElementById("gradeSelect");
  const subjectSelect = document.getElementById("subjectSelect");

  gradeSelect.innerHTML = `<option value="" disabled selected>Select Grade</option>`;
  subjectSelect.innerHTML = `<option value="" disabled selected>Select Subject</option>`;

  gradeSet.forEach(grade => {
    const option = document.createElement("option");
    option.value = grade;
    option.textContent = grade;
    gradeSelect.appendChild(option);
  });

  gradeSelect.addEventListener("change", () => {
    updateSubjectDropdown();
    displayFilteredTEKS();
  });

  subjectSelect.addEventListener("change", displayFilteredTEKS);
}

function updateSubjectDropdown() {
  const grade = document.getElementById("gradeSelect").value;
  const subjectSelect = document.getElementById("subjectSelect");

  subjectSelect.innerHTML = `<option value="" disabled selected>Select Subject</option>`;
  if (!grade) return;

  const subjectSet = new Set();
  teksData.forEach(entry => {
    if (entry.grade === grade) {
      subjectSet.add(entry.subject);
    }
  });

  subjectSet.forEach(subject => {
    const option = document.createElement("option");
    option.value = subject;
    option.textContent = subject;
    subjectSelect.appendChild(option);
  });
}

function extractGoogleDocId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function fetchGoogleDocText(docId) {
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const response = await fetch(exportUrl);
  if (!response.ok) throw new Error("Failed to fetch Google Doc");
  return await response.text();
}

async function fetchYouTubeTranscript(videoId) {
    const response = await fetch("/api/transcribe-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId })
  });

    const json = await response.json();
  if (!json?.transcript) throw new Error("No transcript returned");
  ytTranscriptCache.set(videoId, json.transcript);
  lastYouTubeId = videoId;
  window.dispatchEvent(new CustomEvent('assessment-preview-ready'));
  return json.transcript;
}

// --- helper: small wait
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// --- helper: retry transcript a few times with backoff
async function fetchYouTubeTranscriptWithRetry(videoId, { retries = 3, delayMs = 1200 } = {}) {
    // fast-path: use cached transcript if present
  if (ytTranscriptCache.has(videoId)) return ytTranscriptCache.get(videoId);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const t = await fetchYouTubeTranscript(videoId);
      if (t && t.trim().length > 40) return t; // require a bit of content
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) await wait(delayMs * (i + 1)); // 1.2s, 2.4s, 3.6s…
  }
  throw new Error(lastErr?.message || "No transcript available for this video.");
}


function extractYouTubeVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function displayFilteredTEKS() {
  const grade = document.getElementById("gradeSelect").value;
  const subject = document.getElementById("subjectSelect").value;
  const resultsDiv = document.getElementById("results");

  resultsDiv.innerHTML = "";
  if (!grade || !subject) return;

  const filtered = teksData.filter(
    entry => entry.grade === grade && entry.subject === subject
  );

  if (filtered.length === 0) {
    resultsDiv.innerHTML = `<p>No results found.</p>`;
    return;
  }

  filtered.forEach(entry => {
    const encoded = encodeURIComponent(JSON.stringify(entry));
    const div = document.createElement("div");
    div.classList.add("result");
    div.innerHTML = `
      <strong>${entry.tek}</strong> ${entry.standard}
      <button class="selectBtn" data-tek="${encoded}">Select</button>
    `;
    resultsDiv.appendChild(div);
  });

  attachSelectEvents();
}

const keywordAliases = {
  "wwii": "world war ii",
  "ww2": "world war ii",
  "world war 2": "world war ii",
  "wwi": "world war i",
  "ww1": "world war i",
  "world war 1": "world war i",
  "second world war": "world war ii",
  "fdr": "franklin d. roosevelt",
  "jfk": "john f. kennedy",
  "mlk": "martin luther king",
  "mlk jr": "martin luther king",
  "mlk jr.": "martin luther king"
};

function expandAlias(input) {
  const normalized = input.toLowerCase().trim();
  return keywordAliases[normalized] || normalized;
}

async function runSearch() {
  const grade = document.getElementById("gradeSelect").value;
  const subject = document.getElementById("subjectSelect").value;
  const searchInput = document.getElementById("searchInput").value.trim();
  const resultsDiv = document.getElementById("results");

  resultsDiv.innerHTML = "";
  if (!grade || !subject || !searchInput) return;

  const query = expandAlias(searchInput.toLowerCase());

  // --- dedupe helper
  const dedupeByTek = (arr) => {
    const seen = new Set();
    return arr.filter(e => {
      const k = `${e.grade}|${e.subject}|${e.tek}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // --- render helper
  const render = (items) => {
    resultsDiv.innerHTML = "";
    if (!items.length) {
      resultsDiv.innerHTML = `<p>No results found.</p>`;
      return;
    }
    items.forEach(entry => {
      const encoded = encodeURIComponent(JSON.stringify(entry));
      const div = document.createElement("div");
      div.classList.add("result");
      div.innerHTML = `
        <strong>${entry.tek}</strong> ${entry.standard}
        <button class="selectBtn" data-tek="${encoded}">Select</button>
      `;
      resultsDiv.appendChild(div);
    });
    attachSelectEvents();
  };

  // --- race-guard: invalidate stale async results
  const nonce = (window.__searchNonce = (window.__searchNonce || 0) + 1);
  const isStale = () => nonce !== window.__searchNonce;

  // --- 1) Local keyword hits (instant)
  const keywordHits = teksData.filter(e =>
    e.grade === grade &&
    e.subject === subject &&
    (e.standard.toLowerCase().includes(query) || e.tek.toLowerCase().includes(query))
  );

  if (keywordHits.length) {
    render(keywordHits);
  } else {
    resultsDiv.innerHTML = `<p>Searching…</p>`;
  }

  // --- 2) Smart results (in parallel, merged when ready)
  let smartHits = [];
  try {
      const resp = await fetch("/api/semantic-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, grade, subject }),
    });
    const data = await resp.json();
    smartHits = Array.isArray(data?.results) ? data.results : [];
  } catch (e) {
    console.warn("Smart search error:", e);
  }
  if (isStale()) return; // user changed inputs — abort updating

  const merged = dedupeByTek([...keywordHits, ...smartHits]);
  render(merged);
}

function attachSelectEvents() {
  document.getElementById("results").addEventListener("click", function (e) {
    if (e.target.classList.contains("selectBtn")) {
      const raw = e.target.dataset.tek;
      if (!raw) {
        console.warn("⚠️ Missing data-tek on clicked button:", e.target);
        return;
      }

      let tekData;
      try {
        tekData = JSON.parse(decodeURIComponent(raw));
      } catch (err) {
        console.error("❌ Failed to parse TEK:", raw, err);
        return;
      }

      const grade = document.getElementById("gradeSelect").value;
      const subject = document.getElementById("subjectSelect").value;

      const selectedEntry = teksData.find(
        t => t.tek === tekData.tek && t.grade === grade && t.subject === subject
      ) || tekData;

      if (selectedEntry) {
        selectedTEKS.add(JSON.stringify(selectedEntry));
        renderSelectedTEKS();
      }
    }
  });
}

function renderSelectedTEKS() {
  const selectedDiv = document.getElementById("selectedTEKS");
  const container = document.getElementById("selectedTEKSContainer");
  const clearBtn = document.getElementById("clearSelectedBtn");

  selectedDiv.innerHTML = "";

  if (selectedTEKS.size === 0) {
    container.style.display = "none";
    clearBtn.style.display = "none";
    return;
  }

  container.style.display = "block";
  clearBtn.style.display = "inline-block";

  selectedTEKS.forEach(str => {
    const tekObj = JSON.parse(str);
    const tag = document.createElement("span");
    tag.classList.add("selected-teks-tag");
    tag.innerHTML = `
      ${tekObj.tek}
      <button class="remove-tek" data-tek='${str}'>✕</button>
    `;
    selectedDiv.appendChild(tag);
  });

  document.querySelectorAll(".remove-tek").forEach(button => {
    button.addEventListener("click", function () {
      selectedTEKS.delete(this.dataset.tek);
      renderSelectedTEKS();
    });
  });
}

document.getElementById("searchBtn").addEventListener("click", runSearch);
document.getElementById("searchInput").addEventListener("keypress", function (e) {
  if (e.key === "Enter") runSearch();
});
document.getElementById("resetBtn").addEventListener("click", function () {
  document.getElementById("searchInput").value = "";
  displayFilteredTEKS();
});
document.getElementById("clearSelectedBtn").addEventListener("click", () => {
  selectedTEKS.clear();
  renderSelectedTEKS();
});

function createTryAgainButton({ container, onClick }) {
  const tryAgainBtn = document.createElement("button");
  tryAgainBtn.textContent = "🔁 Try Again";
  tryAgainBtn.classList.add("try-again-btn");
  tryAgainBtn.addEventListener("click", async () => {
    tryAgainBtn.disabled = true;
    tryAgainBtn.textContent = "🔄 Regenerating…";
    await onClick(tryAgainBtn);
  });
  container.appendChild(tryAgainBtn);
}

// ================== Generate Objectives Section ================== //

async function fetchObjectives({ prompt, grade, subject }) {
    const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, grade, subject }),
  });
  return await res.json();
}

function createTryAgainButton({ container, onClick }) {
  const existing = container.querySelector(".try-again-btn");
  if (existing) existing.remove();

  const tryAgainBtn = document.createElement("button");
  tryAgainBtn.textContent = "🔁 Try Again";
  tryAgainBtn.classList.add("try-again-btn");

  tryAgainBtn.addEventListener("click", async () => {
    tryAgainBtn.disabled = true;
    tryAgainBtn.textContent = "🔄 Regenerating…";
    await onClick(tryAgainBtn);
  });

  container.appendChild(tryAgainBtn);
}

// File: script.js  (REPLACE your existing generateObjectivesBtn click handler with this)
document.getElementById("generateObjectivesBtn").addEventListener("click", async function () {
  const modal = document.getElementById("aiModal");
  const responseContainer = document.getElementById("aiResponseContainer");

  // reset previous content
  responseContainer.innerHTML = "";

  // validate input first (avoid flashing loader when we won't fetch)
  if (selectedTEKS.size === 0) {
    responseContainer.textContent = "❌ Please select at least one TEKS.";
    // show the modal so the user sees the message
    modal.classList.remove("hidden");
    modal.style.display = "block";
    return;
  }

  // hide the modal during generation; show loader instead
  modal.classList.add("defer-open"); // CSS: #aiModal.defer-open { display:none !important; }
  let loaderId;
{
  const minShow = window.__isObjectivesRetry ? 1200 : 700;
  window.__isObjectivesRetry = false;
  loaderId = LoaderGuard.start('objectives', {
    main: "Generating Objectives",
    sub: 'Crafting "We will/I will" statements',
    minShowMs: minShow,
  });
}

  try {
    // --- build request payload
    const combinedStandards = Array.from(selectedTEKS)
      .map(str => JSON.parse(str).standard)
      .join(" ");
    const grade = document.getElementById("gradeSelect").value;
    const subject = document.getElementById("subjectSelect").value;

    // --- fetch
    const data = await fetchObjectives({ prompt: combinedStandards, grade, subject });

    // --- basic sanity
    if (!data?.objectives || typeof data.objectives !== "string") {
      throw new Error("No objectives returned from the server.");
    }

    // --- render: split into numbered option blocks
    responseContainer.innerHTML = ""; // ensure clean slate
    const optionBlocks = data.objectives
      .split(/\n(?=\d\)\s+We will)/)
      .map(b => b.trim())
      .filter(Boolean);

    optionBlocks.forEach((rawBlock, i) => {
      // why: keep only the first paragraph section
      let cleanBlock = rawBlock.split(/---|\n\s*\n/)[0].trim();

      const match      = cleanBlock.match(/^(\d+)\)\s*(.*)$/);
      const number     = match ? match[1] : (i + 1);
      const promptText = match ? match[2] : cleanBlock;

      const [weWillRaw = "", iWillRaw = ""] = promptText.split(/\n\s*(?=I will)/);

      const displayWeWill = weWillRaw
        .replace(/^\s*\d+\)\s*We will\s*/i, "")
        .replace(/^\s*We will\s*/i, "")
        .trim();

      const col = document.createElement("div");
      col.classList.add("objective-box");
      col.style.marginBottom = "0.5rem";
      col.innerHTML =
        '<div class="wrapped-objectives">' +
          '<p><span class="objective-number">' + number + ')</span> ' +
            '<strong>We will</strong> ' + displayWeWill +
          '</p>' +
          '<p><strong>I will</strong> ' +
            iWillRaw.replace(/^I will\s*/, "").trim() +
          '</p>' +
        '</div>';

      // inline controls
      const controls = document.createElement("div");
      controls.style.display    = "inline-flex";
      controls.style.alignItems = "center";
      controls.style.gap        = "0.5rem";
      controls.style.marginTop  = "0.5rem";

      const genLPbtn = document.createElement("button");
      genLPbtn.textContent    = "📝 Generate Lesson Plan";
      genLPbtn.classList.add  ("from-objective-btn");
      genLPbtn.dataset.prompt = promptText.trim(); // keep unaltered
      controls.appendChild(genLPbtn);

      const durSelect = document.createElement("select");
      durSelect.classList.add("objective-duration-select");
      ["45", "90"].forEach(val => {
        const opt = document.createElement("option");
        opt.value       = val;
        opt.textContent = val + "-Min";
        durSelect.appendChild(opt);
      });
      controls.appendChild(durSelect);

      col.appendChild(controls);
      responseContainer.appendChild(col);
    });

    // Try Again button
    const tryAgainAllBtn = document.createElement("button");
    tryAgainAllBtn.textContent = "🔁 Try Again";
    tryAgainAllBtn.type = "button";
    tryAgainAllBtn.classList.add("try-again-btn");
    tryAgainAllBtn.style.display = "block";
    tryAgainAllBtn.style.margin  = "1rem 0 0 0";
    responseContainer.appendChild(tryAgainAllBtn);

    tryAgainAllBtn.addEventListener("click", () => {
  tryAgainAllBtn.disabled = true;
  tryAgainAllBtn.textContent = "🔄 Regenerating…";
  window.__isObjectivesRetry = true; // flag for longer loader
  document.getElementById("generateObjectivesBtn").click();
});

    // ✅ content ready → reveal modal & finish loader
modal.classList.remove("defer-open");
modal.classList.remove("hidden");
modal.style.display = "block";

await new Promise((r) => requestAnimationFrame(r)); // ensure paint
await LoaderGuard.finish('objectives', loaderId, { ok: true });


  } catch (err) {
    // show error text and surface modal so user sees it
    console.error("Fetch error:", err);
    responseContainer.textContent = `❌ ${err?.message || "Error generating objectives."}`;
    modal.classList.remove("defer-open");
    modal.classList.remove("hidden");
    modal.style.display = "block";
    await LoaderGuard.finish('objectives', loaderId, { ok: false });
  }
});

// keep your close handler as-is
// document.getElementById("closeModalBtn").addEventListener("click", function () {
//   document.getElementById("aiModal").style.display = "none";
// });


document.getElementById("closeModalBtn").addEventListener("click", function () {
  document.getElementById("aiModal").style.display = "none";
});

// ================== Stand-Alone Generate Lesson Plan Section ================== //

async function fetchLessonPlans({ prompt, grade, subject, duration = "45" }) {
    const res = await fetch("/api/generate-lesson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, grade, subject, duration }),
  });
  return await res.json();
}

document.getElementById("generateLessonPlanBtn").addEventListener("click", async function () {
  const modal = document.getElementById("aiModal");
  const responseContainer = document.getElementById("aiResponseContainer");

  // clear previous content only on first run (not retry) so retry can blur existing
  if (!window.__isLessonRetry) {
    responseContainer.innerHTML = "";
    modal.classList.add("defer-open"); // hide modal completely for first run
  } else {
    // keep content visible, just blur it
    modal.classList.add("modal-blur");
  }

  // loader config (match objectives UX)
  const minShow = window.__isLessonRetry ? 1200 : 700;
  window.__isLessonRetry = false;
  let loaderId = LoaderGuard.start('lesson', {
    main: "Generating Lesson Plan",
    sub: "Building two teacher-ready options",
    minShowMs: minShow,
  });

  function renderLessonContent(content) {
    responseContainer.innerHTML = "";
    const matches = [...content.matchAll(/Lesson Plan Option (\d+):([\s\S]*?)(?=Lesson Plan Option \d+:|$)/g)];
    if (matches.length === 0) {
      const section = document.createElement("div");
      section.classList.add("lesson-section");
      section.textContent = content;
      return responseContainer.appendChild(section);
    }
    matches.forEach(([_, optionNum, bodyText]) => {
      const section = document.createElement("div");
      section.classList.add("lesson-section");
      const h = document.createElement("h3");
      h.textContent = `Lesson Plan Option ${optionNum}`;
      section.appendChild(h);
      const teksLabels = Array.from(selectedTEKS).map(str => JSON.parse(str).tek).filter(Boolean);
      if (teksLabels.length > 0) {
        const teksPara = document.createElement("p");
        teksPara.classList.add("teks-labels");
        teksPara.innerHTML = `<em>Related TEKS: ${teksLabels.join(", ")}</em>`;
        section.appendChild(teksPara);
      }
      bodyText.trim().split(/\n{2,}|(?=• )/).forEach(block => {
        if (/^(?:-|\d+\.\s|•)\s+/.test(block)) {
          const isOrdered = /^\d+\.\s+/.test(block);
          const list = isOrdered ? document.createElement("ol") : document.createElement("ul");
          block.split("\n").forEach(line => {
            if (!line.trim()) return;
            const li = document.createElement("li");
            const raw = line.replace(/^(-|•|\d+\.\s+)/, "").trim();
            li.innerHTML = raw
              .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
              .replace(/\*(.+?)\*/g, "<em>$1</em>");
            list.appendChild(li);
          });
          section.appendChild(list);
        } else if (block.includes("**Formative:**") && block.includes("**Summative:**")) {
          const lines = block.split(/\*\*Summative:\*\*/);
          const formative = document.createElement("p");
          formative.innerHTML = lines[0]
            .replace(/\*\*(.+?)\*\*/g, "$1")
            .replace(/\*(.+?)\*/g, "<em>$1</em>");
          const summative = document.createElement("p");
          summative.innerHTML = "Summative: " + lines[1].trim();
          section.appendChild(formative);
          section.appendChild(summative);
        } else {
          const p = document.createElement("p");
          p.innerHTML = block
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>");
          section.appendChild(p);
        }
      });
      responseContainer.appendChild(section);
    });
  }

  try {
    const combinedStandards = Array.from(selectedTEKS)
      .map(str => JSON.parse(str).standard)
      .join(" ");
    const grade = document.getElementById("gradeSelect").value;
    const subject = document.getElementById("subjectSelect").value;
    const duration = document.getElementById("lessonDurationSelect")?.value || "45";

    const data = await fetchLessonPlans({ prompt: combinedStandards, grade, subject, duration });
    const content = data.lessonPlans || "";

    if (!content.trim()) {
      responseContainer.textContent = "❌ No lesson plans returned.";
      modal.classList.remove("defer-open", "modal-blur");
      modal.style.display = "block";
      await LoaderGuard.finish('lesson', loaderId, { ok: false });
      return;
    }

    renderLessonContent(content);

    createTryAgainButton({
      container: responseContainer,
      onClick: () => {
        window.__isLessonRetry = true; // flag for blur on retry
        document.getElementById("generateLessonPlanBtn").click();
      }
    });

    modal.classList.remove("defer-open", "modal-blur");
    await new Promise(r => requestAnimationFrame(r));
    await LoaderGuard.finish('lesson', loaderId, { ok: true });
    modal.style.display = "block";

  } catch (err) {
    console.error("Lesson plan generation failed:", err);
    responseContainer.textContent = "❌ Error generating lesson plans.";
    modal.classList.remove("defer-open", "modal-blur");
    modal.style.display = "block";
    await LoaderGuard.finish('lesson', loaderId, { ok: false });
  }
});


// ================== Per-Objective Lesson Plan Generation ================== //

document.getElementById("aiResponseContainer").addEventListener("click", async (event) => {
  const btn = event.target.closest(".from-objective-btn");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "⏳ Generating…";

  const objectivesText = btn.dataset.prompt;
  const container = btn.parentNode;
  const duration = container.querySelector(".objective-duration-select").value;
  const grade = document.getElementById("gradeSelect").value;
  const subject = document.getElementById("subjectSelect").value;
  const modal = document.getElementById("aiModal");
  const responseContainer = document.getElementById("aiResponseContainer");

  let loaderId; // loader instance tracking

  // 🔁 Reusable content renderer
  function renderLessonContent(content) {
    responseContainer.innerHTML = "";

    const matches = [...(content || "").matchAll(/Lesson Plan Option (\d+):([\s\S]*?)(?=Lesson Plan Option \d+:|$)/g)];

    if (matches.length === 0) {
      const section = document.createElement("div");
      section.classList.add("lesson-section");
      section.textContent = content || "";
      responseContainer.appendChild(section);
    } else {
      matches.forEach(([_, optionNum, bodyText]) => {
        const section = document.createElement("div");
        section.classList.add("lesson-section");

        const h = document.createElement("h3");
        h.textContent = `Lesson Plan Option ${optionNum}`;
        section.appendChild(h);

        const teksLabels = Array.from(selectedTEKS)
          .map(str => JSON.parse(str).tek)
          .filter(Boolean);
        if (teksLabels.length > 0) {
          const teksPara = document.createElement("p");
          teksPara.classList.add("teks-labels");
          teksPara.innerHTML = `<em>Related TEKS: ${teksLabels.join(", ")}</em>`;
          section.appendChild(teksPara);
        }

        bodyText.trim().split(/\n{2,}|(?=• )/).forEach(block => {
          if (/^(?:-|\d+\.\s|•)\s+/.test(block)) {
            const isOrdered = /^\d+\.\s+/.test(block);
            const list = isOrdered ? document.createElement("ol") : document.createElement("ul");
            block.split("\n").forEach(line => {
              if (!line.trim()) return;
              const li = document.createElement("li");
              const raw = line.replace(/^(-|•|\d+\.\s+)/, "").trim();
              li.innerHTML = raw
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>");
              list.appendChild(li);
            });
            section.appendChild(list);
          } else if (block.includes("**Formative:**") && block.includes("**Summative:**")) {
            const lines = block.split(/\*\*Summative:\*\*/);

            const formative = document.createElement("p");
            formative.innerHTML = lines[0]
              .replace(/\*\*(.+?)\*\*/g, "$1")
              .replace(/\*(.+?)\*/g, "<em>$1</em>");

            const summative = document.createElement("p");
            summative.innerHTML = "Summative: " + lines[1].trim();

            section.appendChild(formative);
            section.appendChild(summative);
          } else {
            const p = document.createElement("p");
            p.innerHTML = block
              .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
              .replace(/\*(.+?)\*/g, "<em>$1</em>");
            section.appendChild(p);
          }
        });

        responseContainer.appendChild(section);
      });
    }

    // ✅ finish loader after paint
    requestAnimationFrame(() => {
      if (loaderId) LoaderGuard.finish("lesson", loaderId, { ok: true });
    });
  }

  // 🔁 Try Again handler
  async function handleTryAgain(btnRef) {
    try {
      btnRef.disabled = true;
      btnRef.textContent = "🔄 Regenerating…";
      window.__isLessonRetry = true;

      loaderId = LoaderGuard.start("lesson", {
        main: "Generating Lesson Plan",
        sub: "Drafting activities & timing",
        minShowMs: window.__isLessonRetry ? 1200 : 700,
      });

      const regenerated = await fetchLessonPlans({
        prompt: objectivesText,
        duration,
        grade,
        subject
      });

      renderLessonContent(regenerated.lessonPlans || "");
      createTryAgainButton({ container: responseContainer, onClick: handleTryAgain });

    } catch (err) {
      console.error("Error regenerating lesson plan:", err);
      responseContainer.textContent = "❌ Error regenerating.";
      await LoaderGuard.finish("lesson", loaderId, { ok: false });
    } finally {
      btnRef.disabled = false;
      btnRef.textContent = "🔁 Try Again";
    }
  }

  function createTryAgainButton({ container, onClick }) {
    const existing = container.querySelector(".try-again-btn");
    if (existing) existing.remove();

    const tryAgainBtn = document.createElement("button");
    tryAgainBtn.textContent = "🔁 Try Again";
    tryAgainBtn.classList.add("try-again-btn");

    tryAgainBtn.addEventListener("click", () => {
      tryAgainBtn.disabled = true;
      tryAgainBtn.textContent = "🔄 Regenerating…";
      onClick(tryAgainBtn);
    });

    container.appendChild(tryAgainBtn);
  }

  // Initial plan generation
  try {
    loaderId = LoaderGuard.start("lesson", {
      main: "Generating Lesson Plan",
      sub: "Drafting activities & timing",
      minShowMs: 700,
    });

    const data = await fetchLessonPlans({ prompt: objectivesText, duration, grade, subject });
    renderLessonContent(data.lessonPlans || "");
    createTryAgainButton({ container: responseContainer, onClick: handleTryAgain });
    modal.style.display = "block";

  } catch (err) {
    console.error("Error generating lesson plan from objective:", err);
    responseContainer.textContent = "❌ Error generating lesson plan.";
    modal.style.display = "block";
    await LoaderGuard.finish("lesson", loaderId, { ok: false });
  } finally {
    btn.disabled = false;
    btn.textContent = "📝 Generate Lesson Plan";
  }
});


let latestAssessmentData = null;

// --- 🔍 FORMAT PARSER + BALANCER --- //
function parseFormattedAssessment(raw) {
  const blocks = raw
    .split(/\n?-{3,}\n?/g)
    .map(b => b.trim())
    .filter(Boolean);

  const parsedQuestions = blocks.map((block) => {
    const typeMatch = block.match(/Type:\s*(.+)/i);
    const questionMatch = block.match(/Question:\s*([\s\S]*?)(?=\n[A-D]\)|\nA\) True|\nExpected Response:|\nCorrect Answer:)/i);
    const correctMatch = block.match(/Correct Answer:\s*([A-D])/i);
    const expectedMatch = block.match(/Expected Response:\s*(.+)/i);

    const typeRaw = typeMatch?.[1]?.toLowerCase().trim() || "";
    const question = questionMatch?.[1]?.trim() || "Untitled Question";

    if (typeRaw.includes("multiple")) {
      const choices = [...block.matchAll(/[A-D]\)\s*(.+)/g)].map(m => m[1].trim());
      return {
        type: "multiple",
        question,
        choices,
        answerIndex: correctMatch ? "ABCD".indexOf(correctMatch[1].toUpperCase()) : null
      };
    }

    if (typeRaw.includes("true")) {
      return {
        type: "truefalse",
        question,
        choices: ["True", "False"],
        answerIndex: correctMatch ? "AB".indexOf(correctMatch[1].toUpperCase()) : null
      };
    }

    if (typeRaw.includes("short")) {
      return {
        type: "short",
        question,
        expectedAnswer: expectedMatch?.[1]?.trim() || ""
      };
    }

    return { type: "unknown", question };
  });

  // ✅ Balance answers for MC
  const mcIndexes = parsedQuestions
    .map((q, i) => (q.type === "multiple" && q.choices.length === 4 ? i : null))
    .filter(i => i !== null);

  const total = mcIndexes.length;
  const counts = [0, 0, 0, 0];
  if (total >= 4) counts[3] = 1;
  for (let i = 0; i < total; i++) counts[i % 4] += 1;

  let answerPool = counts.flatMap((c, i) => Array(c).fill(i));
  for (let i = answerPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answerPool[i], answerPool[j]] = [answerPool[j], answerPool[i]];
  }

  mcIndexes.forEach((qIndex) => {
    if (parsedQuestions[qIndex].answerIndex == null) {
      const ai = answerPool.pop();
      parsedQuestions[qIndex].answerIndex = ai;
      console.log(`🎯 Q${qIndex + 1}: Correct -> ${"ABCD"[ai]}`);
    }
  });

  return parsedQuestions;
}

// 👇 This comes FIRST because it's used in preview
function parseFormattedAssessment(raw) {
  const blocks = raw
    .split(/\n?-{3,}\n?/g)
    .map(b => b.trim())
    .filter(Boolean);

  const parsedQuestions = blocks.map((block) => {
    const typeMatch = block.match(/Type:\s*(.+)/i);
    const questionMatch = block.match(/Question:\s*([\s\S]*?)(?=\n[A-D]\)|\nA\) True|\nExpected Response:|\nCorrect Answer:)/i);
    const correctMatch = block.match(/Correct Answer:\s*([A-D])/i);
    const expectedMatch = block.match(/Expected Response:\s*(.+)/i);

    const typeRaw = typeMatch?.[1]?.toLowerCase().trim() || "";
    const question = questionMatch?.[1]?.trim() || "Untitled Question";

    if (typeRaw.includes("multiple")) {
      const choices = [...block.matchAll(/[A-D]\)\s*(.+)/g)].map(m => m[1].trim());

      return {
        type: "multiple",
        question,
        choices,
        answerIndex: correctMatch ? "ABCD".indexOf(correctMatch[1].toUpperCase()) : null
      };
    }

    if (typeRaw.includes("true")) {
      return {
        type: "truefalse",
        question,
        choices: ["True", "False"],
        answerIndex: correctMatch ? "AB".indexOf(correctMatch[1].toUpperCase()) : null
      };
    }

    if (typeRaw.includes("short")) {
      return {
        type: "short",
        question,
        expectedAnswer: expectedMatch?.[1]?.trim() || ""
      };
    }

    return { type: "unknown", question };
  });

  return parsedQuestions;
}

async function generateAssessmentPreview() {
  console.log("🔁 generateAssessmentPreview called");

  const type = document.getElementById("assessmentTypeSelect").value;
  const isPrompt = (type === "essay" || type === "quickwrite");
  const count = parseInt(document.getElementById("questionCount")?.value || 0);
  const formats = Array.from(document.querySelectorAll('input[name="questionFormat"]:checked')).map(c => c.value);
  const elaMode = document.getElementById("elaModeToggle")?.checked;
  console.log(`🧠 Assessment pathway: ${elaMode ? "ELA Mode" : "Standard Mode"}`);
  const previewTextDiv = document.getElementById("assessmentPreviewText");
  const previewModal = document.getElementById("assessmentPreviewModal");
  const confirmBtn = document.getElementById("confirmCreateAssessmentBtn");
  let grade = document.getElementById("gradeSelect").value;
  let subject = document.getElementById("subjectSelect").value;
  const essayStyle = document.getElementById("essayStyleSelect")?.value || null;

  const sourceType = document.getElementById("sourceTypeSelect").value;
  const files = document.getElementById("assessmentFiles")?.files;
  const googleDocLink = document.getElementById("googleDocLink")?.value?.trim();
  const youtubeLink = document.getElementById("youtubeLink")?.value?.trim();

  let source = { type: sourceType, content: null };

  // 🟢 START LOADER IMMEDIATELY (before any source fetching)
  previewTextDiv.textContent = "";
  document.getElementById("assessmentModal")?.classList.add("hidden");
  confirmBtn.classList.add("hidden");

    // keep the preview shell fully hidden while regenerating
  previewModal.classList.add("defer-open");
  previewModal.classList.add("hidden");
  previewModal.classList.remove("active");

  // ensure the preview stays hidden; wireGeneratingStates will reveal when ready
  previewModal?.classList.add("defer-open");

  const minShow = window.__isAssessmentRetry ? 1200 : 700;
  window.__isAssessmentRetry = false;
  let loaderId = LoaderGuard.start('assessment', {
    main: isPrompt ? "Generating Prompt" : "Generating Assessment",
    sub:  isPrompt ? "Composing prompt text" : "Building question set",
    minShowMs: minShow,
  });

  // ── Gather source content ──
  if (sourceType === "teks") {
    if (selectedTEKS.size === 0) {
      previewTextDiv.textContent = "❌ Please select at least one TEKS before generating.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    source.content = Array.from(selectedTEKS).map(t => JSON.parse(t).standard).join("\n");

  } else if (sourceType === "upload") {
    if (!files || files.length === 0) {
      previewTextDiv.textContent = "❌ No files uploaded.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    try {
      const formData = new FormData();
      formData.append("file", files[0]);
      const uploadRes = await fetch("/api/upload-file-preview", { 
        method: "POST", 
        body: formData 
     });
      const uploadJson = await uploadRes.json();
      if (!uploadJson?.content) throw new Error("No content returned from file upload.");
      source.content = uploadJson.content;
    } catch (err) {
      console.error("❌ File upload error:", err);
      previewTextDiv.textContent = `❌ ${err.message}`;
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }

  } else if (sourceType === "doc") {
    if (!googleDocLink) {
      previewTextDiv.textContent = "❌ Please paste a Google Doc link.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    const docId = extractGoogleDocId(googleDocLink);
    if (!docId) {
      previewTextDiv.textContent = "❌ Invalid Google Doc link format.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    try {
      source.content = await fetchGoogleDocText(docId);
    } catch (err) {
      console.error("❌ Failed to fetch Google Doc:", err);
      previewTextDiv.textContent = "❌ Could not retrieve Google Doc content.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }

  } else if (sourceType === "youtube") {
    if (!youtubeLink) {
      previewTextDiv.textContent = "❌ Please paste a YouTube link.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    const videoId = extractYouTubeVideoId(youtubeLink);
    if (!videoId) {
      previewTextDiv.textContent = "❌ Invalid YouTube link format.";
      previewModal.classList.remove("hidden"); previewModal.classList.add("active");
      await LoaderGuard.finish('assessment', loaderId, { ok: false });
      return;
    }
    try {
  // nudge the loader while we’re pulling captions
  GenLoader.update(undefined, "Fetching video transcript…");

  const captions = await fetchYouTubeTranscriptWithRetry(videoId, { retries: 3, delayMs: 1200 });
  if (!captions) {
    previewTextDiv.textContent = "❌ Could not fetch captions for this video.";
    previewModal.classList.remove("hidden");
    previewModal.classList.add("active");
    return;
  }
  source.content = captions;
} catch (err) {
  console.error("❌ Failed to fetch YouTube captions:", err);
  previewTextDiv.textContent = `❌ ${err.message}`;
  previewModal.classList.remove("hidden");
  previewModal.classList.add("active");
  return;
}

  }

  // ── Build request ──
  const selectedTEKSList = Array.from(selectedTEKS).map(t => JSON.parse(t));
  const body = {
    type,
    questionCount: count,
    formats,
    source,
    grade,
    subject,
    essayStyle,
    selectedTEKS: selectedTEKSList,
    elaMode
  };

  try {
      const res = await fetch("/api/generate-assessment-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const responseText = await res.text();
    let parsed;
    try { parsed = JSON.parse(responseText); }
    catch (jsonErr) { throw new Error("Invalid JSON response from server."); }

    if (!res.ok) {
      const errMsg = parsed?.error || parsed?.message || `Server error: ${res.status}`;
      throw new Error(errMsg);
    }

    function extractTitleAndContent(raw) {
      const titleMatch = raw.match(/^\s*(?:Title|Assessment Title)\s*[:\-–—]\s*(.+)$/mi);
      const title = titleMatch ? titleMatch[1].trim() : "Untitled Assessment";
      const content = raw.replace(/^\s*(?:Title|Assessment Title)\s*[:\-–—]\s*.+\r?\n?/mi, "").trimStart();
      return { title, content };
    }

    function setPreviewHeader(title) {
      const h = document.querySelector('#assessmentPreviewModal h2');
      if (!h) return;
      const safe = String(title).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      h.innerHTML = `📋 Assessment Preview<br><br><em>${safe}</em>`;
    }

    const raw = parsed.preview || parsed.assessment || parsed.text || parsed.content;
    const { title, content } = extractTitleAndContent(raw);
    setPreviewHeader(title);

    const parsedQuestions = parseFormattedAssessment(content);

    if (isPrompt) {
      const promptMatch = content.match(/Prompt:\s*([\s\S]*)/i);
      const prompt = promptMatch ? promptMatch[1].trim() : "Write a response.";
      parsedQuestions.length = 0;
      parsedQuestions.push({ question: prompt, choices: [], answerIndex: null, type });
    }

    latestAssessmentData = { ...body, preview: content, formTitle: title, parsedQuestions };

    const safeContent = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const formatted = safeContent
      .split(/---+/g)
      .filter(Boolean)
      .map(block => {
        const escaped = block.trim()
          .replace(/^Correct Answer:.*$/gim, line => `<strong>${line}</strong>`)
          .replace(/\n/g, "<br>");
        return `<div class="question-block">${escaped}</div>`;
      })
      .join("<hr>");

    previewTextDiv.innerHTML = formatted;
    window.dispatchEvent(new CustomEvent('assessment-preview-ready'));

    // reveal preview + finish loader
    previewModal.classList.remove("hidden");
    previewModal.classList.add("active");
    await new Promise((r) => requestAnimationFrame(r));
    await LoaderGuard.finish('assessment', loaderId, { ok: true });

    if (window.MathJax) MathJax.typesetPromise();
    confirmBtn.classList.remove("hidden");

  } catch (err) {
    console.error("❌ Assessment preview error:", err);
    const msg = err?.message || "❌ Failed to generate assessment preview.";
    previewTextDiv.innerHTML = `<div class="text-red-600 font-semibold">${msg}</div>`;
    confirmBtn.classList.add("hidden");
    await LoaderGuard.finish('assessment', loaderId, { ok: false });
  }
}


async function confirmCreateAssessment() {
  if (!latestAssessmentData?.parsedQuestions) return;

    const res = await fetch("/api/create-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: latestAssessmentData.formTitle,
      questions: latestAssessmentData.parsedQuestions
    })
  });

  const { url } = await res.json();
  if (url) window.open(url, "_blank");
}


// Wire up buttons and field behavior

document.addEventListener("DOMContentLoaded", () => {
  const sourceSelect = document.getElementById("sourceTypeSelect");
  const typeSelect = document.getElementById("assessmentTypeSelect");

  const fileSection = document.getElementById("fileUploadSection");
  const docSection = document.getElementById("docLinkSection");
  const youtubeSection = document.getElementById("youtubeLinkSection");
  const mixedOptions = document.getElementById("mixedOptions");

  const updateSourceFields = () => {
    if (!sourceSelect) return;
    const val = sourceSelect.value;
    fileSection?.classList.toggle("hidden", val !== "upload");
    docSection?.classList.toggle("hidden", val !== "doc");
    youtubeSection?.classList.toggle("hidden", val !== "youtube");
      // If switching away from YouTube, drop any cached transcript
  if (val !== "youtube") {
    ytTranscriptCache.clear();
    lastYouTubeId = null;
  }
  };

  sourceSelect?.addEventListener("change", updateSourceFields);

    const ytInput = document.getElementById("youtubeLink");
  ytInput?.addEventListener("input", () => {
    const raw = ytInput.value?.trim() || "";
    const nextId = extractYouTubeVideoId(raw);
    // if the user types/pastes a different video, invalidate cache
    if (nextId && nextId !== lastYouTubeId) {
      ytTranscriptCache.clear();
      lastYouTubeId = null;
    }
    // if the field is cleared, also drop cache
    if (!raw) {
      ytTranscriptCache.clear();
      lastYouTubeId = null;
    }
  });

  const openBtn = document.getElementById("generateAssessmentBtn");
  const closeBtn = document.getElementById("closeAssessmentModal");
  const modal = document.getElementById("assessmentModal");

  const closePreviewBtn = document.getElementById("closeAssessmentPreviewModal");
  const previewModal = document.getElementById("assessmentPreviewModal");

  openBtn?.addEventListener("click", () => {
    modal?.classList.remove("hidden");
    modal?.classList.add("active");
    updateSourceFields();
    updateAssessmentFields();
  });

  closeBtn?.addEventListener("click", () => {
    modal?.classList.add("hidden");
    modal?.classList.remove("active");
  });

  closePreviewBtn?.addEventListener("click", () => {
  previewModal?.classList.add("hidden");
  previewModal?.classList.remove("active"); // 👈 This is key
});

  window.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
      modal.classList.remove("active");
    }
    if (e.target === previewModal) {
      previewModal.classList.add("hidden");
    }
  });

const essayStyleSection = document.getElementById("essayStyleSection");

const updateAssessmentFields = () => {
  if (!typeSelect) return;
  const val = typeSelect.value;
  mixedOptions?.classList.toggle("hidden", val !== "mixed");
  essayStyleSection?.classList.toggle("hidden", val !== "essay");
  document.getElementById("elaModeContainer")?.classList.toggle("hidden", val !== "mixed");
};

typeSelect?.addEventListener("change", updateAssessmentFields);

    document.getElementById("generateAssessmentPreviewBtn")
    ?.addEventListener("click", generateAssessmentPreview);

  document.getElementById("confirmCreateAssessmentBtn")
    ?.addEventListener("click", confirmCreateAssessment);

  document.getElementById("tryAgainPreviewBtn")
  ?.addEventListener("click", async () => {
    const btn = document.getElementById("tryAgainPreviewBtn");
    btn.disabled = true;
    btn.textContent = "🔄 Regenerating…";

    try {
      latestAssessmentData = {
        ...(latestAssessmentData || {}),
        retryCount: (latestAssessmentData?.retryCount || 0) + 1,
      };
      await generateAssessmentPreview();
    } catch (err) {
      console.error("❌ Error retrying preview:", err);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔁 Try Again";
    }
  });
});

/** Generating Loader controller with tunable timing */
const GenLoader = (() => {
  const el = document.getElementById('genLoader');
  const card = el?.querySelector('.gen-card');
  const title = el?.querySelector('#genTitle');
  const dotsBase = el?.querySelector('#genDotsBase');
  

  const defaults = { minShowMs: 650, lingerMs: 250, successHoldMs: 600, errorHoldMs: 1200 };
  let timing = { ...defaults };
  let startedAt = 0;
  let timeouts = new Set();

  function clearTimers(){ timeouts.forEach(clearTimeout); timeouts.clear(); }
  function setVar(name, val){ if (el) el.style.setProperty(name, val); }

  function configure(opts = {}){ // tweak speeds or holds at runtime
    if ('minShowMs' in opts) timing.minShowMs = +opts.minShowMs;
    if ('lingerMs' in opts) timing.lingerMs = +opts.lingerMs;
    if ('successHoldMs' in opts) timing.successHoldMs = +opts.successHoldMs;
    if ('errorHoldMs' in opts) timing.errorHoldMs = +opts.errorHoldMs;
    if ('spinS' in opts) setVar('--gen-spin-s', `${opts.spinS}s`);
    if ('dotsS' in opts) setVar('--gen-dots-s', `${opts.dotsS}s`);
    if ('barS' in opts) setVar('--gen-bar-s', `${opts.barS}s`);
    if ('popS' in opts) setVar('--gen-pop-s', `${opts.popS}s`);
  }

  function show(main, sub = 'Please wait', opts = {}){
    if (!el) return;
    clearTimers();
    // merge current tuning with per-call overrides
    timing = { ...timing, ...opts };
    startedAt = performance.now();
    card?.classList.remove('success','error');
    title.textContent = main;
    dotsBase.textContent = sub;
    el.classList.remove('hidden');
  }

  function update(main, sub){ if (main) title.textContent = main; if (sub) dotsBase.textContent = sub; }

  function hide(delay){
    if (!el) return;
    const elapsed = performance.now() - startedAt;
    const wait = Math.max(0, (timing.minShowMs - elapsed), delay ?? timing.lingerMs);
    timeouts.add(setTimeout(() => el.classList.add('hidden'), wait));
  }

  function success(msg = 'Done', holdMs){ if (!el) return; card?.classList.add('success'); title.textContent = msg; hide(holdMs ?? timing.successHoldMs); }
  function error(msg = 'Something went wrong', holdMs){ if (!el) return; card?.classList.add('error'); title.textContent = msg; hide(holdMs ?? timing.errorHoldMs); }

  // Close on Escape
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(0); });
  // Bubble up failures
  window.addEventListener('unhandledrejection', () => error('Generation failed'));
  window.addEventListener('error', () => error('Generation failed'));

  return { show, update, success, error, hide, configure };
})();

const LoaderGuard = (() => {
  const state = { objectives: 0, lesson: 0, assessment: 0 };
  const nextId = (k) => (state[k] = (state[k] || 0) + 1);
  const current = (k) => state[k] || 0;

  function start(k, { main, sub, minShowMs } = {}) {
    const id = nextId(k);
    GenLoader.show(main || "Generating", sub || "Please wait", {
      minShowMs: typeof minShowMs === "number" ? minShowMs : undefined,
      successHoldMs: 650,
    });
    return id;
  }

  async function finish(k, id, { ok = true, delay = 0 } = {}) {
    if (id !== current(k)) return;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (ok) {
      const msg = k === "lesson"
        ? "Lesson plan ready"
        : k === "assessment"
        ? "Assessment ready"
        : "Objectives ready";
      GenLoader.success(msg);
    } else {
      GenLoader.error("Generation failed");
    }
  }

  return { start, finish };
})();


/***** Preview visibility controller (event-driven; no extra loader) *****/
(function wireGeneratingStates(){
  if (window.__wiredGenPreview) return;
  window.__wiredGenPreview = true;

  const gp = document.getElementById('generateAssessmentPreviewBtn');
  const previewModal = document.getElementById('assessmentPreviewModal');
  if (!gp || !previewModal) return;

  gp.addEventListener('click', () => {
    // Hide the preview shell immediately; LoaderGuard runs inside generateAssessmentPreview()
    previewModal.classList.add('defer-open');
    // Safety: auto-unhide after 45s so nothing gets stuck
    clearTimeout(window.__assessmentPreviewUnlockTimer);
    window.__assessmentPreviewUnlockTimer = setTimeout(() => {
      previewModal.classList.remove('defer-open');
    }, 45000);
  });

  // As soon as content is injected, reveal the preview instantly
  window.addEventListener('assessment-preview-ready', () => {
    clearTimeout(window.__assessmentPreviewUnlockTimer);
    previewModal.classList.remove('defer-open');
  });
})();
