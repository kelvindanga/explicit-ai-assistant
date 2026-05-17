(function () {
  const vscode = acquireVsCodeApi();
  const state = { pending: null, files: [], settings: {}, streamingId: null, mode: null, activeAgent: null, activeFile: null, mcpServers: [], agents: [] };

  const $ = (id) => document.getElementById(id);
  const thread = $("thread");
  const welcome = $("welcome");
  const promptInput = $("promptInput");
  const sendBtn = $("sendBtn");
  const stopBtn = $("stopBtn");
  const regenBtn = $("regenBtn");
  const modelCategory = $("modelCategory");
  const modelSelect = $("modelSelect");
  const modelBadge = $("modelBadge");
  const modeBadge = $("modeBadge");
  const modeLabel = $("modeLabel");
  const modeIcon = $("modeIcon");
  const fileChips = $("fileChips");
  const payloadModal = $("payloadModal");

  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function highlightCode(code) {
    var h = escapeHtml(code);
    [[/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await)\b/g, "hljs-keyword"],
     [/"[^"]*"|'[^']*'|`[^`]*`/g, "hljs-string"],
     [/\/\/.*|\/\*[\s\S]*?\*\//g, "hljs-comment"],
     [/\b\d+\.?\d*\b/g, "hljs-number"]
    ].forEach(function(r) { h = h.replace(r[0], function(m) { return '<span class="' + r[1] + '">' + m + "</span>"; }); });
    return h;
  }

  function formatMarkdown(text) {
    var blocks = [];
    var html = escapeHtml(text);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
      var i = blocks.length;
      var codeClean = code.replace(/\n$/, "");
      var inner = highlightCode(codeClean);
      // Detect if there's a file path hint (e.g. "// file: src/foo.ts" or filename in lang)
      var fileHint = "";
      var fileMatch = codeClean.match(/^\/\/\s*(?:file|path):\s*(.+)/m) || codeClean.match(/^#\s*(?:file|path):\s*(.+)/m);
      if (fileMatch) fileHint = fileMatch[1].trim();
      var applyBtn = '<button type="button" class="apply-btn" data-code="' + encodeURIComponent(codeClean) + '" data-file="' + encodeURIComponent(fileHint) + '">Apply</button>';
      blocks.push(
        '<pre class="hljs"><div class="code-actions">' +
        '<button type="button" class="copy-btn" data-code="' + encodeURIComponent(codeClean) + '">Copy</button>' +
        applyBtn +
        '</div><code>' + inner + "</code></pre>"
      );
      return "%%B" + i + "%%";
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>");
    html = "<p>" + html + "</p>";
    blocks.forEach(function(b, i) { html = html.replace("%%B" + i + "%%", b); });
    return html;
  }

  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function scrollBottom() { thread.scrollTop = thread.scrollHeight; }
  function hideWelcome() { if (welcome) welcome.classList.add("hidden"); }
  function showWelcome() { if (welcome) welcome.classList.remove("hidden"); }
  function setBusy(busy) {
    sendBtn.disabled = busy;
    if (stopBtn) stopBtn.classList.toggle("hidden", !busy);
    if (regenBtn) regenBtn.classList.toggle("hidden", busy);
    promptInput.disabled = busy;
  }

  // --- Active file (user-initiated only via # or attach button) ---
  function updateActiveFile(name) {
    state.activeFile = name;
  }

  // --- Mode ---
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".mode-card").forEach(function(c) { c.classList.toggle("active", c.getAttribute("data-mode") === mode); });
    if (modeBadge) {
      modeBadge.classList.remove("hidden");
      modeIcon.textContent = mode === "vibe" ? "🎨" : "🔄";
      modeLabel.textContent = mode === "vibe" ? "Vibe Mode" : "Agile Mode";
    }
    hideWelcome();
    vscode.postMessage({ type: "setMode", mode: mode });
  }
  document.querySelectorAll(".mode-card").forEach(function(card) { card.addEventListener("click", function() { setMode(card.getAttribute("data-mode")); }); });
  if ($("modeSwitchBtn")) $("modeSwitchBtn").addEventListener("click", function() { setMode(state.mode === "vibe" ? "agile" : "vibe"); });

  // --- Threads ---
  if ($("threadsBtn")) $("threadsBtn").addEventListener("click", function() {
    $("threadsPanel").classList.toggle("hidden"); if ($("agentsPanel")) $("agentsPanel").classList.add("hidden");
    if (!$("threadsPanel").classList.contains("hidden")) vscode.postMessage({ type: "getThreads" });
  });
  if ($("threadsClose")) $("threadsClose").addEventListener("click", function() { $("threadsPanel").classList.add("hidden"); });

  // --- Agents ---
  if ($("agentsBtn")) $("agentsBtn").addEventListener("click", function() {
    $("agentsPanel").classList.toggle("hidden"); if ($("threadsPanel")) $("threadsPanel").classList.add("hidden");
    if (!$("agentsPanel").classList.contains("hidden")) vscode.postMessage({ type: "getAgents" });
  });
  if ($("agentsClose")) $("agentsClose").addEventListener("click", function() { $("agentsPanel").classList.add("hidden"); });
  if ($("addAgentBtn")) $("addAgentBtn").addEventListener("click", function() { vscode.postMessage({ type: "addAgent" }); });

  // --- MCP ---
  if ($("mcpBtn")) $("mcpBtn").addEventListener("click", function() {
    $("mcpPanel").classList.toggle("hidden");
    if (!$("mcpPanel").classList.contains("hidden")) vscode.postMessage({ type: "getMcpServers" });
  });
  if ($("mcpClose")) $("mcpClose").addEventListener("click", function() { $("mcpPanel").classList.add("hidden"); });
  if ($("mcpConfigBtn")) $("mcpConfigBtn").addEventListener("click", function() { vscode.postMessage({ type: "openMcpConfig" }); });

  document.addEventListener("click", function(e) {
    if (!e.target.closest(".thread-item")) document.querySelectorAll(".thread-dropdown.show").forEach(function(d) { d.classList.remove("show"); });
  });

  function renderThreads(threads, activeId) {
    var list = $("threadsList"); if (!list) return;
    list.innerHTML = "";
    if (!threads || !threads.length) { list.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;">No chat history yet. Start a conversation!</div>'; return; }
    threads.forEach(function(t) {
      var item = document.createElement("div");
      item.className = "thread-item" + (t.id === activeId ? " active" : "");
      var timeStr = formatTime(t.lastActivity || t.timestamp);
      var msgCount = t.messageCount || (t.messages ? t.messages.length : 0);
      item.innerHTML =
        '<span class="thread-label">' + escapeHtml(t.label) + "</span>" +
        '<span class="thread-meta">' + msgCount + ' msgs · ' + timeStr + "</span>" +
        '<div class="thread-actions"><button type="button" class="thread-arrow-btn" title="Options">▾</button>' +
        '<div class="thread-dropdown">' +
        '<button type="button" class="thread-dropdown-item" data-action="switch" data-id="' + t.id + '">↗ Continue this chat</button>' +
        '<button type="button" class="thread-dropdown-item" data-action="revert" data-id="' + t.id + '">↩ Revert to this point</button>' +
        '<button type="button" class="thread-dropdown-item delete" data-action="delete" data-id="' + t.id + '">🗑 Delete</button></div></div>';
      item.querySelector(".thread-arrow-btn").addEventListener("click", function(e) {
        e.stopPropagation();
        var dd = item.querySelector(".thread-dropdown");
        document.querySelectorAll(".thread-dropdown.show").forEach(function(d) { if (d !== dd) d.classList.remove("show"); });
        dd.classList.toggle("show");
      });
      item.querySelectorAll(".thread-dropdown-item").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          if (btn.dataset.action === "revert") vscode.postMessage({ type: "revertThread", threadId: btn.dataset.id });
          else if (btn.dataset.action === "delete") vscode.postMessage({ type: "deleteThread", threadId: btn.dataset.id });
          else vscode.postMessage({ type: "switchThread", threadId: btn.dataset.id });
          $("threadsPanel").classList.add("hidden");
        });
      });
      item.addEventListener("click", function(e) {
        if (e.target.closest(".thread-actions")) return;
        vscode.postMessage({ type: "switchThread", threadId: t.id });
        $("threadsPanel").classList.add("hidden");
      });
      list.appendChild(item);
    });
  }

  function renderAgents(agents) {
    var list = $("agentsList"); if (!list) return;
    list.innerHTML = "";
    if (!agents || !agents.length) { list.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;">No agents configured.</div>'; return; }
    agents.forEach(function(a) {
      var item = document.createElement("div");
      item.className = "agent-item" + (a.id === state.activeAgent ? " active" : "");
      item.innerHTML = '<div class="agent-item-info"><div class="agent-item-name">' + escapeHtml(a.name) + "</div>" +
        '<div class="agent-item-desc">' + escapeHtml(a.description || "") + "</div></div>" +
        '<button type="button" class="agent-remove-btn">✕</button>';
      item.addEventListener("click", function(e) {
        if (e.target.closest(".agent-remove-btn")) return;
        state.activeAgent = a.id; vscode.postMessage({ type: "selectAgent", agentId: a.id }); $("agentsPanel").classList.add("hidden");
      });
      item.querySelector(".agent-remove-btn").addEventListener("click", function() { vscode.postMessage({ type: "removeAgent", agentId: a.id }); });
      list.appendChild(item);
    });
  }

  // --- MCP Servers panel (reads from mcp.json) ---
  function renderMcpServers(servers) {
    state.mcpServers = servers || [];
    var tools = $("mcpTools"); if (!tools) return;
    tools.innerHTML = "";
    if (!servers || !servers.length) { tools.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;">No MCP servers in mcp.json</div>'; return; }
    servers.forEach(function(srv) {
      var box = document.createElement("div");
      box.className = "mcp-tool" + (srv.disabled ? " mcp-tool-disabled" : "");
      var cmdStr = srv.command + " " + (srv.args || []).join(" ");
      box.innerHTML =
        '<div class="mcp-toggle-row">' +
          '<span class="mcp-toggle-label">' + escapeHtml(srv.name) + '</span>' +
          '<label class="toggle-switch"><input type="checkbox" class="mcp-srv-toggle" data-name="' + escapeHtml(srv.name) + '" ' + (!srv.disabled ? "checked" : "") + '><span class="toggle-slider"></span></label>' +
        '</div>' +
        '<div class="mcp-tool-cmd">' + escapeHtml(cmdStr) + '</div>';
      tools.appendChild(box);
    });
    tools.querySelectorAll(".mcp-srv-toggle").forEach(function(toggle) {
      toggle.addEventListener("change", function() {
        vscode.postMessage({ type: "toggleMcpServer", serverName: toggle.dataset.name, disabled: !toggle.checked });
      });
    });
  }

  function renderChips(files) {
    state.files = files || []; fileChips.innerHTML = "";
    state.files.forEach(function(f) {
      var chip = document.createElement("span"); chip.className = "file-chip";
      chip.innerHTML = "📄 " + escapeHtml(f.name) + ' <button type="button" data-id="' + f.id + '" title="Remove">×</button>';
      chip.querySelector("button").addEventListener("click", function() { vscode.postMessage({ type: "removeFile", id: f.id }); });
      fileChips.appendChild(chip);
    });
  }

  function updateModelBadge(model) { if (modelBadge) modelBadge.textContent = "Model: " + (model || "—"); }
  function fillModels(models, selected) {
    if (!modelSelect) return; modelSelect.innerHTML = "";
    (models || []).forEach(function(m) {
      var o = document.createElement("option"); o.value = m.id; o.textContent = m.name || m.id;
      if (m.id === selected) o.selected = true; modelSelect.appendChild(o);
    });
    updateModelBadge(selected);
  }

  function appendMessage(role, content, opts) {
    hideWelcome();
    var row = document.createElement("div"); row.className = "message " + role; row.dataset.id = (opts && opts.id) || "";
    var av = document.createElement("div"); av.className = "avatar"; av.textContent = role === "user" ? "You" : role === "error" ? "!" : "AI";
    var bubble = document.createElement("div"); bubble.className = "bubble";
    var inner = document.createElement("div"); inner.className = "bubble-inner";
    if (role === "assistant" && opts && opts.streaming) inner.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    else if (role === "assistant") inner.innerHTML = formatMarkdown(content);
    else inner.textContent = content;
    if (opts && opts.files && opts.files.length) { var fl = document.createElement("div"); fl.className = "msg-files"; fl.textContent = "Attached: " + opts.files.join(", "); inner.appendChild(fl); }
    var meta = document.createElement("div"); meta.className = "msg-meta"; meta.textContent = formatTime((opts && opts.timestamp) || Date.now());
    if (opts && opts.model) meta.textContent += " · " + opts.model;
    // Add undo button on user messages
    if (role === "user" && opts && opts.id) {
      var undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "msg-undo-btn";
      undoBtn.title = "Undo from here";
      undoBtn.textContent = "↩ Undo";
      undoBtn.addEventListener("click", function() { vscode.postMessage({ type: "undo", messageId: opts.id }); });
      meta.appendChild(undoBtn);
    }
    bubble.appendChild(inner); bubble.appendChild(meta); row.appendChild(av); row.appendChild(bubble); thread.appendChild(row); scrollBottom();
    return inner;
  }

  function getStreamingBubble(id) { var row = thread.querySelector('.message.assistant[data-id="' + id + '"]'); return row ? row.querySelector(".bubble-inner") : null; }

  function autoResize() { promptInput.style.height = "auto"; promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + "px"; }

  function send() {
    var prompt = promptInput.value.trim(); if (!prompt) return;
    if (!state.mode) setMode("vibe");
    vscode.postMessage({ type: "send", prompt: prompt, context: "", skipPreview: true });
    promptInput.value = ""; autoResize();
    // Hide autocomplete if open
    hideAutocomplete();
  }

  // --- @ and # Autocomplete ---
  var autocompleteEl = null;
  var autocompleteItems = [];
  var autocompleteIdx = -1;
  var autocompletePrefix = "";
  var autocompleteType = ""; // "agent" or "file"

  function createAutocomplete() {
    if (autocompleteEl) return autocompleteEl;
    autocompleteEl = document.createElement("div");
    autocompleteEl.className = "autocomplete-popup";
    autocompleteEl.style.display = "none";
    var composerEl = $("composer");
    if (composerEl) composerEl.appendChild(autocompleteEl);
    else document.body.appendChild(autocompleteEl);
    return autocompleteEl;
  }

  function showAutocomplete(items, type) {
    var el = createAutocomplete();
    autocompleteItems = items;
    autocompleteType = type;
    autocompleteIdx = -1;
    if (!items.length) { el.style.display = "none"; return; }
    el.innerHTML = items.map(function(item, i) {
      var icon = type === "agent" ? "🤖" : "📄";
      var label, desc, id;
      if (typeof item === "string") {
        label = item;
        desc = "";
        id = item;
      } else {
        label = item.name || item.id || "";
        desc = item.description || "";
        id = item.id || item.name || "";
      }
      var descHtml = desc ? ' <span class="ac-desc">' + escapeHtml(desc) + '</span>' : '';
      return '<div class="ac-item" data-idx="' + i + '">' + icon + ' <span class="ac-label">' + escapeHtml(label) + '</span>' + descHtml + '</div>';
    }).join("");
    el.style.display = "block";
    el.querySelectorAll(".ac-item").forEach(function(row) {
      row.addEventListener("mousedown", function(e) {
        e.preventDefault();
        selectAutocomplete(parseInt(row.dataset.idx, 10));
      });
    });
  }

  function hideAutocomplete() {
    if (autocompleteEl) autocompleteEl.style.display = "none";
    autocompleteItems = [];
    autocompleteIdx = -1;
  }

  function selectAutocomplete(idx) {
    var item = autocompleteItems[idx];
    if (!item) return;
    // Don't select placeholder items
    if (item.id === "loading" || item.id === "none") return;
    var val = promptInput.value;
    var cursor = promptInput.selectionStart || val.length;
    // Find the @ or # trigger position
    var triggerChar = autocompleteType === "agent" ? "@" : "#";
    var triggerPos = val.lastIndexOf(triggerChar, cursor - 1);
    if (triggerPos < 0) { hideAutocomplete(); return; }
    var insertText = (item.id || item.name || item) + " ";
    promptInput.value = val.substring(0, triggerPos + 1) + insertText + val.substring(cursor);
    promptInput.selectionStart = promptInput.selectionEnd = triggerPos + 1 + insertText.length;
    hideAutocomplete();
    promptInput.focus();
    autoResize();
  }

  promptInput.addEventListener("input", function() {
    autoResize();
    var val = promptInput.value;
    var cursor = promptInput.selectionStart || val.length;
    // Check if we're typing after @ or #
    var beforeCursor = val.substring(0, cursor);
    var atMatch = beforeCursor.match(/@([\w-]*)$/);
    var hashMatch = beforeCursor.match(/#([\w.\/\\-]*)$/);

    if (atMatch !== null) {
      autocompletePrefix = (atMatch[1] || "").toLowerCase();
      // Show all agents when just "@" is typed, or filter by prefix
      var allAgents = state.agents || [];
      var filtered = allAgents.filter(function(a) {
        if (!autocompletePrefix) return true; // show all on bare @
        return a.id.toLowerCase().indexOf(autocompletePrefix) >= 0 ||
               a.name.toLowerCase().indexOf(autocompletePrefix) >= 0;
      }).slice(0, 10);
      if (filtered.length > 0) {
        showAutocomplete(filtered, "agent");
      } else if (!autocompletePrefix && allAgents.length === 0) {
        // Agents not loaded yet — request them
        vscode.postMessage({ type: "getAgents" });
        showAutocomplete([{ id: "loading", name: "Loading agents...", description: "" }], "agent");
      } else {
        hideAutocomplete();
      }
    } else if (hashMatch !== null) {
      autocompletePrefix = (hashMatch[1] || "").toLowerCase();
      // Set type immediately so the response handler knows to show results
      autocompleteType = "file";
      // Show loading indicator while waiting for results
      showAutocomplete([{ id: "loading", name: "Searching files...", description: "" }], "file");
      // Request file suggestions from extension
      vscode.postMessage({ type: "suggestFiles", query: autocompletePrefix || "*" });
    } else {
      hideAutocomplete();
    }
  });

  promptInput.addEventListener("keydown", function(e) {
    if (autocompleteEl && autocompleteEl.style.display !== "none" && autocompleteItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); autocompleteIdx = Math.min(autocompleteIdx + 1, autocompleteItems.length - 1); highlightAcItem(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); autocompleteIdx = Math.max(autocompleteIdx - 1, 0); highlightAcItem(); return; }
      if (e.key === "Tab" || e.key === "Enter") {
        if (autocompleteIdx >= 0) { e.preventDefault(); selectAutocomplete(autocompleteIdx); return; }
        if (e.key === "Tab") { e.preventDefault(); selectAutocomplete(0); return; }
      }
      if (e.key === "Escape") { e.preventDefault(); hideAutocomplete(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function highlightAcItem() {
    if (!autocompleteEl) return;
    autocompleteEl.querySelectorAll(".ac-item").forEach(function(el, i) {
      el.classList.toggle("active", i === autocompleteIdx);
    });
  }

  sendBtn.addEventListener("click", function() { send(); });
  if ($("stopBtn")) $("stopBtn").addEventListener("click", function() { vscode.postMessage({ type: "stop" }); });
  if ($("regenBtn")) $("regenBtn").addEventListener("click", function() { vscode.postMessage({ type: "regenerate" }); });
  if ($("clearBtn")) $("clearBtn").addEventListener("click", function() { vscode.postMessage({ type: "clear" }); });
  if ($("attachBtn")) $("attachBtn").addEventListener("click", function() { vscode.postMessage({ type: "attachFiles" }); });
  if ($("attachSelBtn")) $("attachSelBtn").addEventListener("click", function() { vscode.postMessage({ type: "attachSelection" }); });
  if ($("refreshModels")) $("refreshModels").addEventListener("click", function() { vscode.postMessage({ type: "refreshModels" }); });
  if ($("settingsBtn")) $("settingsBtn").addEventListener("click", function() { vscode.postMessage({ type: "openSettings" }); });
  if ($("gitDiffBtn")) $("gitDiffBtn").addEventListener("click", function() { vscode.postMessage({ type: "attachGitDiff" }); });
  if ($("exportBtn")) $("exportBtn").addEventListener("click", function() {
    var choice = confirm("Export as Markdown? (Cancel for JSON)");
    vscode.postMessage({ type: choice ? "exportMarkdown" : "exportJson" });
  });
  if ($("newSessionBtn")) $("newSessionBtn").addEventListener("click", function() { vscode.postMessage({ type: "newSession" }); });
  if ($("compactBtn")) $("compactBtn").addEventListener("click", function() { vscode.postMessage({ type: "compactNow" }); });

  // --- Plan panel ---
  if ($("planBtn")) $("planBtn").addEventListener("click", function() {
    $("planPanel").classList.toggle("hidden");
    ["threadsPanel", "agentsPanel", "memoryPanel"].forEach(function(id) { if ($(id)) $(id).classList.add("hidden"); });
    if (!$("planPanel").classList.contains("hidden")) vscode.postMessage({ type: "getPlan" });
  });
  if ($("planClose")) $("planClose").addEventListener("click", function() { $("planPanel").classList.add("hidden"); });
  if ($("createPlanBtn")) $("createPlanBtn").addEventListener("click", function() {
    // Use inline input instead of prompt() which is blocked in webviews
    showInlineInput("Plan title:", function(title) {
      if (!title) return;
      showInlineInput("What's the goal?", function(goal) {
        vscode.postMessage({ type: "createPlan", title: title, goal: goal || "" });
      });
    });
  });

  // --- Memory panel ---
  if ($("memoryBtn")) $("memoryBtn").addEventListener("click", function() {
    $("memoryPanel").classList.toggle("hidden");
    ["threadsPanel", "agentsPanel", "planPanel"].forEach(function(id) { if ($(id)) $(id).classList.add("hidden"); });
    if (!$("memoryPanel").classList.contains("hidden")) vscode.postMessage({ type: "getMemories" });
  });
  if ($("memoryClose")) $("memoryClose").addEventListener("click", function() { $("memoryPanel").classList.add("hidden"); });
  if ($("addMemoryBtn")) $("addMemoryBtn").addEventListener("click", function() {
    showInlineInput("What should I remember?", function(content) {
      if (!content) return;
      vscode.postMessage({ type: "remember", content: content, category: "knowledge", tags: [] });
    });
  });

  /**
   * Inline input helper — replaces prompt() which doesn't work in webviews.
   * Shows a small input field at the bottom of the relevant panel.
   */
  function showInlineInput(placeholder, callback) {
    // Remove any existing inline input
    var existing = document.querySelector(".inline-input-wrap");
    if (existing) existing.remove();

    var wrap = document.createElement("div");
    wrap.className = "inline-input-wrap";
    wrap.innerHTML =
      '<input type="text" class="inline-input" placeholder="' + escapeHtml(placeholder) + '" />' +
      '<button type="button" class="btn primary inline-input-ok">OK</button>' +
      '<button type="button" class="btn secondary inline-input-cancel">✕</button>';

    var input = wrap.querySelector(".inline-input");
    var okBtn = wrap.querySelector(".inline-input-ok");
    var cancelBtn = wrap.querySelector(".inline-input-cancel");

    function submit() {
      var val = input.value.trim();
      wrap.remove();
      callback(val);
    }
    function cancel() {
      wrap.remove();
      callback(null);
    }

    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", cancel);
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") cancel();
    });

    // Insert into the visible panel or footer
    var visiblePanel = document.querySelector(".threads-panel:not(.hidden), .agents-panel:not(.hidden)") || $("composer");
    if (visiblePanel) {
      visiblePanel.appendChild(wrap);
    } else {
      document.body.appendChild(wrap);
    }
    input.focus();
  }

  modelCategory.addEventListener("change", function() { vscode.postMessage({ type: "setModel", category: modelCategory.value, modelId: modelSelect.value }); });
  modelSelect.addEventListener("change", function() { vscode.postMessage({ type: "setModel", category: modelCategory.value, modelId: modelSelect.value }); updateModelBadge(modelSelect.value); });

  thread.addEventListener("click", function(e) {
    var copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      var code = decodeURIComponent(copyBtn.getAttribute("data-code") || "");
      navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; setTimeout(function() { copyBtn.textContent = "Copy"; }, 1500);
      return;
    }
    var applyBtn = e.target.closest(".apply-btn");
    if (applyBtn) {
      var applyCode = decodeURIComponent(applyBtn.getAttribute("data-code") || "");
      var fileHint = decodeURIComponent(applyBtn.getAttribute("data-file") || "");
      if (!fileHint && state.activeFile) {
        // Default to the currently active file
        fileHint = state.activeFile;
      }
      if (!fileHint) {
        // Prompt user for file path
        var userPath = prompt("Enter file path to write to:");
        if (!userPath) return;
        fileHint = userPath;
      }
      vscode.postMessage({ type: "applyCode", filePath: fileHint, code: applyCode });
      applyBtn.textContent = "Applied!";
      applyBtn.disabled = true;
      setTimeout(function() { applyBtn.textContent = "Apply"; applyBtn.disabled = false; }, 2000);
    }
  });

  if ($("payloadCancel")) $("payloadCancel").addEventListener("click", function() { payloadModal.classList.add("hidden"); state.pending = null; });
  if ($("payloadConfirm")) $("payloadConfirm").addEventListener("click", function() {
    if (!state.pending) return; payloadModal.classList.add("hidden");
    vscode.postMessage({ type: "confirmPayload", prompt: state.pending.prompt, context: state.pending.context }); state.pending = null;
  });


  // --- Tool approval popup ---
  function showToolApproval(id, tool, args, description) {
    var card = document.createElement("div");
    card.className = "tool-approval-card";
    card.dataset.id = id;
    card.innerHTML =
      '<div class="tool-approval-header">🔧 Tool Request</div>' +
      '<div class="tool-approval-desc">' + escapeHtml(description) + '</div>' +
      '<div class="tool-approval-args"><code>' + escapeHtml(JSON.stringify(args, null, 2)) + '</code></div>' +
      '<div class="tool-approval-actions">' +
        '<button type="button" class="btn primary tool-approve-btn">✓ Approve</button>' +
        '<button type="button" class="btn secondary tool-deny-btn">✕ Deny</button>' +
      '</div>';
    card.querySelector(".tool-approve-btn").addEventListener("click", function() {
      vscode.postMessage({ type: "approveTool", tool: tool, args: args });
      card.remove();
    });
    card.querySelector(".tool-deny-btn").addEventListener("click", function() {
      vscode.postMessage({ type: "denyTool" });
      card.remove();
    });
    thread.appendChild(card);
    scrollBottom();
  }

  function appendToolResult(tool, output) {
    var row = document.createElement("div");
    row.className = "message tool-result";
    row.innerHTML =
      '<div class="avatar" style="background:#2d7d46;color:#fff;">⚡</div>' +
      '<div class="bubble"><div class="bubble-inner"><div class="tool-result-header">Tool: ' + escapeHtml(tool) + '</div>' +
      '<pre class="tool-result-output">' + escapeHtml((output || "").substring(0, 2000)) + '</pre></div></div>';
    thread.appendChild(row);
    scrollBottom();
  }

  function showBuiltinToolApproval(id, tool, args, category, description) {
    var card = document.createElement("div");
    card.className = "tool-approval-card";
    card.dataset.id = id;
    var icon = category === "write" ? "✏️" : "⚡";
    card.innerHTML =
      '<div class="tool-approval-header">' + icon + ' ' + escapeHtml(tool) + ' <span class="tool-category-badge tool-cat-' + category + '">' + category + '</span></div>' +
      '<div class="tool-approval-args"><code>' + escapeHtml(JSON.stringify(args, null, 2)) + '</code></div>' +
      '<div class="tool-approval-actions">' +
        '<button type="button" class="btn primary tool-approve-btn">✓ Approve</button>' +
        '<button type="button" class="btn secondary tool-deny-btn">✕ Deny</button>' +
      '</div>';
    card.querySelector(".tool-approve-btn").addEventListener("click", function() {
      vscode.postMessage({ type: "approveBuiltinTool", tool: tool, args: args });
      card.remove();
    });
    card.querySelector(".tool-deny-btn").addEventListener("click", function() {
      vscode.postMessage({ type: "denyBuiltinTool" });
      card.remove();
    });
    thread.appendChild(card);
    scrollBottom();
  }

  function appendToolExecuting(tool, args) {
    var row = document.createElement("div");
    row.className = "message tool-result tool-executing";
    var argStr = Object.entries(args || {}).map(function(e) { return e[0] + ": " + e[1]; }).join(", ");
    row.innerHTML =
      '<div class="avatar" style="background:#0e70c0;color:#fff;">🔧</div>' +
      '<div class="bubble"><div class="bubble-inner"><div class="tool-result-header">Running: ' + escapeHtml(tool) + '</div>' +
      '<div class="tool-executing-args">' + escapeHtml(argStr) + '</div>' +
      '<div class="typing-dots"><span></span><span></span><span></span></div></div></div>';
    thread.appendChild(row);
    scrollBottom();
  }

  function appendBuiltinToolResult(result) {
    // Remove the "executing" indicator
    var executing = thread.querySelector(".tool-executing");
    if (executing) executing.remove();

    var row = document.createElement("div");
    row.className = "message tool-result";
    var statusIcon = result.success ? "✅" : "❌";
    var outputText = (result.output || "").substring(0, 3000);
    row.innerHTML =
      '<div class="avatar" style="background:' + (result.success ? "#2d7d46" : "#7d2d2d") + ';color:#fff;">' + statusIcon + '</div>' +
      '<div class="bubble"><div class="bubble-inner"><div class="tool-result-header">' + escapeHtml(result.tool) + ' ' + (result.success ? "succeeded" : "failed") + '</div>' +
      '<pre class="tool-result-output">' + escapeHtml(outputText) + '</pre>' +
      (result.truncated ? '<div class="tool-truncated">(output truncated)</div>' : '') +
      '</div></div>';
    thread.appendChild(row);
    scrollBottom();
  }

  // --- Plan rendering ---
  function renderPlan(plan, allPlans) {
    var el = $("planContent"); if (!el) return;
    var html = "";

    // Show all plans list if there are multiple
    var plans = allPlans || [];
    if (!plan && plans.length > 0) {
      // No active plan but plans exist — show list to select from
      html += '<div style="font-size:11px;opacity:0.6;padding:4px 8px;margin-bottom:6px;">No active plan selected. Pick one:</div>';
      plans.forEach(function(p) {
        var taskCount = p.tasks ? p.tasks.length : 0;
        var doneCount = p.tasks ? p.tasks.filter(function(t) { return t.status === "done"; }).length : 0;
        html += '<div class="plan-select-item" data-plan-id="' + p.id + '" style="padding:6px 8px;border:1px solid var(--vscode-panel-border,#444);border-radius:6px;margin-bottom:4px;cursor:pointer;font-size:11px;">' +
          '<strong>' + escapeHtml(p.title) + '</strong> <span style="opacity:0.6;">(' + doneCount + '/' + taskCount + ' tasks done)</span>' +
          (p.goal ? '<div style="opacity:0.7;font-size:10px;margin-top:2px;">' + escapeHtml(p.goal) + '</div>' : '') +
          '</div>';
      });
      el.innerHTML = html;
      el.querySelectorAll(".plan-select-item").forEach(function(item) {
        item.addEventListener("click", function() {
          vscode.postMessage({ type: "setActivePlan", planId: item.dataset.planId });
        });
      });
      return;
    }

    if (!plan) {
      el.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;">No plans yet. Create one to start tracking your work.</div>';
      return;
    }

    // Show active plan
    var tasks = plan.tasks || [];
    var done = tasks.filter(function(t) { return t.status === "done"; }).length;
    html += '<div class="plan-title">' + escapeHtml(plan.title) + ' <span class="plan-progress">(' + done + '/' + tasks.length + ')</span></div>';
    if (plan.goal) html += '<div class="plan-goal" style="font-size:11px;opacity:0.7;margin-bottom:8px;">' + escapeHtml(plan.goal) + '</div>';

    if (tasks.length === 0) {
      html += '<div style="font-size:11px;opacity:0.6;padding:8px;">No tasks yet. Add tasks or use @planner to break down requirements.</div>';
    } else {
      html += '<div class="plan-tasks">';
      tasks.forEach(function(t) {
        var icon = t.status === "done" ? "✅" : t.status === "in-progress" ? "🔄" : t.status === "blocked" ? "🚫" : "⬜";
        var pts = t.storyPoints ? ' <span style="opacity:0.5;">(' + t.storyPoints + 'pts)</span>' : '';
        html += '<div class="plan-task" data-id="' + t.id + '">' +
          '<span class="plan-task-icon">' + icon + '</span>' +
          '<span class="plan-task-title">' + escapeHtml(t.title) + pts + '</span>' +
          '<select class="plan-task-status" data-task-id="' + t.id + '">' +
          '<option value="todo"' + (t.status === "todo" ? " selected" : "") + '>Todo</option>' +
          '<option value="in-progress"' + (t.status === "in-progress" ? " selected" : "") + '>In Progress</option>' +
          '<option value="done"' + (t.status === "done" ? " selected" : "") + '>Done</option>' +
          '<option value="blocked"' + (t.status === "blocked" ? " selected" : "") + '>Blocked</option>' +
          '</select></div>';
      });
      html += '</div>';
    }
    html += '<button type="button" class="btn secondary" id="addTaskBtn" style="width:100%;margin-top:6px;font-size:11px;">+ Add Task</button>';

    // Show other plans if there are more than one
    if (plans.length > 1) {
      html += '<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--vscode-panel-border,#444);font-size:10px;opacity:0.6;">Other plans: ';
      plans.filter(function(p) { return p.id !== plan.id; }).forEach(function(p, i) {
        if (i > 0) html += ', ';
        html += '<a href="#" class="plan-switch-link" data-plan-id="' + p.id + '" style="color:var(--vscode-textLink-foreground,#3794ff);cursor:pointer;">' + escapeHtml(p.title) + '</a>';
      });
      html += '</div>';
    }

    el.innerHTML = html;
    el.querySelectorAll(".plan-task-status").forEach(function(sel) {
      sel.addEventListener("change", function() {
        vscode.postMessage({ type: "updateTaskStatus", taskId: sel.dataset.taskId, status: sel.value });
      });
    });
    el.querySelectorAll(".plan-switch-link, .plan-select-item").forEach(function(link) {
      link.addEventListener("click", function(e) {
        e.preventDefault();
        vscode.postMessage({ type: "setActivePlan", planId: link.dataset.planId });
      });
    });
    if ($("addTaskBtn")) $("addTaskBtn").addEventListener("click", function() {
      showInlineInput("Task title:", function(title) {
        if (!title) return;
        vscode.postMessage({ type: "addPlanTask", title: title, description: "", priority: "medium" });
      });
    });
  }

  // --- Memory rendering ---
  function renderMemories(entries) {
    var el = $("memoryContent"); if (!el) return;
    if (!entries || !entries.length) {
      el.innerHTML = '<div style="font-size:11px;opacity:0.6;padding:8px;">No memories stored yet.</div>';
      return;
    }
    var html = '';
    entries.slice(-20).reverse().forEach(function(e) {
      var icon = e.category === "decision" ? "📌" : e.category === "preference" ? "⚙️" : e.category === "warning" ? "⚠️" : e.category === "pattern" ? "🔄" : "💡";
      html += '<div class="memory-item">' +
        '<span class="memory-icon">' + icon + '</span>' +
        '<span class="memory-text">' + escapeHtml(e.content) + '</span>' +
        '<button type="button" class="memory-forget" data-id="' + e.id + '" title="Forget">✕</button>' +
        '</div>';
    });
    el.innerHTML = html;
    el.querySelectorAll(".memory-forget").forEach(function(btn) {
      btn.addEventListener("click", function() {
        vscode.postMessage({ type: "forgetMemory", id: btn.dataset.id });
      });
    });
  }

  // --- Token stats ---
  function updateTokenBar(inputTokens, limit, utilization) {
    var bar = $("tokenBarFill");
    var label = $("tokenBarLabel");
    if (!bar || !label) return;
    var pct = Math.round(utilization * 100);
    bar.style.width = pct + "%";
    bar.className = "token-bar-fill" + (utilization > 0.9 ? " critical" : utilization > 0.7 ? " warning" : "");
    label.textContent = "~" + inputTokens + " / " + limit + " tokens (" + pct + "%)";
  }

  // --- Onboarding status ---
  function updateOnboarding(status, engine) {
    var el = $("onboardingStatus");
    var icon = $("onboardingIcon");
    var text = $("onboardingText");
    if (!el) return;
    var name = engine || "AI Engine";
    el.className = "onboarding-status " + status;
    if (status === "connected") {
      icon.textContent = "✓";
      text.textContent = name + " connected — ready to go!";
    } else if (status === "disconnected") {
      icon.textContent = "✕";
      text.textContent = "Cannot reach " + name + ". Make sure it's running.";
    } else {
      icon.textContent = "⏳";
      text.textContent = "Checking connection...";
    }
  }

  // --- Message handler ---
  window.addEventListener("message", function(event) {
    var msg = event.data; if (!msg || !msg.type) return;
    switch (msg.type) {
      case "init":
        state.settings = msg.settings || {};
        fillModels(msg.models, msg.selectedModel);
        if (modelCategory) modelCategory.value = msg.modelCategory || "chat";
        renderChips(msg.files);
        if (msg.mode) { state.mode = msg.mode; document.querySelectorAll(".mode-card").forEach(function(c) { c.classList.toggle("active", c.getAttribute("data-mode") === msg.mode); });
          if (modeBadge) { modeBadge.classList.remove("hidden"); modeIcon.textContent = msg.mode === "vibe" ? "🎨" : "🔄"; modeLabel.textContent = msg.mode === "vibe" ? "Vibe Mode" : "Agile Mode"; }
        } else if (modeBadge) { modeBadge.classList.add("hidden"); }
        if (msg.messages && msg.messages.length) { hideWelcome(); msg.messages.forEach(function(m) { appendMessage(m.role, m.content, { id: m.id, timestamp: m.timestamp, model: m.model }); }); }
        break;
      case "models": case "modelChanged":
        fillModels(msg.models || [], msg.selectedModel);
        if (msg.category && modelCategory) modelCategory.value = msg.category;
        updateModelBadge(msg.selectedModel); break;
      case "activeFile": updateActiveFile(msg.name); break;
      case "threads": renderThreads(msg.threads, msg.activeId); break;
      case "agents": state.agents = msg.agents || []; renderAgents(msg.agents); break;
      case "mcpServers": renderMcpServers(msg.servers); break;
      case "threadRestored":
        thread.querySelectorAll(".message").forEach(function(el) { el.remove(); });
        if (msg.messages && msg.messages.length) { hideWelcome(); msg.messages.forEach(function(m) { appendMessage(m.role, m.content, { id: m.id, timestamp: m.timestamp, model: m.model }); }); }
        else { showWelcome(); }
        if (msg.mode) { state.mode = msg.mode; if (modeBadge) { modeBadge.classList.remove("hidden"); modeIcon.textContent = msg.mode === "vibe" ? "🎨" : "🔄"; modeLabel.textContent = msg.mode === "vibe" ? "Vibe Mode" : "Agile Mode"; } }
        break;
      case "mcpSettingsUpdated": state.settings = Object.assign(state.settings, msg.settings); break;
      case "undone":
        // Re-render thread from remaining messages
        thread.querySelectorAll(".message").forEach(function(el) { el.remove(); });
        if (msg.messages && msg.messages.length) { hideWelcome(); msg.messages.forEach(function(m) { appendMessage(m.role, m.content, { id: m.id, timestamp: m.timestamp, model: m.model }); }); }
        else { showWelcome(); }
        // Show reverted files
        if (msg.reverted && msg.reverted.length) {
          var revertNote = document.createElement("div");
          revertNote.className = "stopped-indicator";
          revertNote.textContent = "↩ Files reverted: " + msg.reverted.join(", ");
          thread.appendChild(revertNote);
          scrollBottom();
        }
        setBusy(false);
        break;
      case "toolApproval":
        showToolApproval(msg.id, msg.tool, msg.args, msg.description);
        break;
      case "builtinToolApproval":
        showBuiltinToolApproval(msg.id, msg.tool, msg.args, msg.category, msg.description);
        break;
      case "toolExecuting":
        appendToolExecuting(msg.tool, msg.args);
        break;
      case "builtinToolResult":
        appendBuiltinToolResult(msg.result);
        break;
      case "builtinToolDenied":
        appendToolResult("denied", "Tool execution denied by user.");
        break;
      case "toolResult":
        appendToolResult(msg.tool, msg.output);
        break;
      case "toolDenied":
        appendToolResult("denied", "Tool execution denied by user.");
        break;
      case "regenerateStart": var as2 = thread.querySelectorAll(".message.assistant"); if (as2.length) as2[as2.length - 1].remove(); setBusy(true); break;
      case "payloadPreview": vscode.postMessage({ type: "confirmPayload", prompt: msg.payload.userPrompt, context: "" }); break;
      case "userMessage": appendMessage("user", msg.message.content, { id: msg.message.id, timestamp: msg.message.timestamp, files: msg.files }); setBusy(true); break;
      case "streamStart": state.streamingId = msg.id; appendMessage("assistant", "", { id: msg.id, streaming: true, model: msg.model }); setBusy(true); break;
      case "streamDelta": var elD = getStreamingBubble(msg.id); if (elD) { if (elD.querySelector(".typing-dots")) elD.innerHTML = ""; elD.innerHTML = formatMarkdown((elD.dataset.raw || "") + msg.chunk); elD.dataset.raw = (elD.dataset.raw || "") + msg.chunk; } scrollBottom(); break;
      case "streamEnd": var elE = getStreamingBubble(msg.id); if (elE) { elE.innerHTML = formatMarkdown(msg.message.content); delete elE.dataset.raw; } state.streamingId = null; setBusy(false); if (regenBtn) regenBtn.classList.remove("hidden"); break;
      case "error": var elErr = getStreamingBubble(msg.id); if (elErr) elErr.closest(".message").remove(); appendMessage("error", msg.text, { id: msg.id }); setBusy(false); break;
      case "stopped":
        // Add stopped indicator to the last streaming message
        if (state.streamingId) {
          var stoppedEl = getStreamingBubble(state.streamingId);
          if (stoppedEl) {
            var indicator = document.createElement("div");
            indicator.className = "stopped-indicator";
            indicator.textContent = "⏹ Generation stopped";
            stoppedEl.appendChild(indicator);
          }
          state.streamingId = null;
        }
        setBusy(false);
        break;
      case "tokenStats":
        updateTokenBar(msg.inputTokens, msg.limit, msg.utilization);
        break;
      case "gitDiffAttached":
        var diffChip = document.createElement("span");
        diffChip.className = "git-diff-chip";
        diffChip.textContent = "🔀 Git diff attached";
        fileChips.appendChild(diffChip);
        break;
      case "gitDiffEmpty":
        // No changes to attach
        break;
      case "healthStatus":
        updateOnboarding(msg.status, msg.engine);
        break;
      case "compacted":
        var compactNote = document.createElement("div");
        compactNote.className = "stopped-indicator";
        var freedText = msg.freedTokens ? " (~" + msg.freedTokens + " tokens freed)" : "";
        compactNote.textContent = "📦 " + msg.droppedCount + " older messages compacted" + freedText;
        thread.appendChild(compactNote);
        scrollBottom();
        break;
      case "compactSkipped":
        var skipNote = document.createElement("div");
        skipNote.className = "stopped-indicator";
        skipNote.textContent = "ℹ️ " + (msg.reason || "Nothing to compact");
        thread.appendChild(skipNote);
        scrollBottom();
        setTimeout(function() { skipNote.remove(); }, 3000);
        break;
      case "newSessionStarted":
        thread.querySelectorAll(".message, .tool-approval-card, .tool-result, .stopped-indicator").forEach(function(el) { el.remove(); });
        showWelcome(); setBusy(false);
        if (modeBadge) modeBadge.classList.add("hidden");
        state.mode = null;
        document.querySelectorAll(".mode-card").forEach(function(c) { c.classList.remove("active"); });
        renderChips([]);
        break;
      case "plan":
        renderPlan(msg.activePlan, msg.allPlans);
        break;
      case "memories":
        renderMemories(msg.entries);
        break;
      case "memoryAdded":
        // Brief feedback
        break;
      case "fileSuggestions":
        // Only show if we're still in file autocomplete mode
        if (autocompleteType === "file") {
          var fileResults = msg.files || [];
          if (fileResults.length > 0) {
            showAutocomplete(fileResults, "file");
          } else {
            showAutocomplete([{ id: "none", name: "No files found", description: "" }], "file");
          }
        }
        break;
      case "agentInvoked":
        // Show a brief indicator that an agent was activated
        var agentNote = document.createElement("div");
        agentNote.className = "stopped-indicator";
        agentNote.textContent = "🤖 " + (msg.agentName || msg.agentId) + " activated";
        thread.appendChild(agentNote);
        scrollBottom();
        break;
      case "cleared":
        thread.innerHTML = ""; if (welcome) { thread.appendChild(welcome); welcome.classList.remove("hidden"); }
        if (modeBadge) modeBadge.classList.add("hidden"); state.mode = null;
        document.querySelectorAll(".mode-card").forEach(function(c) { c.classList.remove("active"); });
        renderChips([]); setBusy(false); break;
      default: if (msg.files) renderChips(msg.files);
    }
  });

  autoResize();
  vscode.postMessage({ type: "ready" });
})();
