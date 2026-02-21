/*  background.js  –  Service Worker
 *
 *  1. OpenAI API proxy (gpt-5.2)
 *  2. Broadcasts "startSolving" to all frames via messaging
 *  3. Fallback: uses chrome.scripting.executeScript to inject solver
 *  4. Relays "navigateNext" from iframe to top frame
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  /* ── AI request ── */
  if (msg.type === "askAI") {
    console.log("[AI] Received question:", msg.question?.slice(0, 100));
    console.log("[AI] Options:", msg.options);
    (async () => {
      try {
        const { openaiKey } = await chrome.storage.sync.get("openaiKey");
        if (!openaiKey) {
          console.error("[AI] No API key set!");
          sendResponse({ error: "No API key. Set it in extension Options." });
          return;
        }
        console.log("[AI] API key found, calling OpenAI...");

        const letters = ["A", "B", "C", "D", "E", "F"];
        const optionsList = msg.options.map((o, i) => `${letters[i] || i}. ${o}`).join("\n");

        const prompt = `Question\n${msg.question}\n\nSelect an Answer\n${optionsList}`;
        console.log("[AI] Full prompt:\n", prompt);

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content:
                  "You are answering a multiple-choice question from a college textbook. " +
                  "Reply with ONLY the letter (A, B, C, or D) of the correct answer. " +
                  "No explanation, no period, just the letter.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
        });

        if (!res.ok) {
          sendResponse({ error: `OpenAI ${res.status}: ${await res.text()}` });
          return;
        }

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
        console.log("[AI] Raw response:", raw);
        // Map letter back to index: A->0, B->1, C->2, D->3
        const letterIdx = letters.indexOf(raw.toUpperCase().replace(/[^A-F]/g, "").charAt(0));
        const index = letterIdx >= 0 ? letterIdx : 0;
        console.log("[AI] Mapped to index:", index);
        sendResponse({ index, raw });
      } catch (e) {
        console.error("[AI] Error:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  /* ── Trigger solving: broadcast + fallback injection ── */
  if (msg.type === "triggerSolve") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: "no tab" }); return; }

    // Method 1: broadcast via messaging
    chrome.tabs.sendMessage(tabId, { type: "startSolving" }, () => {
      if (chrome.runtime.lastError) { /* ok */ }
    });

    // Method 2: also inject via chrome.scripting as fallback
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        window.dispatchEvent(new CustomEvent("nerd-auto-solver-start"));
      },
    }).catch(() => { });

    sendResponse({ ok: true });
    return false;
  }

  /* ── Navigate next: relay from iframe to top ── */
  if (msg.type === "navigateNext") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "navigateNext" }, () => {
      if (chrome.runtime.lastError) { /* ok */ }
    });
    return false;
  }

  /* ── Dismiss modal: relay from iframe to TOP FRAME ONLY and return result ── */
  if (msg.type === "dismissModal") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ result: "unknown" }); return false; }

    // Send ONLY to the top frame (frameId: 0) — not all frames
    chrome.tabs.sendMessage(tabId, { type: "dismissModal" }, { frameId: 0 }, (res) => {
      if (chrome.runtime.lastError) {
        sendResponse({ result: "unknown" });
      } else {
        sendResponse(res || { result: "unknown" });
      }
    });
    return true; // ASYNC — keep channel open to forward the response
  }
});
