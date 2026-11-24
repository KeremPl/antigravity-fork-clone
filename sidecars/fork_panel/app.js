/**
 * Antigravity-native Mini-Chat Fork & Clone Panel (v3.0).
 *
 * - Mirrors Antigravity Desktop's real chat UI: right-aligned user bubbles +
 *   borderless Markdown-rendered AI replies + "Worked · N tools" disclosure.
 * - Single unambiguous "Fork" button beneath every completed AI response
 *   (Claude Code / Codex mental model — forks right after that AI reply,
 *   discarding everything below it).
 * - Hovering "Fork" renders a live horizontal cut divider and dims turns below.
 * - Optional inline rename (pencil icon) keeps the header minimal while still
 *   allowing custom branch titles when needed.
 * - Chat | Compact view toggle + EN / TR i18n + persistent parent <-> child
 *   branch chips.
 */
(() => {
  const POLL_MS = 1800;
  const $ = (id) => document.getElementById(id);

  const I18N = {
    en: {
      chat: 'Chat',
      compact: 'Compact',
      clone: 'Clone',
      cloneTip: 'Clone the entire conversation from its latest completed reply',
      searchPlaceholder: 'Search messages… (/)',
      autoOpen: 'Auto-open',
      autoOpenTip: 'Automatically open the newly forked/cloned conversation',
      latest: 'Latest',
      jumpHeadTip: 'Jump to latest message',
      emptyTitle: 'No messages yet',
      emptyDesc: 'Once the agent replies to at least one message, you can fork from any AI response or clone the conversation here.',
      noMatches: 'No matching messages found.',
      turnsMeta: (turns, steps) => `${turns} ${turns === 1 ? 'turn' : 'turns'} · ${steps} ${steps === 1 ? 'step' : 'steps'}`,
      worked: (n) => `Worked · ${n} ${n === 1 ? 'tool' : 'tools'}`,
      running: 'Generating response…',
      fork: 'Fork',
      forkTip: (n) => `Fork up to this AI response (keeps turns 1..${n})`,
      forkCutLabel: (n) => `✂ Fork cut — keeps turns 1..${n}`,
      renameTip: 'Fork with a custom title',
      renamePlaceholder: (def) => `Branch title (default: ${def})`,
      confirmFork: 'Fork',
      cancel: 'Cancel',
      showMore: 'Show full reply',
      showLess: 'Show less',
      open: 'Open',
      backToParent: 'Parent',
      clonedFrom: 'Cloned from',
      forkedFromTurn: (n) => `Forked from #${n}`,
      forkedFrom: 'Forked from',
      switchBranchTip: (title) => `Open branch: ${title}`,
      creating: (title) => `Creating: ${title}…`,
      created: (title) => `Created: ${title}`,
      forkError: (msg) => `Fork failed: ${msg}`,
      subagentNotice: (turn) =>
        turn > 0
          ? `Subagents used (from #${turn}) — Antigravity's native fork engine does not currently support chats that invoked subagents.`
          : `Subagents detected — Antigravity's native fork engine does not currently support chats that invoked subagents.`,
      subagentForkError: (turn) =>
        turn > 0
          ? `Native fork isn't supported by Antigravity for chats that invoked subagents (first used at #${turn}).`
          : `Native fork isn't supported by Antigravity for chats that invoked subagents.`,
      justNow: 'just now',
      minsAgo: (m) => `${m}m ago`,
      hoursAgo: (h) => `${h}h ago`,
      daysAgo: (d) => `${d}d ago`,
      ctxLabel: 'Context window:',
      ctxPct: (used, left) => `${used}% used (${left}% left)`,
      ctxTok: (used, limit) => `${used} / ${limit} tokens used`,
      ctxCache: (pct) => `Cache ${pct}%`,
    },
    tr: {
      chat: 'Sohbet',
      compact: 'Özet',
      clone: 'Klonla',
      cloneTip: 'Tüm sohbeti son tamamlanan yanıttan birebir klonla',
      searchPlaceholder: 'Mesajlarda ara… (/)',
      autoOpen: 'Hemen aç',
      autoOpenTip: 'Fork veya klon oluşunca yeni sohbeti otomatik aç',
      latest: 'En son',
      jumpHeadTip: 'En son mesaja git',
      emptyTitle: 'Henüz mesaj yok',
      emptyDesc: 'Ajan en az bir mesaja yanıt verdiğinde, istediğin AI yanıtının altından fork alabilir veya sohbeti klonlayabilirsin.',
      noMatches: 'Eşleşen mesaj bulunamadı.',
      turnsMeta: (turns, steps) => `${turns} tur · ${steps} adım`,
      worked: (n) => `Çalıştı · ${n} tool`,
      running: 'Yanıt oluşturuluyor…',
      fork: 'Fork',
      forkTip: (n) => `Bu AI yanıtına kadar forkla (1..${n} turları kalır, sonrası alınmaz)`,
      forkCutLabel: (n) => `✂ Kesim noktası — 1..${n} turları kalır`,
      renameTip: 'Özel başlıkla forkla',
      renamePlaceholder: (def) => `Dal adı (boşsa: ${def})`,
      confirmFork: 'Forkla',
      cancel: 'Vazgeç',
      showMore: 'Devamını göster',
      showLess: 'Daralt',
      open: 'Aç',
      backToParent: 'Orijinale dön',
      clonedFrom: 'Klonlandı',
      forkedFromTurn: (n) => `#${n} yanıtından fork`,
      forkedFrom: 'Fork kaynağı',
      switchBranchTip: (title) => `Dal sohbetine geç: ${title}`,
      creating: (title) => `Oluşturuluyor: ${title}…`,
      created: (title) => `Oluşturuldu: ${title}`,
      forkError: (msg) => `Fork hatası: ${msg}`,
      subagentNotice: (turn) =>
        turn > 0
          ? `Alt ajan algılandı (#${turn}+) — Antigravity'nin yerel fork motoru, alt ajan (subagent) kullanılan sohbetleri henüz desteklemiyor.`
          : `Alt ajan algılandı — Antigravity'nin yerel fork motoru, alt ajan (subagent) kullanılan sohbetleri henüz desteklemiyor.`,
      subagentForkError: (turn) =>
        turn > 0
          ? `Antigravity, alt ajan (subagent) çağrılan sohbetlerde yerel fork'u henüz desteklemiyor (ilk kullanım: #${turn}).`
          : `Antigravity, alt ajan (subagent) çağrılan sohbetlerde yerel fork'u henüz desteklemiyor.`,
      justNow: 'az önce',
      minsAgo: (m) => `${m}dk önce`,
      hoursAgo: (h) => `${h}s önce`,
      daysAgo: (d) => `${d}g önce`,
      ctxLabel: 'Bağlam penceresi:',
      ctxPct: (used, left) => `%${used} kullanıldı (%${left} kaldı)`,
      ctxTok: (used, limit) => `${used} / ${limit} token kullanıldı`,
      ctxCache: (pct) => `Cache %${pct}`,
    },
  };

  function readPref(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  const state = {
    lang: readPref('fork_clone_lang', 'en') === 'tr' ? 'tr' : 'en',
    viewMode: readPref('fork_clone_mode', 'chat') === 'compact' ? 'compact' : 'chat',
    etag: '',
    snap: null,
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    query: '',
    busyAction: false,
    expandedReplies: new Set(),
    expandedUsers: new Set(),
    expandedTools: new Set(),
    renamingTurn: null, // turnNumber currently showing inline rename input
    renameDraft: '',
    stickBottom: true,
    didInitialScroll: false,
    timer: null,
  };

  const t = () => I18N[state.lang] || I18N.en;

  function applyStaticStrings() {
    const L = t();
    document.documentElement.lang = state.lang;
    $('mode-chat').textContent = L.chat;
    $('mode-compact').textContent = L.compact;
    $('mode-chat').classList.toggle('on', state.viewMode === 'chat');
    $('mode-compact').classList.toggle('on', state.viewMode === 'compact');
    $('lang-btn').textContent = state.lang.toUpperCase();
    $('clone-label').textContent = L.clone;
    $('clone-btn').title = L.cloneTip;
    $('search-input').placeholder = L.searchPlaceholder;
    $('auto-open-label').textContent = L.autoOpen;
    $('auto-open-wrap').title = L.autoOpenTip;
    $('jump-label').textContent = L.latest;
    $('jump-head').title = L.jumpHeadTip;
    $('empty-title').textContent = L.emptyTitle;
    $('empty-desc').textContent = L.emptyDesc;
  }

  // ---------- Host Theme Sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (!v) return '';
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  function fmtRelTime(iso) {
    if (!iso) return '';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    const L = t();
    if (diffSec < 60) return L.justNow;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return L.minsAgo(mins);
    const hours = Math.floor(mins / 60);
    if (hours < 24) return L.hoursAgo(hours);
    const days = Math.floor(hours / 24);
    if (days < 14) return L.daysAgo(days);
    return new Date(ts).toLocaleDateString();
  }

  // Lightweight XSS-safe Markdown renderer matching Antigravity prose styling
  function formatInline(escaped) {
    let out = escaped;
    // Inline code first (protect with placeholders)
    const codes = [];
    out = out.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\x00CODE${codes.length - 1}\x00`;
    });
    // Markdown links [label](url) -> clean styled text (never navigates iframe)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<strong>$1</strong>');
    // Bold & italic
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Restore inline codes
    out = out.replace(/\x00CODE(\d+)\x00/g, (_, i) => codes[Number(i)] || '');
    return out;
  }

  function renderMarkdown(raw) {
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!text) return '';

    const blocks = [];
    const fenceRe = /```[a-zA-Z0-9_+#.-]*\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      if (m.index > last) blocks.push({ type: 'md', text: text.slice(last, m.index) });
      blocks.push({ type: 'code', text: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) blocks.push({ type: 'md', text: text.slice(last) });

    const htmlParts = [];
    for (const blk of blocks) {
      if (blk.type === 'code') {
        htmlParts.push(`<pre><code>${esc(blk.text.replace(/\n$/, ''))}</code></pre>`);
        continue;
      }
      const lines = blk.text.split('\n');
      let inUl = false;
      let inOl = false;
      let paraLines = [];

      const flushPara = () => {
        if (!paraLines.length) return;
        htmlParts.push(`<p>${formatInline(esc(paraLines.join('\n'))).replace(/\n/g, '<br>')}</p>`);
        paraLines = [];
      };
      const closeLists = () => {
        if (inUl) { htmlParts.push('</ul>'); inUl = false; }
        if (inOl) { htmlParts.push('</ol>'); inOl = false; }
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          flushPara();
          closeLists();
          continue;
        }
        if (/^-{3,}$|^\*{3,}$/.test(trimmed)) {
          flushPara();
          closeLists();
          htmlParts.push('<hr>');
          continue;
        }
        const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
          flushPara();
          closeLists();
          const lvl = hMatch[1].length;
          htmlParts.push(`<h${lvl}>${formatInline(esc(hMatch[2]))}</h${lvl}>`);
          continue;
        }
        const bqMatch = trimmed.match(/^>\s?(.*)$/);
        if (bqMatch) {
          flushPara();
          closeLists();
          htmlParts.push(`<blockquote>${formatInline(esc(bqMatch[1]))}</blockquote>`);
          continue;
        }
        const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
        if (ulMatch) {
          flushPara();
          if (inOl) { htmlParts.push('</ol>'); inOl = false; }
          if (!inUl) { htmlParts.push('<ul>'); inUl = true; }
          htmlParts.push(`<li>${formatInline(esc(ulMatch[1]))}</li>`);
          continue;
        }
        const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
          flushPara();
          if (inUl) { htmlParts.push('</ul>'); inUl = false; }
          if (!inOl) { htmlParts.push('<ol>'); inOl = true; }
          htmlParts.push(`<li>${formatInline(esc(olMatch[1]))}</li>`);
          continue;
        }
        closeLists();
        paraLines.push(line);
      }
      flushPara();
      closeLists();
    }
    return htmlParts.join('');
  }

  function currentConvId() {
    return window.sidecar?.conversationId || state.fallbackConvId || '';
  }

  function openConversation(convId) {
    if (!convId) return;
    window.sidecar?.ui?.toggleConversation?.(convId);
  }

  function hideToast() {
    const el = $('toast');
    if (!el) return;
    el.className = 'toast hidden';
    el.innerHTML = '';
  }

  function showToast(kind, text, openId = '') {
    const el = $('toast');
    if (!el) return;
    el.className = `toast ${kind}`;
    el.innerHTML = `
      <span class="toast-text">${esc(text)}</span>
      ${openId ? `<button type="button" class="ghost-btn" data-open-conv="${esc(openId)}">${esc(t().open)}</button>` : ''}
    `;
  }

  function closePanel() {
    try {
      window.sidecar?.ui?.toggleAuxPane?.({ open: false });
    } catch {}
  }

  function scrollToLatest(smooth = true) {
    const scroller = $('chat-scroll');
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateJumpButton() {
    const scroller = $('chat-scroll');
    const btn = $('jump-head');
    if (!scroller || !btn) return;
    const distBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const away = distBottom > 140;
    btn.classList.toggle('hidden', !away);
    state.stickBottom = !away;
  }

  // ---------- Hover Cut Preview ----------
  function applyCutoffPreview(cutoffTurn) {
    document.querySelectorAll('[data-turn-node]').forEach((el) => {
      if (cutoffTurn === null) {
        el.classList.remove('preview-cut', 'preview-cutoff');
        return;
      }
      const n = Number(el.dataset.turnNode);
      el.classList.toggle('preview-cut', n > cutoffTurn);
      el.classList.toggle('preview-cutoff', n === cutoffTurn);
    });
  }

  const FORK_ICON =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.5" cy="4" r="1.75"/><circle cx="11.5" cy="4" r="1.75"/><circle cx="8" cy="12" r="1.75"/><path d="M4.5 5.75v1.5c0 1.75 3.5 1.75 3.5 3M11.5 5.75v1.5c0 1.75-3.5 1.75-3.5 3"/></svg>';

  const PENCIL_ICON =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.7a1.5 1.5 0 0 1 2.1 2.1L5.8 12.4 2.5 13.5l1.1-3.3 7.7-7.5z"/></svg>';

  const CHEV_ICON =
    '<svg class="worked-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

  const WARN_ICON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 14 13H2L8 2.2Z"/><path d="M8 6.2v3.1M8 11.4h.01"/></svg>';

  function formatModelLabel(slug) {
    const raw = String(slug || '').trim();
    if (!raw) return '';
    // Format slugs like "gemini-4-neon-high" -> "Gemini 4 Neon (High)", "claude-opus-5-5-high" -> "Claude Opus 5.5 (High)"
    const parts = raw.split('-').filter(Boolean);
    const tiers = new Set(['low', 'medium', 'high', 'max', 'thinking']);
    let tier = '';
    if (parts.length > 1 && tiers.has(parts[parts.length - 1].toLowerCase())) {
      const tWord = parts.pop();
      tier = tWord.charAt(0).toUpperCase() + tWord.slice(1).toLowerCase();
    }
    const merged = [];
    for (let i = 0; i < parts.length; i++) {
      const cur = parts[i];
      if (/^\d{1,2}$/.test(cur) && i + 1 < parts.length && /^\d{1,2}$/.test(parts[i + 1])) {
        merged.push(`${cur}.${parts[i + 1]}`);
        i += 1;
      } else if (/^gpt$/i.test(cur)) {
        merged.push('GPT');
      } else if (/^oss$/i.test(cur)) {
        merged.push('OSS');
      } else {
        merged.push(cur.charAt(0).toUpperCase() + cur.slice(1));
      }
    }
    const base = merged.join(' ');
    return tier ? `${base} (${tier})` : base;
  }

  function renderContextRing(snap) {
    const wrap = $('ctx-ring-wrap');
    const arc = $('ctx-ring-arc');
    if (!wrap || !arc) return;
    const ctx = snap?.context;
    if (!ctx || !ctx.contextLimit || !ctx.usedTokens) {
      wrap.classList.add('hidden');
      return;
    }

    wrap.classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, Number(ctx.usedPercent) || 0));
    const usedRound = pct > 0 ? Math.max(1, Math.round(pct)) : 0;
    const leftPct = Math.max(0, 100 - usedRound);

    const circumference = 2 * Math.PI * 7.5; // 47.1239
    const visibleFrac = pct > 0 ? Math.max(0.03, pct / 100) : 0;
    arc.style.strokeDasharray = circumference.toFixed(2);
    arc.style.strokeDashoffset = (circumference * (1 - visibleFrac)).toFixed(2);
    arc.classList.toggle('mid', pct >= 60 && pct < 85);
    arc.classList.toggle('high', pct >= 85);

    const L = t();
    const locale = state.lang === 'tr' ? 'tr-TR' : 'en-US';
    const usedFmt = Number(ctx.usedTokens).toLocaleString(locale);
    const limitFmt = Number(ctx.contextLimit).toLocaleString(locale);

    $('ctx-pop-label').textContent = L.ctxLabel;
    $('ctx-pop-pct').textContent = L.ctxPct(usedRound, leftPct);
    $('ctx-pop-tok').textContent = L.ctxTok(usedFmt, limitFmt);

    const subParts = [];
    if (ctx.cacheHitRatio > 0) subParts.push(L.ctxCache(ctx.cacheHitRatio));
    const modelLabel = formatModelLabel(ctx.model);
    if (modelLabel) subParts.push(modelLabel);
    const subEl = $('ctx-pop-sub');
    if (subParts.length) {
      subEl.textContent = subParts.join(' · ');
      subEl.classList.remove('hidden');
    } else {
      subEl.classList.add('hidden');
    }
    clampContextPopover();
  }

  function clampContextPopover() {
    const pop = $('ctx-popover');
    if (!pop) return;
    pop.style.setProperty('--ctx-pop-shift', '0px');
    const rect = pop.getBoundingClientRect();
    if (!rect.width) return;
    const pad = 8;
    let shift = 0;
    if (rect.right > window.innerWidth - pad) {
      shift = window.innerWidth - pad - rect.right;
    } else if (rect.left < pad) {
      shift = pad - rect.left;
    }
    if (shift !== 0) {
      pop.style.setProperty('--ctx-pop-shift', `${Math.round(shift)}px`);
    }
  }

  function renderSubagentNotice(snap) {
    const el = $('subagent-notice');
    if (!el) return;
    if (!snap?.hasSubagents) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = `${WARN_ICON}<span>${esc(t().subagentNotice(snap.firstSubagentTurn || 0))}</span>`;
  }

  function renderParentCrumb(snap) {
    const el = $('parent-crumb');
    if (!el) return;
    const p = snap?.parent;
    if (!p || !p.parentId || p.kind === 'clone') {
      el.classList.add('hidden');
      return;
    }
    const L = t();
    const originTag = p.turnNumber ? L.forkedFromTurn(p.turnNumber) : L.forkedFrom;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="parent-crumb-left">
        <span>↖ ${esc(originTag)}:</span>
        <span class="parent-crumb-title" title="${esc(p.parentTitle)}">${esc(p.parentTitle)}</span>
      </div>
      <button type="button" class="ghost-btn" data-open-conv="${esc(p.parentId)}">${esc(L.backToParent)}</button>
    `;
  }

  function renderTurns() {
    const snap = state.snap;
    const list = $('turns-list');
    if (!snap || !list) return;

    const L = t();
    const q = state.query.trim().toLowerCase();
    let items = [...(snap.turns || [])];
    if (q) {
      items = items.filter(
        (item) =>
          (item.userFull || '').toLowerCase().includes(q) ||
          (item.replyFull || item.replyPreview || '').toLowerCase().includes(q) ||
          `#${item.turnNumber}`.includes(q)
      );
    }

    list.classList.toggle('compact', state.viewMode === 'compact');

    if (!items.length) {
      list.innerHTML = `<div class="empty-card"><p class="empty-desc">${esc(L.noMatches)}</p></div>`;
      return;
    }

    if (state.viewMode === 'compact') {
      list.innerHTML = items
        .map((item) => {
          const disabled = !item.canForkAfter || state.busyAction ? 'disabled' : '';
          return `
            <div class="compact-row" data-turn-node="${item.turnNumber}">
              <span class="compact-num num">#${item.turnNumber}</span>
              <div class="compact-body" data-jump-chat="${item.turnNumber}" title="Open in Chat view">
                <span class="compact-user">${esc(item.userPreview)}</span>
                <span class="compact-ai">${esc(item.replyPreview || (item.inProgress ? L.running : ''))}</span>
              </div>
              <div class="compact-actions">
                <button
                  type="button"
                  class="fork-action"
                  data-fork-step="${item.endStepIndex}"
                  data-fork-turn="${item.turnNumber}"
                  data-preview-cutoff="${item.turnNumber}"
                  title="${esc(L.forkTip(item.turnNumber))}"
                  ${disabled}
                >
                  ${FORK_ICON}
                  <span>${esc(L.fork)}</span>
                </button>
              </div>
            </div>
          `;
        })
        .join('');
      return;
    }

    const prevRenameInput = document.activeElement?.classList?.contains('rename-input')
      ? document.activeElement
      : null;
    const prevSelStart = prevRenameInput?.selectionStart ?? null;
    const prevSelEnd = prevRenameInput?.selectionEnd ?? null;

    // CHAT MODE — authentic Antigravity conversation mirror
    list.innerHTML = items
      .map((item) => {
        const userText = item.userFull || item.userPreview || '';
        const longUser = userText.length > 320 || (userText.match(/\n/g) || []).length >= 5;
        const userExpanded = state.expandedUsers.has(item.turnNumber);

        const replyText = item.replyFull || item.replyPreview || '';
        const longReply = replyText.length > 560 || (replyText.match(/\n/g) || []).length >= 9;
        const replyExpanded = state.expandedReplies.has(item.turnNumber);
        const toolsExpanded = state.expandedTools.has(item.turnNumber);
        const isRenaming = state.renamingTurn === item.turnNumber;

        const relTime = fmtRelTime(item.replyAt || item.createdAt);
        const deltaStr = item.tokenDelta >= 1000 ? `+${fmtTok(item.tokenDelta)} tok` : '';
        const heavyDelta = item.tokenDelta >= 25000;
        const branches = Array.isArray(item.branches) ? item.branches : [];
        const canFork = item.canForkAfter && !state.busyAction;
        const defTitle = `${(snap.title || 'Conversation').trim()} (1)`;

        const workedHtml =
          item.toolCount > 0
            ? `
              <button type="button" class="worked-btn" data-toggle-tools="${item.turnNumber}" aria-expanded="${toolsExpanded ? 'true' : 'false'}">
                <span>${esc(L.worked(item.toolCount))}</span>
                ${CHEV_ICON}
              </button>
              ${
                toolsExpanded && item.toolNames?.length
                  ? `<div class="tool-drawer">${item.toolNames.map((n) => `<span class="tool-chip">${esc(n)}</span>`).join('')}</div>`
                  : ''
              }
            `
            : '';

        const proseHtml = replyText
          ? `
            <div class="ai-prose-wrap${longReply && !replyExpanded ? ' clamped' : ''}">
              <div class="ai-prose">${renderMarkdown(replyText)}</div>
            </div>
            ${
              longReply
                ? `<button type="button" class="more-btn" data-toggle-reply="${item.turnNumber}">${esc(replyExpanded ? L.showLess : L.showMore)}</button>`
                : ''
            }
          `
          : item.inProgress
            ? `<div class="ai-pending">${esc(L.running)}</div>`
            : '';

        const renameHtml = isRenaming
          ? `
            <form class="inline-rename" data-rename-form="${item.turnNumber}" data-fork-step="${item.endStepIndex}">
              <input type="text" class="rename-input" value="${esc(state.renameDraft)}" placeholder="${esc(L.renamePlaceholder(defTitle))}" autocomplete="off">
              <button type="submit" class="primary-btn">${esc(L.confirmFork)}</button>
              <button type="button" class="ghost-btn" data-cancel-rename="1">${esc(L.cancel)}</button>
            </form>
          `
          : '';

        const branchesHtml = branches.length
          ? `<div class="branch-chips">${branches
              .map(
                (b) =>
                  `<button type="button" class="branch-chip" data-open-conv="${esc(b.childId)}" title="${esc(L.switchBranchTip(b.title))}">${FORK_ICON}<span>${esc(b.title)}</span></button>`
              )
              .join('')}</div>`
          : '';

        return `
          <section class="exchange" data-turn-node="${item.turnNumber}">
            <div class="user-row">
              <div class="user-bubble${longUser && !userExpanded ? ' clamped' : ''}" data-toggle-user="${item.turnNumber}"><span class="user-text">${esc(userText)}</span></div>
            </div>

            <div class="ai-block">
              ${workedHtml}
              ${proseHtml}

              ${
                item.canForkAfter
                  ? `
                    <div class="ai-footer">
                      <button
                        type="button"
                        class="fork-action"
                        data-fork-step="${item.endStepIndex}"
                        data-fork-turn="${item.turnNumber}"
                        data-preview-cutoff="${item.turnNumber}"
                        title="${esc(L.forkTip(item.turnNumber))}"
                        ${canFork ? '' : 'disabled'}
                      >
                        ${FORK_ICON}
                        <span>${esc(L.fork)}</span>
                      </button>
                      <button
                        type="button"
                        class="rename-toggle${isRenaming ? ' active' : ''}"
                        data-open-rename="${item.turnNumber}"
                        data-preview-cutoff="${item.turnNumber}"
                        title="${esc(L.renameTip)}"
                        ${canFork ? '' : 'disabled'}
                      >${PENCIL_ICON}</button>
                      ${relTime ? `<span class="footer-meta num">${esc(relTime)}</span>` : ''}
                      ${deltaStr ? `<span class="footer-meta num${heavyDelta ? ' heavy' : ''}">· ${esc(deltaStr)}</span>` : ''}
                    </div>
                  `
                  : ''
              }

              ${renameHtml}
              ${branchesHtml}
            </div>

            <div class="cut-divider" aria-hidden="true">
              <span class="cut-line"></span>
              <span class="cut-label">${esc(L.forkCutLabel(item.turnNumber))}</span>
              <span class="cut-line"></span>
            </div>
          </section>
        `;
      })
      .join('');

    if (state.renamingTurn !== null) {
      const inp = list.querySelector('.rename-input');
      if (inp) {
        inp.focus();
        if (prevSelStart !== null && prevSelEnd !== null) {
          try { inp.setSelectionRange(prevSelStart, prevSelEnd); } catch {}
        } else {
          const end = inp.value.length;
          try { inp.setSelectionRange(end, end); } catch {}
        }
      }
    }
  }

  function render(snap) {
    const prevTurnCount = state.snap?.turnCount || 0;
    const prevConv = state.snap?.conversationId || '';
    const switchedConv = Boolean(prevConv && snap?.conversationId && prevConv !== snap.conversationId);
    state.snap = snap;
    $('loading').classList.add('hidden');

    if (switchedConv) {
      hideToast();
      state.renamingTurn = null;
      state.renameDraft = '';
      state.expandedReplies.clear();
      state.expandedUsers.clear();
      state.expandedTools.clear();
    }

    if (!snap || !snap.found || !snap.turns?.length) {
      $('panel').classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('panel').classList.remove('hidden');

    renderParentCrumb(snap);
    renderSubagentNotice(snap);
    renderContextRing(snap);
    $('conv-title').textContent = snap.title || 'Untitled conversation';
    $('conv-title').title = `${snap.title || ''} (${snap.conversationId})`;
    $('conv-meta').textContent = t().turnsMeta(snap.turnCount, snap.totalSteps);

    $('clone-btn').disabled = state.busyAction || snap.latestForkStepIndex < 0;

    renderTurns();

    const addedTurn = snap.turnCount > prevTurnCount;
    if (!state.didInitialScroll || switchedConv) {
      state.didInitialScroll = true;
      requestAnimationFrame(() => {
        scrollToLatest(false);
        updateJumpButton();
      });
    } else if (addedTurn && state.stickBottom) {
      requestAnimationFrame(() => {
        scrollToLatest(true);
        updateJumpButton();
      });
    } else {
      updateJumpButton();
    }
  }

  // ---------- Actions ----------
  async function executeFork(stepIndex, turnNumber = 0, kind = 'fork', explicitTitle = '') {
    const conv = currentConvId();
    if (!conv || stepIndex < 0 || state.busyAction) return;

    const L = t();
    state.busyAction = true;
    state.renamingTurn = null;
    state.renameDraft = '';
    applyCutoffPreview(null);
    $('clone-btn').disabled = true;
    renderTurns();

    const customTitle = (explicitTitle || '').trim();
    const pendingLabel = customTitle || (state.snap?.title || 'Conversation').trim();
    showToast('', L.creating(pendingLabel));

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f('/api/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conv,
          stepIndex,
          turnNumber,
          kind,
          title: customTitle,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.errorCode = data.errorCode || '';
        throw err;
      }

      const createdTitle = data.title || pendingLabel;
      const shouldOpen = kind === 'clone' || $('auto-open')?.checked;

      state.etag = '';
      await poll(true);

      if (shouldOpen) {
        hideToast();
        openConversation(data.newCascadeId);
        if (kind === 'clone') {
          setTimeout(closePanel, 120);
        }
      } else {
        showToast('ok', L.created(createdTitle), data.newCascadeId);
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (err?.errorCode === 'SUBAGENT_UNSUPPORTED' || /subagent/i.test(msg)) {
        showToast('err', L.subagentForkError(state.snap?.firstSubagentTurn || 0));
      } else {
        showToast('err', L.forkError(msg));
      }
    } finally {
      state.busyAction = false;
      if (state.snap) render(state.snap);
    }
  }

  // ---------- Polling ----------
  async function poll(force = false) {
    const conv = currentConvId();
    const qs = new URLSearchParams();
    if (conv) qs.set('conversationId', conv);
    if (!force && state.etag) qs.set('etag', state.etag);

    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/turns?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch {
      // ignore transient reconnect errors
    }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 6000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedulePoll();
    }, delay);
  }

  // ---------- Events ----------
  $('mode-chat').addEventListener('click', () => {
    if (state.viewMode === 'chat') return;
    state.viewMode = 'chat';
    try { localStorage.setItem('fork_clone_mode', 'chat'); } catch {}
    applyStaticStrings();
    renderTurns();
    requestAnimationFrame(() => { scrollToLatest(false); updateJumpButton(); });
  });

  $('mode-compact').addEventListener('click', () => {
    if (state.viewMode === 'compact') return;
    state.viewMode = 'compact';
    try { localStorage.setItem('fork_clone_mode', 'compact'); } catch {}
    applyStaticStrings();
    renderTurns();
    requestAnimationFrame(() => { scrollToLatest(false); updateJumpButton(); });
  });

  $('lang-btn').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'tr' : 'en';
    try { localStorage.setItem('fork_clone_lang', state.lang); } catch {}
    applyStaticStrings();
    if (state.snap) render(state.snap);
  });

  $('clone-btn').addEventListener('click', () => {
    if (!state.snap || state.snap.latestForkStepIndex < 0) return;
    executeFork(state.snap.latestForkStepIndex, state.snap.turnCount || 0, 'clone');
  });

  $('search-input').addEventListener('input', (e) => {
    state.query = e.target.value || '';
    renderTurns();
  });

  $('jump-head').addEventListener('click', () => scrollToLatest(true));
  $('chat-scroll').addEventListener('scroll', updateJumpButton, { passive: true });
  $('ctx-ring-wrap')?.addEventListener('mouseenter', clampContextPopover);
  $('ctx-ring-wrap')?.addEventListener('focusin', clampContextPopover);
  window.addEventListener('resize', clampContextPopover, { passive: true });

  document.addEventListener('input', (e) => {
    if (e.target.classList?.contains('rename-input')) {
      state.renameDraft = e.target.value || '';
    }
  });

  document.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-preview-cutoff]');
    if (btn && !btn.disabled) {
      applyCutoffPreview(Number(btn.dataset.previewCutoff));
    } else if (!e.target.closest('.ai-footer') && !e.target.closest('.compact-actions')) {
      applyCutoffPreview(null);
    }
  });
  document.addEventListener('mouseleave', () => applyCutoffPreview(null));

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-rename-form]');
    if (!form) return;
    e.preventDefault();
    const tn = Number(form.dataset.renameForm);
    const stepIdx = Number(form.dataset.forkStep);
    const customTitle = (form.querySelector('.rename-input')?.value || '').trim();
    executeFork(stepIdx, tn, 'fork', customTitle);
  });

  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open-conv]');
    if (openBtn) {
      e.stopPropagation();
      openConversation(openBtn.dataset.openConv);
      return;
    }
    const forkBtn = e.target.closest('[data-fork-step]:not(form)');
    if (forkBtn && !forkBtn.disabled) {
      e.stopPropagation();
      const stepIdx = Number(forkBtn.dataset.forkStep);
      const tn = Number(forkBtn.dataset.forkTurn) || 0;
      executeFork(stepIdx, tn, 'fork');
      return;
    }
    const renameBtn = e.target.closest('[data-open-rename]');
    if (renameBtn && !renameBtn.disabled) {
      e.stopPropagation();
      const tn = Number(renameBtn.dataset.openRename);
      state.renamingTurn = state.renamingTurn === tn ? null : tn;
      state.renameDraft = '';
      renderTurns();
      return;
    }
    if (e.target.closest('[data-cancel-rename]')) {
      state.renamingTurn = null;
      state.renameDraft = '';
      renderTurns();
      return;
    }
    const toolsBtn = e.target.closest('[data-toggle-tools]');
    if (toolsBtn) {
      const tn = Number(toolsBtn.dataset.toggleTools);
      if (state.expandedTools.has(tn)) state.expandedTools.delete(tn);
      else state.expandedTools.add(tn);
      renderTurns();
      return;
    }
    const replyBtn = e.target.closest('[data-toggle-reply]');
    if (replyBtn) {
      const tn = Number(replyBtn.dataset.toggleReply);
      if (state.expandedReplies.has(tn)) state.expandedReplies.delete(tn);
      else state.expandedReplies.add(tn);
      renderTurns();
      return;
    }
    const userBubble = e.target.closest('[data-toggle-user]');
    if (userBubble && userBubble.classList.contains('clamped')) {
      state.expandedUsers.add(Number(userBubble.dataset.toggleUser));
      renderTurns();
      return;
    }
    const jumpChat = e.target.closest('[data-jump-chat]');
    if (jumpChat) {
      const tn = Number(jumpChat.dataset.jumpChat);
      state.viewMode = 'chat';
      try { localStorage.setItem('fork_clone_mode', 'chat'); } catch {}
      applyStaticStrings();
      renderTurns();
      requestAnimationFrame(() => {
        const targetEl = document.querySelector(`.exchange[data-turn-node="${tn}"]`);
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        updateJumpButton();
      });
    }
  });

  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (e.key === '/' && !isInput) {
      e.preventDefault();
      $('search-input')?.focus();
    } else if (e.key === 'Escape') {
      if (state.renamingTurn !== null) {
        state.renamingTurn = null;
        state.renameDraft = '';
        renderTurns();
      } else if (isInput && active.id === 'search-input') {
        $('search-input').value = '';
        state.query = '';
        $('search-input').blur();
        renderTurns();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll(false);
    schedulePoll();
  });

  // Boot
  applyStaticStrings();
  (async () => {
    await poll(true);
    schedulePoll();
  })();
})();
