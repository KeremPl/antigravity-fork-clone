/**
 * Native Fork & Clone panel frontend (v2.1).
 *
 * - Chronological Git-graph timeline (#1 at top -> latest HEAD at bottom)
 *   mirroring the chat flow, with auto-scroll to HEAD and floating jump button.
 * - Live keep/cut hover preview: hovering "Fork here" or "Before"
 *   highlights all turns that will be preserved and dims turns that will be cut.
 * - Click any turn card to inspect full prompt, assistant reply, and tool calls.
 * - Persistent parent <-> child branch chips for 1-click jumping between forks.
 * - Built-in EN / TR i18n with instant toggle (defaults to EN for global builds).
 */
(() => {
  const POLL_MS = 1800;
  const $ = (id) => document.getElementById(id);

  const I18N = {
    en: {
      clone: 'Clone',
      cloneTip: 'Clone the entire conversation from its latest completed turn',
      searchPlaceholder: 'Search messages… (/)',
      sortChrono: 'Chronological',
      sortNewest: 'Newest first',
      sortTip: 'Toggle timeline order',
      titlePlaceholder: 'Branch title (optional)',
      autoOpen: 'Auto-open',
      autoOpenTip: 'Automatically open the newly forked/cloned conversation',
      jumpHeadTip: 'Jump to latest turn (HEAD)',
      emptyTitle: 'No turns yet',
      emptyDesc: 'Once this conversation has at least one completed turn, you can fork from any message or clone it here.',
      noMatches: 'No matching messages found.',
      turnsMeta: (turns, steps) => `${turns} ${turns === 1 ? 'turn' : 'turns'} · ${steps} ${steps === 1 ? 'step' : 'steps'}`,
      toolCount: (n) => `${n} ${n === 1 ? 'tool' : 'tools'}`,
      tokSuffix: 'tok',
      deltaTip: 'Tokens added to context in this turn',
      working: 'running…',
      forkHere: 'Fork here',
      forkHereTip: (n) => `Fork right after turn #${n}'s reply (keeps turns 1..${n})`,
      before: 'Before',
      beforeTip: (n) => `Fork right before turn #${n} (keeps turns 1..${n - 1} so you can rewrite #${n})`,
      details: 'Details',
      collapse: 'Hide',
      open: 'Open',
      backToParent: 'Parent',
      clonedFrom: 'Cloned from',
      forkedFromTurn: (n) => `Forked from #${n}`,
      forkedFrom: 'Forked from',
      switchBranchTip: (title) => `Open branch: ${title}`,
      creating: (title) => `Creating: ${title}…`,
      created: (title) => `Created: ${title}`,
      forkError: (msg) => `Fork failed: ${msg}`,
    },
    tr: {
      clone: 'Klonla',
      cloneTip: 'Mevcut sohbeti son tamamlanmış turundan birebir klonla',
      searchPlaceholder: 'Mesaj ara… (/)',
      sortChrono: 'Kronolojik',
      sortNewest: 'Yeniden eskiye',
      sortTip: 'Sıralamayı değiştir',
      titlePlaceholder: 'Yeni dal adı (isteğe bağlı)',
      autoOpen: 'Hemen aç',
      autoOpenTip: 'Fork veya klon oluşunca yeni sohbeti otomatik aç',
      jumpHeadTip: 'En son mesaja (HEAD) git',
      emptyTitle: 'Henüz mesaj yok',
      emptyDesc: 'Bu sohbette en az bir tamamlanmış tur olduğunda buradan istediğin mesajdan fork veya klon alabilirsin.',
      noMatches: 'Eşleşen mesaj bulunamadı.',
      turnsMeta: (turns, steps) => `${turns} tur · ${steps} adım`,
      toolCount: (n) => `${n} tool`,
      tokSuffix: 'tok',
      deltaTip: "Bu turun context'e eklediği token",
      working: 'çalışıyor…',
      forkHere: 'Buradan Forkla',
      forkHereTip: (n) => `Bu mesaj ve cevabından hemen sonrasını yeni sohbete forkla (1..${n})`,
      before: 'Öncesinden',
      beforeTip: (n) => `Bu mesajı çıkarıp #${n - 1}. turdan yeniden yazmak için öncesinden forkla`,
      details: 'Detay',
      collapse: 'Daralt',
      open: 'Aç',
      backToParent: 'Orijinale dön',
      clonedFrom: 'Klonlandı',
      forkedFromTurn: (n) => `#${n} turundan fork`,
      forkedFrom: 'Fork kaynağı',
      switchBranchTip: (title) => `Dal sohbetine geç: ${title}`,
      creating: (title) => `Oluşturuluyor: ${title}…`,
      created: (title) => `Oluşturuldu: ${title}`,
      forkError: (msg) => `Fork hatası: ${msg}`,
    },
  };

  function resolveInitialLang() {
    try {
      const saved = localStorage.getItem('fork_clone_lang');
      if (saved === 'en' || saved === 'tr') return saved;
    } catch {}
    return 'en';
  }

  const state = {
    lang: resolveInitialLang(),
    etag: '',
    snap: null,
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    newestFirst: false, // Chronological: #1 top -> latest HEAD bottom
    query: '',
    busyAction: false,
    expandedTurns: new Set(),
    stickBottom: true,
    didInitialScroll: false,
    timer: null,
  };

  const t = () => I18N[state.lang] || I18N.en;

  function applyStaticStrings() {
    const L = t();
    document.documentElement.lang = state.lang;
    $('lang-btn').textContent = state.lang.toUpperCase();
    $('clone-label').textContent = L.clone;
    $('clone-btn').title = L.cloneTip;
    $('search-input').placeholder = L.searchPlaceholder;
    $('sort-label').textContent = state.newestFirst ? L.sortNewest : L.sortChrono;
    $('sort-btn').title = L.sortTip;
    $('custom-title').placeholder = L.titlePlaceholder;
    $('auto-open-label').textContent = L.autoOpen;
    $('auto-open-wrap').title = L.autoOpenTip;
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

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function currentConvId() {
    return window.sidecar?.conversationId || state.fallbackConvId || '';
  }

  function openConversation(convId) {
    if (!convId) return;
    window.sidecar?.ui?.toggleConversation?.(convId);
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

  function scrollToHead(smooth = true) {
    const scroller = $('timeline-scroll');
    if (!scroller) return;
    const target = state.newestFirst ? 0 : scroller.scrollHeight;
    scroller.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateJumpButton() {
    const scroller = $('timeline-scroll');
    const btn = $('jump-head');
    if (!scroller || !btn) return;
    if (state.newestFirst) {
      const away = scroller.scrollTop > 120;
      btn.classList.toggle('hidden', !away);
      state.stickBottom = !away;
    } else {
      const distBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const away = distBottom > 120;
      btn.classList.toggle('hidden', !away);
      state.stickBottom = !away;
    }
  }

  // ---------- Hover Cut/Keep Visual Preview ----------
  function applyCutoffPreview(cutoffTurn) {
    document.querySelectorAll('.node-row[data-turn]').forEach((row) => {
      if (cutoffTurn === null) {
        row.classList.remove('preview-keep', 'preview-cut', 'preview-cutoff');
        return;
      }
      const n = Number(row.dataset.turn);
      if (n <= cutoffTurn) {
        row.classList.add('preview-keep');
        row.classList.remove('preview-cut');
        row.classList.toggle('preview-cutoff', n === cutoffTurn);
      } else {
        row.classList.add('preview-cut');
        row.classList.remove('preview-keep', 'preview-cutoff');
      }
    });
  }

  const FORK_ICON =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.5" cy="4" r="1.75"/><circle cx="11.5" cy="4" r="1.75"/><circle cx="8" cy="12" r="1.75"/><path d="M4.5 5.75v1.5c0 1.75 3.5 1.75 3.5 3M11.5 5.75v1.5c0 1.75-3.5 1.75-3.5 3"/></svg>';

  function renderParentCrumb(snap) {
    const el = $('parent-crumb');
    if (!el) return;
    const p = snap?.parent;
    if (!p || !p.parentId) {
      el.classList.add('hidden');
      return;
    }
    const L = t();
    const originTag =
      p.kind === 'clone' ? L.clonedFrom : p.turnNumber ? L.forkedFromTurn(p.turnNumber) : L.forkedFrom;
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
    const totalTurns = (snap.turns || []).length;
    let items = [...(snap.turns || [])];
    if (q) {
      items = items.filter(
        (item) =>
          (item.userFull || '').toLowerCase().includes(q) ||
          (item.replyFull || item.replyPreview || '').toLowerCase().includes(q) ||
          `#${item.turnNumber}`.includes(q)
      );
    }
    if (state.newestFirst) items.reverse();

    if (!items.length) {
      list.innerHTML = `<div class="empty-card"><p class="empty-desc">${esc(L.noMatches)}</p></div>`;
      return;
    }

    list.innerHTML = items
      .map((item) => {
        const isHead = item.turnNumber === totalTurns;
        const expanded = state.expandedTurns.has(item.turnNumber);
        const timeStr = fmtTime(item.createdAt);
        const tokStr = fmtTok(item.promptTokens);
        const deltaStr = item.tokenDelta >= 1000 ? `+${fmtTok(item.tokenDelta)}` : '';
        const heavyDelta = item.tokenDelta >= 25000;
        const toolStr = item.toolCount > 0 ? L.toolCount(item.toolCount) : '';
        const metaParts = [timeStr, tokStr ? `${tokStr} ${L.tokSuffix}` : '', toolStr].filter(Boolean);
        const branches = Array.isArray(item.branches) ? item.branches : [];
        const hasBranches = branches.length > 0;
        const disabledAttr = state.busyAction ? ' disabled' : '';

        const rowClasses = [
          'node-row',
          isHead ? 'is-head' : '',
          expanded ? 'expanded' : '',
          hasBranches ? 'has-branches' : '',
        ]
          .filter(Boolean)
          .join(' ');

        const toolsHtml =
          expanded && item.toolNames?.length
            ? `<div class="tool-chips">${item.toolNames.map((n) => `<span class="tool-chip">${esc(n)}</span>`).join('')}</div>`
            : '';

        const branchesHtml = hasBranches
          ? `<div class="branch-chips">${branches
              .map(
                (b) =>
                  `<button type="button" class="branch-chip" data-open-conv="${esc(b.childId)}" title="${esc(L.switchBranchTip(b.title))}">${FORK_ICON}<span>${esc(b.title)}</span></button>`
              )
              .join('')}</div>`
          : '';

        return `
          <div class="${rowClasses}" data-turn="${item.turnNumber}">
            <div class="rail" aria-hidden="true">
              <span class="rail-line top"></span>
              <span class="rail-dot"></span>
              <span class="rail-line bottom"></span>
            </div>
            <article class="node-card">
              <div class="node-top" data-toggle-turn="${item.turnNumber}">
                <div class="node-badges">
                  <span class="turn-num num">#${item.turnNumber}</span>
                  ${isHead ? '<span class="head-pill">HEAD</span>' : ''}
                  ${metaParts.map((m) => `<span class="meta-pill num">${esc(m)}</span>`).join('<span class="meta-pill">·</span>')}
                  ${deltaStr ? `<span class="delta-pill num${heavyDelta ? ' heavy' : ''}" title="${esc(L.deltaTip)}">(${esc(deltaStr)})</span>` : ''}
                  ${item.inProgress ? `<span class="meta-pill">${esc(L.working)}</span>` : ''}
                </div>
              </div>
              <div class="node-user" data-toggle-turn="${item.turnNumber}">${esc(expanded ? item.userFull || item.userPreview : item.userPreview)}</div>
              ${
                item.replyPreview
                  ? `<div class="node-reply" data-toggle-turn="${item.turnNumber}">${esc(expanded ? item.replyFull || item.replyPreview : item.replyPreview)}</div>`
                  : ''
              }
              ${toolsHtml}
              ${branchesHtml}
              <div class="node-actions">
                <button
                  type="button"
                  class="fork-btn"
                  data-fork-step="${item.endStepIndex}"
                  data-fork-turn="${item.turnNumber}"
                  data-preview-cutoff="${item.turnNumber}"
                  data-fork-label="Fork #${item.turnNumber}"
                  title="${esc(L.forkHereTip(item.turnNumber))}"
                  ${!item.canForkAfter || state.busyAction ? 'disabled' : ''}
                >
                  ${FORK_ICON}
                  <span>${esc(L.forkHere)}</span>
                </button>
                ${
                  item.canForkBefore
                    ? `<button
                        type="button"
                        class="fork-btn secondary"
                        data-fork-step="${item.forkBeforeStepIndex}"
                        data-fork-turn="${item.turnNumber - 1}"
                        data-preview-cutoff="${item.turnNumber - 1}"
                        data-fork-label="Before #${item.turnNumber}"
                        title="${esc(L.beforeTip(item.turnNumber))}"
                        ${disabledAttr}
                      >${esc(L.before)}</button>`
                    : ''
                }
                <button type="button" class="expand-hint" data-toggle-turn="${item.turnNumber}">
                  ${esc(expanded ? L.collapse : L.details)}
                </button>
              </div>
            </article>
          </div>
        `;
      })
      .join('');
  }

  function render(snap) {
    const prevTurnCount = state.snap?.turnCount || 0;
    const prevConv = state.snap?.conversationId || '';
    state.snap = snap;
    $('loading').classList.add('hidden');

    if (!snap || !snap.found || !snap.turns?.length) {
      $('panel').classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('panel').classList.remove('hidden');

    renderParentCrumb(snap);
    $('conv-title').textContent = snap.title || 'Untitled conversation';
    $('conv-title').title = `${snap.title || ''} (${snap.conversationId})`;
    $('conv-meta').textContent = t().turnsMeta(snap.turnCount, snap.totalSteps);

    const cloneBtn = $('clone-btn');
    cloneBtn.disabled = state.busyAction || snap.latestForkStepIndex < 0;

    renderTurns();

    const switchedConv = prevConv && prevConv !== snap.conversationId;
    const addedTurn = snap.turnCount > prevTurnCount;
    if (!state.didInitialScroll || switchedConv) {
      state.didInitialScroll = true;
      requestAnimationFrame(() => {
        scrollToHead(false);
        updateJumpButton();
      });
    } else if (addedTurn && state.stickBottom) {
      requestAnimationFrame(() => {
        scrollToHead(true);
        updateJumpButton();
      });
    } else {
      updateJumpButton();
    }
  }

  // ---------- Actions ----------
  async function executeFork(stepIndex, defaultSuffix, turnNumber = 0, kind = 'fork') {
    const conv = currentConvId();
    if (!conv || stepIndex < 0 || state.busyAction) return;

    const L = t();
    state.busyAction = true;
    applyCutoffPreview(null);
    $('clone-btn').disabled = true;
    renderTurns();

    const customInput = $('custom-title');
    const rawCustom = (customInput?.value || '').trim();
    const baseTitle = (state.snap?.title || 'Conversation').trim();
    const finalTitle = rawCustom || `${baseTitle} (${defaultSuffix})`;

    showToast('', L.creating(finalTitle));

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
          title: finalTitle,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (customInput) customInput.value = '';
      const createdTitle = data.title || finalTitle;
      showToast('ok', L.created(createdTitle), data.newCascadeId);

      state.etag = '';
      await poll(true);

      if ($('auto-open')?.checked) {
        openConversation(data.newCascadeId);
      }
    } catch (err) {
      showToast('err', L.forkError(err?.message || err));
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
  $('lang-btn').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'tr' : 'en';
    try {
      localStorage.setItem('fork_clone_lang', state.lang);
    } catch {}
    applyStaticStrings();
    if (state.snap) render(state.snap);
  });

  $('clone-btn').addEventListener('click', () => {
    if (!state.snap || state.snap.latestForkStepIndex < 0) return;
    executeFork(state.snap.latestForkStepIndex, 'Clone', state.snap.turnCount || 0, 'clone');
  });

  $('search-input').addEventListener('input', (e) => {
    state.query = e.target.value || '';
    renderTurns();
  });

  $('sort-btn').addEventListener('click', () => {
    state.newestFirst = !state.newestFirst;
    applyStaticStrings();
    renderTurns();
    requestAnimationFrame(() => {
      scrollToHead(false);
      updateJumpButton();
    });
  });

  $('jump-head').addEventListener('click', () => scrollToHead(true));
  $('timeline-scroll').addEventListener('scroll', updateJumpButton, { passive: true });

  document.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-preview-cutoff]');
    if (btn && !btn.disabled) {
      applyCutoffPreview(Number(btn.dataset.previewCutoff));
    } else if (!e.target.closest('.node-actions')) {
      applyCutoffPreview(null);
    }
  });
  document.addEventListener('mouseleave', () => applyCutoffPreview(null));

  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open-conv]');
    if (openBtn) {
      e.stopPropagation();
      openConversation(openBtn.dataset.openConv);
      return;
    }
    const forkBtn = e.target.closest('[data-fork-step]');
    if (forkBtn && !forkBtn.disabled) {
      e.stopPropagation();
      const stepIdx = Number(forkBtn.dataset.forkStep);
      const turnNum = Number(forkBtn.dataset.forkTurn) || 0;
      const label = forkBtn.dataset.forkLabel || 'Fork';
      executeFork(stepIdx, label, turnNum, 'fork');
      return;
    }
    const toggleEl = e.target.closest('[data-toggle-turn]');
    if (toggleEl) {
      const tn = Number(toggleEl.dataset.toggleTurn);
      if (state.expandedTurns.has(tn)) state.expandedTurns.delete(tn);
      else state.expandedTurns.add(tn);
      renderTurns();
    }
  });

  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (e.key === '/' && !isInput) {
      e.preventDefault();
      $('search-input')?.focus();
    } else if (e.key === 'Escape' && isInput && active.id === 'search-input') {
      $('search-input').value = '';
      state.query = '';
      $('search-input').blur();
      renderTurns();
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
