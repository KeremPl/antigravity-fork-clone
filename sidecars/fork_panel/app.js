/**
 * Native Fork & Clone panel frontend (v2.0).
 *
 * - Chronological Git-graph timeline (#1 at top -> latest HEAD at bottom)
 *   mirroring the chat flow, with auto-scroll to HEAD and floating jump button.
 * - Live keep/cut hover preview: hovering "Buradan Forkla" or "Öncesinden"
 *   highlights all turns that will be preserved and dims turns that will be cut.
 * - Click any turn card to inspect full prompt, assistant reply, and tool calls.
 * - Persistent parent <-> child branch chips for 1-click jumping between forks.
 */
(() => {
  const POLL_MS = 1800;
  const $ = (id) => document.getElementById(id);

  const state = {
    etag: '',
    snap: null,
    fallbackConvId: new URLSearchParams(location.search).get('conversationId') || '',
    newestFirst: false, // Default chronological: #1 top -> latest HEAD bottom
    query: '',
    busyAction: false,
    expandedTurns: new Set(),
    stickBottom: true,
    didInitialScroll: false,
    timer: null,
  };

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
      ${openId ? `<button type="button" class="ghost-btn" data-open-conv="${esc(openId)}">Aç</button>` : ''}
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
      const t = Number(row.dataset.turn);
      if (t <= cutoffTurn) {
        row.classList.add('preview-keep');
        row.classList.remove('preview-cut');
        row.classList.toggle('preview-cutoff', t === cutoffTurn);
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
    const originTag = p.kind === 'clone' ? 'Cloned from' : p.turnNumber ? `Forked from #${p.turnNumber}` : 'Forked from';
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="parent-crumb-left">
        <span>↖ ${esc(originTag)}:</span>
        <span class="parent-crumb-title" title="${esc(p.parentTitle)}">${esc(p.parentTitle)}</span>
      </div>
      <button type="button" class="ghost-btn" data-open-conv="${esc(p.parentId)}">Orijinale dön</button>
    `;
  }

  function renderTurns() {
    const snap = state.snap;
    const list = $('turns-list');
    if (!snap || !list) return;

    const q = state.query.trim().toLowerCase();
    const totalTurns = (snap.turns || []).length;
    let items = [...(snap.turns || [])];
    if (q) {
      items = items.filter(
        (t) =>
          (t.userFull || '').toLowerCase().includes(q) ||
          (t.replyFull || t.replyPreview || '').toLowerCase().includes(q) ||
          `#${t.turnNumber}`.includes(q)
      );
    }
    if (state.newestFirst) items.reverse();

    if (!items.length) {
      list.innerHTML = '<div class="empty-card"><p class="empty-desc">Eşleşen mesaj bulunamadı.</p></div>';
      return;
    }

    list.innerHTML = items
      .map((t) => {
        const isHead = t.turnNumber === totalTurns;
        const expanded = state.expandedTurns.has(t.turnNumber);
        const timeStr = fmtTime(t.createdAt);
        const tokStr = fmtTok(t.promptTokens);
        const deltaStr = t.tokenDelta >= 1000 ? `+${fmtTok(t.tokenDelta)}` : '';
        const heavyDelta = t.tokenDelta >= 25000;
        const toolStr = t.toolCount > 0 ? `${t.toolCount} tool` : '';
        const metaParts = [timeStr, tokStr ? `${tokStr} tok` : '', toolStr].filter(Boolean);
        const branches = Array.isArray(t.branches) ? t.branches : [];
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
          expanded && t.toolNames?.length
            ? `<div class="tool-chips">${t.toolNames.map((n) => `<span class="tool-chip">${esc(n)}</span>`).join('')}</div>`
            : '';

        const branchesHtml = hasBranches
          ? `<div class="branch-chips">${branches
              .map(
                (b) =>
                  `<button type="button" class="branch-chip" data-open-conv="${esc(b.childId)}" title="Dal sohbetine geç: ${esc(b.title)}">${FORK_ICON}<span>${esc(b.title)}</span></button>`
              )
              .join('')}</div>`
          : '';

        return `
          <div class="${rowClasses}" data-turn="${t.turnNumber}">
            <div class="rail" aria-hidden="true">
              <span class="rail-line top"></span>
              <span class="rail-dot"></span>
              <span class="rail-line bottom"></span>
            </div>
            <article class="node-card">
              <div class="node-top" data-toggle-turn="${t.turnNumber}">
                <div class="node-badges">
                  <span class="turn-num num">#${t.turnNumber}</span>
                  ${isHead ? '<span class="head-pill">HEAD</span>' : ''}
                  ${metaParts.map((m) => `<span class="meta-pill num">${esc(m)}</span>`).join('<span class="meta-pill">·</span>')}
                  ${deltaStr ? `<span class="delta-pill num${heavyDelta ? ' heavy' : ''}" title="Bu turun context'e eklediği token">(${esc(deltaStr)})</span>` : ''}
                  ${t.inProgress ? '<span class="meta-pill">çalışıyor…</span>' : ''}
                </div>
              </div>
              <div class="node-user" data-toggle-turn="${t.turnNumber}">${esc(expanded ? t.userFull || t.userPreview : t.userPreview)}</div>
              ${
                t.replyPreview
                  ? `<div class="node-reply" data-toggle-turn="${t.turnNumber}">${esc(expanded ? t.replyFull || t.replyPreview : t.replyPreview)}</div>`
                  : ''
              }
              ${toolsHtml}
              ${branchesHtml}
              <div class="node-actions">
                <button
                  type="button"
                  class="fork-btn"
                  data-fork-step="${t.endStepIndex}"
                  data-fork-turn="${t.turnNumber}"
                  data-preview-cutoff="${t.turnNumber}"
                  data-fork-label="Fork #${t.turnNumber}"
                  title="Bu mesaj ve cevabından hemen sonrasını yeni sohbete forkla (1..${t.turnNumber})"
                  ${!t.canForkAfter || state.busyAction ? 'disabled' : ''}
                >
                  ${FORK_ICON}
                  <span>Buradan Forkla</span>
                </button>
                ${
                  t.canForkBefore
                    ? `<button
                        type="button"
                        class="fork-btn secondary"
                        data-fork-step="${t.forkBeforeStepIndex}"
                        data-fork-turn="${t.turnNumber - 1}"
                        data-preview-cutoff="${t.turnNumber - 1}"
                        data-fork-label="Before #${t.turnNumber}"
                        title="Bu mesajı silip #${t.turnNumber - 1}. turdan yeniden yazmak için öncesinden forkla"
                        ${disabledAttr}
                      >Öncesinden</button>`
                    : ''
                }
                <button type="button" class="expand-hint" data-toggle-turn="${t.turnNumber}">
                  ${expanded ? 'Daralt' : 'Detay'}
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
    $('conv-meta').textContent = `${snap.turnCount} tur · ${snap.totalSteps} adım`;

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

    state.busyAction = true;
    applyCutoffPreview(null);
    $('clone-btn').disabled = true;
    renderTurns();

    const customInput = $('custom-title');
    const rawCustom = (customInput?.value || '').trim();
    const baseTitle = (state.snap?.title || 'Conversation').trim();
    const finalTitle = rawCustom || `${baseTitle} (${defaultSuffix})`;

    showToast('', `Oluşturuluyor: ${finalTitle}…`);

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
      showToast('ok', `Oluşturuldu: ${createdTitle}`, data.newCascadeId);

      // Force refresh so the new branch chip immediately shows on the node
      state.etag = '';
      await poll(true);

      if ($('auto-open')?.checked) {
        openConversation(data.newCascadeId);
      }
    } catch (err) {
      showToast('err', `Fork hatası: ${err?.message || err}`);
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
    $('sort-label').textContent = state.newestFirst ? 'Yeniden eskiye' : 'Kronolojik';
    renderTurns();
    requestAnimationFrame(() => {
      scrollToHead(false);
      updateJumpButton();
    });
  });

  $('jump-head').addEventListener('click', () => scrollToHead(true));

  $('timeline-scroll').addEventListener('scroll', updateJumpButton, { passive: true });

  // Live hover preview on Fork buttons
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

  // Keyboard shortcuts: '/' focuses search, 'Escape' clears search
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
  (async () => {
    await poll(true);
    schedulePoll();
  })();
})();
