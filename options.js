/*  options.js  –  Save / load OpenAI API key via chrome.storage.sync  */

const keyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const toast = document.getElementById("toast");

// ── Load saved key on page open ──
chrome.storage.sync.get("openaiKey", ({ openaiKey }) => {
    if (openaiKey) keyInput.value = openaiKey;
});

// ── Save key on button click ──
saveBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!key) {
        toast.style.color = "#ff6b6b";
        toast.textContent = "Please enter a valid API key.";
        return;
    }

    chrome.storage.sync.set({ openaiKey: key }, () => {
        toast.style.color = "#53d769";
        toast.textContent = "✓ Key saved successfully!";
        setTimeout(() => (toast.textContent = ""), 3000);
    });
});
