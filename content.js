/*  content.js  –  Norton Ebook Auto-Solver  v4
 *
 *  Runs in ALL frames on *.wwnorton.com.
 *  shadow-patch.js (MAIN world) runs first to force shadow DOMs open.
 *
 *  Flow:
 *    1. Ask AI (gpt-5.2) for best guess
 *    2. Select AI's answer -> click Check Answer -> dismiss feedback modal
 *    3. Modal says "Finish" = correct -> move on; "Try Again" = wrong -> try next option
 *    4. After all questions on page -> Option+ArrowRight -> auto-continue on next page
 */

(() => {
    "use strict";

    const P = "[Auto-Solver]";
    const isTop = (window === window.top);

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const log = (...a) => console.log(P, ...a);
    const warn = (...a) => console.warn(P, ...a);

    log(`Loaded. Frame=${isTop ? "TOP" : "IFRAME"} URL=${location.href.slice(0, 100)}`);

    // Skip audio player iframes only — they're never quiz frames
    if (!isTop) {
        if (location.href.includes("player.wwnorton.com")) return;
        log(`IFRAME URL: ${location.href.slice(0, 120)}`);
    }

    /* ======= DEEP SHADOW DOM TRAVERSAL ======= */

    function deepFind(root, selector) {
        let found = [...root.querySelectorAll(selector)];
        for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) found = found.concat(deepFind(el.shadowRoot, selector));
        }
        return found;
    }

    function deepFindByText(root, tag, text) {
        return deepFind(root, tag).filter(el =>
            el.textContent.trim().toLowerCase().includes(text.toLowerCase())
        );
    }

    /* ======= CLICK / RADIO HELPERS ======= */

    function nativeClick(el) {
        if (!el) return;
        try { el.scrollIntoView({ behavior: "instant", block: "center" }); } catch (_) { }
        el.focus?.();
        for (const evt of ["mousedown", "mouseup", "click"]) {
            el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function selectRadio(radio) {
        if (!radio) return;
        try { radio.scrollIntoView({ behavior: "instant", block: "center" }); } catch (_) { }

        const root = radio.getRootNode();
        if (radio.name) {
            root.querySelectorAll(`input[name="${radio.name}"]`).forEach(r => (r.checked = false));
        }

        try {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
            if (setter) setter.call(radio, true);
        } catch (_) { }
        radio.checked = true;
        radio.focus?.();

        for (const evt of ["mousedown", "mouseup", "click"]) {
            radio.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
        }
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        radio.dispatchEvent(new Event("input", { bubbles: true }));

        const lbl = radio.closest("label");
        if (lbl) nativeClick(lbl);

        log(`  Selected [${radio.value || radio.id || "?"}]`);
    }

    /* ======= FIND QUESTION COMPONENTS ======= */

    function findAllRadios() {
        let radios = deepFind(document, "input.nds-field__input--radio");
        if (radios.length === 0) radios = deepFind(document, 'input[type="radio"]');
        if (radios.length === 0) radios = deepFind(document, '[role="radio"]');
        if (radios.length === 0) radios = deepFind(document, '[class*="radio"]');
        log(`  Found ${radios.length} total radios`);
        return radios;
    }

    function groupByName(radios) {
        const groups = {};
        radios.forEach(r => {
            const key = r.name || r.getAttribute("name") || "__default__";
            (groups[key] = groups[key] || []).push(r);
        });
        return Object.values(groups);
    }

    /* ======= COMPLETION DETECTION ======= */

    function isQuestionComplete(radios) {
        // Walk up from radio, check each ancestor for INCOMPLETE/COMPLETE
        let el = radios[0];
        for (let i = 0; i < 20 && el; i++) {
            const root = el.getRootNode();
            const node = (root instanceof ShadowRoot) ? root.host : el;
            const t = node?.textContent || "";

            if (/Check Your Understanding/i.test(t)) {
                if (/INCOMPLETE/i.test(t)) return false;
                if (/\bCOMPLETE\b/i.test(t)) return true;
            }

            if (root instanceof ShadowRoot) el = root.host;
            else el = el.parentElement;
        }

        // All radios disabled = already answered
        if (radios.every(r => r.disabled)) return true;

        return false;
    }

    /* ======= SCRAPE QUESTION DATA ======= */

    function getLabel(radio) {
        function clean(s) {
            return (s || "").trim().replace(/^[A-F]\.\s*/i, "").trim();
        }

        // 1. Try parent <label> — but only if it has substantial text
        const pLbl = radio.closest("label");
        if (pLbl) {
            const txt = clean(pLbl.textContent);
            if (txt.length > 3) return txt;
        }

        // 2. Try label[for="id"]
        const root = radio.getRootNode();
        if (radio.id) {
            const lbl = root.querySelector?.(`label[for="${radio.id}"]`);
            if (lbl) {
                const txt = clean(lbl.textContent);
                if (txt.length > 3) return txt;
            }
        }

        // 3. Check siblings of the radio (answer text might be next to it)
        const sib = radio.nextElementSibling;
        if (sib) {
            const txt = clean(sib.textContent);
            if (txt.length > 3) return txt;
        }

        // 4. Check parent's children — the answer text may be a sibling div/span
        const parent = radio.parentElement;
        if (parent) {
            for (const child of parent.children) {
                if (child === radio) continue;
                const txt = clean(child.textContent);
                if (txt.length > 3) return txt;
            }
            // 5. Try grandparent's children
            const gp = parent.parentElement;
            if (gp) {
                for (const child of gp.children) {
                    if (child === parent || child.querySelector?.("input")) continue;
                    const txt = clean(child.textContent);
                    if (txt.length > 3) return txt;
                }
            }
        }

        // 6. Fallback: parent text
        const txt = clean(parent?.textContent);
        return txt || "(no label)";
    }

    function getQuestionText(radios) {
        let el = radios[0];
        for (let i = 0; i < 20 && el; i++) {
            const root = el.getRootNode();
            const node = (root instanceof ShadowRoot) ? root.host : el;
            const t = node?.textContent || "";

            if (t.includes("Question") && t.includes("Select an Answer")) {
                const m = t.match(/Question\s*([\s\S]*?)(?:Select an Answer)/i);
                if (m && m[1].trim().length > 5) return m[1].trim();
            }

            if (root instanceof ShadowRoot) el = root.host;
            else el = el.parentElement;
        }

        // Fallback
        let container = radios[0].parentElement;
        for (let i = 0; i < 10 && container; i++) {
            const t = container.textContent || "";
            if (t.length > 50 && t.length < 2000) {
                const m = t.match(/Question\s*([\s\S]*?)(?:Select an Answer)/i);
                if (m) return m[1].trim();
            }
            container = container.parentElement;
        }

        return "(Could not extract question text)";
    }

    /* ======= CHECK ANSWER + MODAL DISMISSAL ======= */

    function findCheckAnswerBtn(radios) {
        let root = radios[0].getRootNode();
        for (let i = 0; i < 10; i++) {
            const scope = (root instanceof ShadowRoot) ? root : document;
            const btns = [...scope.querySelectorAll("button")];
            const btn = btns.find(b => /check\s*answer/i.test(b.textContent));
            if (btn) return btn;
            if (root instanceof ShadowRoot) root = root.host.getRootNode();
            else break;
        }
        const all = deepFindByText(document, "button", "check answer");
        return all.length > 0 ? all[0] : null;
    }

    function clickCheckAnswer(radios) {
        const btn = findCheckAnswerBtn(radios);
        if (!btn) { warn("  Check Answer button not found!"); return false; }
        btn.disabled = false;
        btn.removeAttribute("disabled");
        nativeClick(btn);
        log("  Clicked Check Answer");
        return true;
    }

    /**
     * Try to dismiss feedback modal in THIS frame.
     * Returns: "correct" | "wrong" | null
     *
     * Norton shows:
     *   CORRECT answer -> "Finish" button
     *   WRONG   answer -> "Try Again" button
     */
    function tryDismissLocal() {
        // Check for "Try Again" first (wrong answer)
        for (const kw of ["try again", "retry"]) {
            const btns = deepFindByText(document, "button", kw);
            const visible = btns.filter(b => {
                try { return b.offsetWidth > 0 && b.offsetHeight > 0; } catch (_) { return true; }
            });
            if (visible.length > 0) {
                log(`  Modal: WRONG -> clicking "${visible[0].textContent.trim().slice(0, 30)}"`);
                nativeClick(visible[0]);
                return "wrong";
            }
        }

        // Check for "Finish" / completion buttons (correct answer)
        for (const kw of ["finish", "ok", "done", "continue", "got it"]) {
            const btns = deepFindByText(document, "button", kw);
            const visible = btns.filter(b => {
                try { return b.offsetWidth > 0 && b.offsetHeight > 0; } catch (_) { return true; }
            });
            if (visible.length > 0) {
                log(`  Modal: CORRECT -> clicking "${visible[0].textContent.trim().slice(0, 30)}"`);
                nativeClick(visible[0]);
                return "correct";
            }
        }

        // Try close button by class
        const closeBtn = document.querySelector(".question-frame__feedback__close-btn");
        if (closeBtn && closeBtn.offsetWidth > 0) {
            log("  Dismissing via close btn");
            nativeClick(closeBtn);
            return "correct"; // close btn usually means correct/done
        }

        // Try aria-label close
        for (const label of ["Close", "close", "Dismiss"]) {
            const els = deepFind(document, `[aria-label="${label}"]`);
            const visible = els.filter(e => { try { return e.offsetWidth > 0; } catch (_) { return true; } });
            if (visible.length > 0) { nativeClick(visible[0]); return "correct"; }
        }

        return null;
    }

    /**
     * Dismiss feedback modal. Returns "correct" | "wrong" | "unknown"
     */
    async function dismissFeedbackModal() {
        await sleep(1800);

        // Try in THIS frame first
        const localResult = tryDismissLocal();
        if (localResult) {
            await sleep(1000);
            return localResult;
        }

        // If we're in an iframe, ask TOP frame to dismiss and return result
        if (!isTop) {
            log("  Modal not in iframe. Asking TOP frame...");
            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({ type: "dismissModal" }, res => {
                    if (chrome.runtime.lastError) { resolve("unknown"); return; }
                    resolve(res?.result || "unknown");
                });
            });
            await sleep(1500);
            log(`  TOP frame says: ${result}`);
            return result;
        }

        return "unknown";
    }

    /* ======= ASK AI ======= */

    function askAI(q, opts) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ type: "askAI", question: q, options: opts }, res => {
                if (chrome.runtime.lastError) {
                    warn("AI ERROR:", chrome.runtime.lastError.message);
                    resolve({ index: 0, error: true });
                    return;
                }
                if (res?.error) {
                    warn("AI ERROR:", res.error);
                    resolve({ index: 0, error: true });
                    return;
                }
                resolve(res);
            });
        });
    }

    /* ======= SOLVE ONE QUESTION ======= */

    async function solveOneQuestion(radios, qIndex) {
        if (isQuestionComplete(radios)) {
            log(`Q${qIndex + 1}: Already COMPLETE -- skipping`);
            return;
        }

        const labels = radios.map(getLabel);
        const qText = getQuestionText(radios);
        const letters = ["A", "B", "C", "D", "E", "F"];

        log(`\n------ Q${qIndex + 1} ------`);
        log(`  Question: "${qText.slice(0, 200)}"`);
        labels.forEach((l, i) => log(`  ${letters[i]}. ${l.slice(0, 60)}`));

        // Step 1: ASK AI
        log("  Sending to AI... (waiting for response)");
        const t0 = Date.now();
        const aiResult = await askAI(qText, labels);
        const elapsed = Date.now() - t0;

        if (aiResult.error) {
            warn(`  AI FAILED (${elapsed}ms). Will try all options starting from A.`);
        }

        const aiChoice = Math.min(Math.max(aiResult.index || 0, 0), radios.length - 1);
        log(`  AI answered: ${letters[aiChoice]} (raw: "${aiResult.raw}") in ${elapsed}ms`);

        // Step 2: Try AI's answer first, then brute-force the rest
        const order = [aiChoice, ...Array.from({ length: radios.length }, (_, i) => i).filter(i => i !== aiChoice)];

        for (const i of order) {
            log(`  Trying option ${letters[i]}: "${labels[i]?.slice(0, 40)}"`);
            selectRadio(radios[i]);
            await sleep(800);

            const clicked = clickCheckAnswer(radios);
            if (!clicked) { warn("  Could not click Check Answer."); continue; }

            const result = await dismissFeedbackModal();

            if (result === "correct") {
                log(`  CORRECT! (option ${letters[i]})`);
                return;
            }

            log(`  Wrong. Trying next option...`);
            await sleep(500);
        }

        warn(`  Q${qIndex + 1}: Tried ALL ${radios.length} options, none worked.`);
    }

    /* ======= TOP FRAME: Button ======= */

    if (isTop) {
        const inject = () => {
            if (document.getElementById("nerd-auto-solve-btn")) return;
            const btn = document.createElement("button");
            btn.id = "nerd-auto-solve-btn";
            btn.textContent = "Auto-Solve";
            Object.assign(btn.style, {
                position: "fixed", bottom: "24px", right: "24px", zIndex: "2147483647",
                padding: "12px 22px", fontSize: "15px", fontWeight: "700",
                fontFamily: "system-ui, sans-serif", color: "#fff",
                background: "linear-gradient(135deg, #e94560, #0f3460)",
                border: "none", borderRadius: "12px", cursor: "pointer",
                boxShadow: "0 4px 20px rgba(233,69,96,.5)",
            });
            btn.onclick = onButtonClick;
            document.body.appendChild(btn);
            log("Button injected.");
        };
        if (document.body) inject(); else document.addEventListener("DOMContentLoaded", inject);

        document.addEventListener("keydown", e => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
                e.preventDefault();
                onButtonClick();
            }
        });
    }

    function onButtonClick() {
        try {
            if (!chrome.runtime?.id) {
                alert("Extension was updated. Please reload this page (Cmd+R) and try again.");
                return;
            }

            const btn = document.getElementById("nerd-auto-solve-btn");
            if (btn) { btn.textContent = "Solving..."; btn.style.opacity = "0.7"; btn.style.pointerEvents = "none"; }

            log("Triggered! Broadcasting to all frames...");
            chrome.runtime.sendMessage({ type: "triggerSolve" }, () => {
                if (chrome.runtime.lastError) warn("triggerSolve:", chrome.runtime.lastError.message);
            });
            solveInThisFrame();

        } catch (e) {
            if (e.message?.includes("Extension context invalidated")) {
                alert("Extension was reloaded. Please refresh this page (Cmd+R) and try again.");
            } else {
                console.error(P, e);
            }
        }
    }

    /* ======= MESSAGE LISTENERS ======= */

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type === "startSolving") {
            solveInThisFrame();
            return false;
        }
        if (msg.type === "navigateNext" && isTop) {
            navigateNext();
            return false;
        }
        if (msg.type === "dismissModal" && isTop) {
            log("  TOP frame: dismissModal request received");
            const result = tryDismissLocal();
            log(`  TOP frame: dismiss result = ${result || "none"}`);
            sendResponse({ result: result || "unknown" });
            return true; // async response
        }
        return false;
    });

    window.addEventListener("nerd-auto-solver-start", () => {
        solveInThisFrame();
    });

    /* ======= NAVIGATION ======= */

    function navigateNext() {
        log("Looking for Next page link...");

        // Try clicking the Next navigation link (in top frame)
        const next = document.querySelector("a.linear-navigation-button--next")
            || [...document.querySelectorAll("a")].find(a => /Next\s*:/i.test(a.textContent));

        if (!next) {
            log("No Next link found on this page.");
            return;
        }

        log(`Clicking: "${next.textContent.trim().slice(0, 50)}"`);

        // Set flag for auto-continue (in case it does a full reload)
        chrome.storage.local.set({ autoSolving: true });

        // Norton is an SPA — clicking Next updates content without reloading.
        // So we watch for the iframe to reload, then re-trigger solving.
        const iframe = document.querySelector("#iframe-content, iframe");
        const oldSrc = iframe?.src || "";

        next.click();

        // Watch for iframe src change or DOM update (SPA navigation)
        let resolved = false;
        const afterNav = () => {
            if (resolved) return;
            resolved = true;
            log("Page changed! Waiting 3s then auto-solving...");
            running = false;
            setTimeout(() => {
                // Broadcast to all frames (including the new iframe content)
                chrome.runtime.sendMessage({ type: "triggerSolve" }, () => {
                    if (chrome.runtime.lastError) { /* ok */ }
                });
                solveInThisFrame();
            }, 3000);
        };

        // Method 1: Watch iframe src change
        if (iframe) {
            const checkSrc = setInterval(() => {
                if (iframe.src !== oldSrc) {
                    clearInterval(checkSrc);
                    log("Iframe src changed!");
                    afterNav();
                }
            }, 500);
            // Stop checking after 10s
            setTimeout(() => clearInterval(checkSrc), 10000);
        }

        // Method 2: Fallback timeout (in case we can't detect the change)
        setTimeout(() => {
            if (!resolved) {
                log("Fallback: 5s timeout reached, re-triggering solver...");
                afterNav();
            }
        }, 5000);
    }

    function requestNavigateNext() {
        if (isTop) { navigateNext(); return; }
        chrome.runtime.sendMessage({ type: "navigateNext" });
        try { window.parent.postMessage({ type: "nerd-auto-solver-navigate" }, "*"); } catch (_) { }
    }

    if (isTop) {
        window.addEventListener("message", e => {
            if (e.data?.type === "nerd-auto-solver-navigate") navigateNext();
        });
    }

    /* ======= MAIN ENTRY ======= */

    let running = false;

    async function solveInThisFrame() {
        if (running) { log("Already running."); return; }
        running = true;

        try {
            log(`\n======================================`);
            log(`SOLVING in ${isTop ? "TOP" : "IFRAME"}`);
            log(`======================================`);

            await sleep(2000);
            const radios = findAllRadios();

            if (radios.length === 0) {
                log("No radios found in this frame.");
                if (isTop) {
                    log("Top frame: waiting for quiz iframe to solve & signal.");
                }
                return;
            }

            const groups = groupByName(radios);
            log(`${radios.length} radios, ${groups.length} question(s)`);

            for (let i = 0; i < groups.length; i++) {
                await solveOneQuestion(groups[i], i);
                await sleep(1000);
            }

            // Done with all questions on this page -> navigate
            log("Done with this page! Moving to next...");
            await sleep(2000);
            requestNavigateNext();

        } catch (e) {
            console.error(P, e);
        } finally {
            running = false;
            if (isTop) {
                const btn = document.getElementById("nerd-auto-solve-btn");
                if (btn) { btn.textContent = "Auto-Solve"; btn.style.opacity = "1"; btn.style.pointerEvents = "auto"; }
            }
        }
    }

    // Auto-start if we navigated here from a previous page's solve
    if (isTop) {
        chrome.storage.local.get("autoSolving", ({ autoSolving }) => {
            if (autoSolving) {
                log("Auto-continuing from previous page...");
                const btn = document.getElementById("nerd-auto-solve-btn");
                if (btn) { btn.textContent = "Solving..."; btn.style.opacity = "0.7"; btn.style.pointerEvents = "none"; }
                // Small delay to let page fully render
                setTimeout(() => {
                    chrome.runtime.sendMessage({ type: "triggerSolve" }, () => {
                        if (chrome.runtime.lastError) { /* ok */ }
                    });
                    solveInThisFrame();
                }, 3000);
            }
        });
    }
})();
