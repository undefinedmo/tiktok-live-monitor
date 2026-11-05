<script>// Prototype additions layered over the real Live Monitor renderer. Nothing here reaches TikTok or a printer.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var ICONS = {
    show: '<rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path>',
    designer: '<path d="M3 12V4h8l10 10-8 8z"></path><circle cx="8" cy="9" r="1.5"></circle>',
    chat: '<path d="M4 5h16v11H9l-5 4z"></path>',
    settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>'
  };
  function panel(title) {
    var p = h('div', 'panel'), head = h('div', 'panel-head');
    head.appendChild(h('span', 'eyebrow', title)); p.appendChild(head); return p;
  }

  // ── buyer history ───────────────────────────────────────────────────────────
  // Sample numbers. The real app reads each buyer's past orders from the database by stable buyer id.
  var KNOWN = { janethague: 14, cristina: 240, jo: 0, leah: 0 };
  function pastOrders(name) {
    var key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key in KNOWN) return KNOWN[key];
    var n = 0; for (var i = 0; i < key.length; i++) n += key.charCodeAt(i);
    return n % 6 === 0 ? 0 : 1 + n % 23;
  }
  function buyerTag(name) {
    var n = pastOrders(name);
    if (!n) return h('span', 'tag ad-new', 'NEW');
    var t = h('span', 'tag ad-ord', n > 99 ? '99+' : String(n)), said = n + (n === 1 ? ' past order' : ' past orders');
    t.title = said; t.setAttribute('aria-label', said);
    return t;
  }
  function tagFeedRows(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.bidrow'), function (r) {
      var sub = r.querySelector('.bidsub'), who = r.querySelector('.bidname');
      if (!sub || !who) return;
      var old = sub.querySelector('.tag.whale'); if (old) old.remove();
      if (!sub.querySelector('.ad-ord,.ad-new')) sub.prepend(buyerTag(who.textContent));
    });
  }
  function tagTopBuyers() {
    Array.prototype.forEach.call($('topBuyersList').children, function (r) {
      var name = r.children[1];
      if (name && name.textContent.indexOf('@') === 0 && !r.querySelector('.ad-ord,.ad-new')) name.after(buyerTag(name.textContent.slice(1)));
    });
  }
  tagFeedRows($('bidFeed')); tagTopBuyers();
  ['bidFeed', 'failedList'].forEach(function (id) { var e = $(id); if (e) { tagFeedRows(e); new MutationObserver(function () { tagFeedRows(e); }).observe(e, { childList: true }); } });
  new MutationObserver(tagTopBuyers).observe($('topBuyersList'), { childList: true });

  // ── navigation ──────────────────────────────────────────────────────────────
  var rail = document.querySelector('.rail'), body = document.querySelector('.terminal-body');
  var navs = {};
  var deskScreen = h('div', 'ad-screen');
  body.appendChild(deskScreen);
  function go(name) {
    if (name === 'settings') $('navSettings2').click(); else $('navMonitor').click();
    $('monitorScreen').style.display = name === 'show' ? 'flex' : 'none';
    deskScreen.classList.toggle('show', name === 'chat');
    if (name === 'chat') renderDesk();
    Object.keys(navs).forEach(function (k) { navs[k].classList.toggle('on', k === name); });
  }
  [['show', 'Show'], ['chat', 'Chat'], ['settings', 'Settings']].forEach(function (n) {
    var b = h('button', 'ad-nav');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[n[0]] + '</svg>';
    b.appendChild(document.createTextNode(n[1]));
    b.addEventListener('click', function () { go(n[0]); });
    navs[n[0]] = b; rail.appendChild(b);
  });
  var badge = h('span', 'ad-count'); navs.chat.appendChild(badge);
  go('show');

  // ── arm + run next, in the top bar so the video keeps its full height ───────
  var ctrl = h('div', 'ad-ctrl'), arm = h('button', 'ad-arm'), knob = h('span', 'ad-knob'), run = h('button', 'ad-run');
  knob.appendChild(h('i')); arm.appendChild(knob); var armText = h('span', '', 'Arm buttons'); arm.appendChild(armText);
  arm.setAttribute('aria-pressed', 'false');
  var runText = h('span', '', 'Run next lot'); run.appendChild(runText); run.appendChild(h('span', 'ad-key', 'F13')); run.disabled = true;
  var armed = false, running = false;
  function syncRun() { run.disabled = !armed || running; runText.textContent = running ? 'Auction running' : 'Run next lot'; }
  arm.addEventListener('click', function () { armed = !armed; arm.classList.toggle('on', armed); arm.setAttribute('aria-pressed', String(armed)); armText.textContent = armed ? 'Armed' : 'Arm buttons'; syncRun(); });
  run.addEventListener('click', function () { running = true; syncRun(); setTimeout(function () { running = false; syncRun(); }, 8000); });
  // Print last needs no arming: reprinting a tag can't start anything on TikTok.
  var last = h('button', 'ad-last'); last.appendChild(h('span', '', 'Print last')); last.appendChild(h('span', 'ad-key', 'F14'));
  last.addEventListener('click', function () {
    var rows = document.querySelectorAll('#bidFeed .bidrow'), row = null;
    for (var i = 0; i < rows.length && !row; i++) if (!rows[i].querySelector('.tag.failed')) row = rows[i];
    var btn = row && row.querySelector('.printmini');
    if (btn) btn.click();
  });
  ctrl.appendChild(arm); ctrl.appendChild(run); ctrl.appendChild(last);
  $('livePill').after(ctrl);

  // ── search on the live bid feed ─────────────────────────────────────────────
  var feed = $('bidFeed'), feedSearchBox = h('div', 'ad-search'), feedSearch = h('input', 'ad-in');
  feedSearch.placeholder = 'Search all sales'; feedSearch.setAttribute('aria-label', 'Search all sales');
  var feedNote = h('div', 'ad-sub ad-feednote');
  feedSearchBox.appendChild(feedSearch); feedSearchBox.appendChild(feedNote); feed.before(feedSearchBox);
  // The feed shows the last 10 sales. Every sale stays loaded here only to stand in for the local
  // SQLite table: in the real app, typing runs a query and the live feed never holds the full list.
  var FEED_SHOWN = 10, sizeSel = $('feedSize');
  sizeSel.value = '100'; sizeSel.dispatchEvent(new Event('change'));
  function filterFeed() {
    var q = feedSearch.value.trim().toLowerCase(), rows = feed.querySelectorAll('.bidrow'), hits = 0;
    Array.prototype.forEach.call(rows, function (r, i) {
      var match = q ? r.textContent.toLowerCase().indexOf(q) >= 0 : i < FEED_SHOWN;
      if (match) hits++;
      r.style.display = match ? '' : 'none';
    });
    feedNote.textContent = q ? hits + (hits === 1 ? ' sale found' : ' sales found') : 'Last ' + Math.min(FEED_SHOWN, rows.length) + ' sales. Search finds the rest.';
  }
  feedSearch.addEventListener('input', filterFeed);
  new MutationObserver(filterFeed).observe(feed, { childList: true });
  filterFeed();

  // ── buyers are asking for + print log, as ordinary panels in the right column ───
  var asking = panel('Buyers are asking for'), askingRows = h('div', 'ad-rows'); asking.appendChild(askingRows);
  var logPanel = panel('Print log'), log = h('div', 'ad-log'); log.setAttribute('role', 'log'); logPanel.appendChild(log);
  var failed = $('failedPanel'); failed.after(asking);
  $('printQueue').closest('.panel').before(logPanel);
  logPanel.querySelector('.panel-head').appendChild(h('span', 'meta', 'Newest first'));
  function stamp() { return new Date().toTimeString().slice(0, 8); }
  function addLog(line, bad) { log.prepend(h('div', bad ? 'ad-bad' : '', stamp() + ' ' + line)); }
  ['#78 tag sent in 51 ms', '#79 tag sent in 48 ms', '#80 tag sent in 50 ms'].forEach(function (l) { addLog(l); });

  // The print queue stays in the page, hidden, because the renderer draws into it. Its finished jobs
  // land in the log, so a failed tag is still seen: the log replaces the panel, not the signal.
  var queue = $('printQueue'), lastTop = '';
  $('printQueue').closest('.panel').style.display = 'none';
  new MutationObserver(function () {
    var row = queue.querySelector('.qrow');
    if (!row) return;
    var label = row.querySelector('.bidname').textContent, status = row.querySelector('.bidsub').textContent, key = label + '|' + status;
    if (key === lastTop) return;
    lastTop = key;
    if (status === 'printed') addLog(label + ' printed');
    if (status === 'error') addLog(label + ' failed to print', true);
  }).observe(queue, { childList: true });

  // The renderer still updates this light, so it stays in the page, out of sight.
  $('sigVideo').closest('.panel').style.display = 'none';

  // ── chat: the whole room, with questions highlighted and replies inline ─────
  var list = $('chatList'), chatSearchBox = h('div', 'ad-search'), chatSearch = h('input', 'ad-in');
  chatSearch.placeholder = 'Search chat'; chatSearch.setAttribute('aria-label', 'Search chat');
  var chatKinds = h('div', 'ad-kinds'), allBtn = h('button', 'ad-kind', 'All chat'), qBtn = h('button', 'ad-kind'), qCount = h('span', 'ad-kindn'), onlyQuestions = false;
  qBtn.appendChild(document.createTextNode('Questions ')); qBtn.appendChild(qCount);
  chatKinds.setAttribute('role', 'group'); chatKinds.setAttribute('aria-label', 'Show in chat');
  chatKinds.appendChild(allBtn); chatKinds.appendChild(qBtn);
  chatSearchBox.classList.add('ad-chattools'); chatSearchBox.appendChild(chatSearch); chatSearchBox.appendChild(chatKinds); list.before(chatSearchBox);
  document.querySelector('.chat-note').textContent = 'Replies post as Host after approval.';
  var QUESTION = /\?\s*$|^(is|are|do|does|did|can|could|will|what|which|how|when|where)\b/i, WISH = /^(?:i\s*wish|!wish)\s+(.+)/i;
  var questions = [], wishes = [];
  function suggest(t) {
    if (/ship/i.test(t)) return 'Yes, everything you win tonight ships together.';
    if (/authentic|real|legit/i.test(t)) return 'Yes, all our brands are authentic.';
    if (/available/i.test(t)) return 'Yes, it is still available.';
    return '';
  }
  function openCount() { return questions.filter(function (q) { return q.state === 'open'; }).length; }
  function syncBadge() { var n = openCount(); badge.textContent = n; badge.style.display = n ? 'flex' : 'none'; qCount.textContent = n; }
  function paintQuestion(q) {
    var row = q.row;
    row.className = 'chatrow ad-q' + (q.state === 'done' ? ' done' : q.state === 'skip' ? ' skip' : q.reply.trim() ? '' : ' need');
    if (q.box) q.box.remove();
    q.box = h('div');
    if (q.state === 'open') {
      var line = h('div', 'ad-reply'), input = h('input', 'ad-in'), ok = h('button', 'ad-btn primary', 'Approve');
      input.maxLength = 100; input.value = q.reply; input.placeholder = 'Write a reply'; input.setAttribute('aria-label', 'Reply to ' + q.buyer);
      var sub = h('div', 'ad-sub'), label = h('span', '', ''), skip = h('button', 'ad-link', 'Skip');
      function tell() { label.textContent = q.reply ? 'Suggested reply, ' + q.reply.length + ' of 100' : 'Needs your reply'; ok.disabled = !q.reply.trim(); }
      input.addEventListener('input', function () { q.reply = input.value; row.classList.toggle('need', !q.reply.trim()); tell(); });
      ok.addEventListener('click', function () { if (q.reply.trim()) { q.state = 'done'; paintQuestion(q); syncBadge(); } });
      skip.addEventListener('click', function () { q.state = 'skip'; paintQuestion(q); syncBadge(); });
      line.appendChild(input); line.appendChild(ok); sub.appendChild(label); sub.appendChild(skip);
      q.box.appendChild(line); q.box.appendChild(sub); tell();
    } else if (q.state === 'done') {
      var host = h('div', 'ad-host'); host.appendChild(h('b', '', 'Posted as Host ')); host.appendChild(document.createTextNode(q.reply)); q.box.appendChild(host);
    }
    row.appendChild(q.box);
  }
  function paintWishes() {
    askingRows.replaceChildren();
    wishes.filter(function (w) { return !w.done; }).forEach(function (w) {
      var r = h('div', 'ad-row'); r.appendChild(h('span', '', w.wish)); r.appendChild(h('span', 'ad-tag', w.buyer)); askingRows.appendChild(r);
    });
  }
  function decorate(row) {
    if (row.dataset.ad || !row.classList.contains('chatrow')) return;
    row.dataset.ad = '1';
    var name = row.querySelector('.chatname'), body = row.querySelector('.chattext');
    if (!name || !body) return;
    var buyer = name.textContent, text = body.textContent.trim(), w = WISH.exec(text);
    if (w) { body.after(h('span', 'ad-wish', 'Wish')); wishes.push({ buyer: buyer, wish: w[1], done: false }); paintWishes(); return; }
    if (QUESTION.test(text)) {
      var head = h('div'); head.appendChild(name); head.appendChild(body); row.replaceChildren(head);
      var q = { row: row, buyer: buyer, text: text, reply: suggest(text), state: 'open', box: null };
      questions.push(q); paintQuestion(q); syncBadge();
    }
  }
  Array.prototype.forEach.call(list.children, decorate);
  new MutationObserver(function (ms) { ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) decorate(n); }); }); }).observe(list, { childList: true });
  function filterChat() {
    var q = chatSearch.value.trim().toLowerCase();
    Array.prototype.forEach.call(list.children, function (r) {
      var kind = !onlyQuestions || r.classList.contains('ad-q');
      r.style.display = kind && (!q || r.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
    });
    allBtn.classList.toggle('on', !onlyQuestions); qBtn.classList.toggle('on', onlyQuestions);
    allBtn.setAttribute('aria-pressed', String(!onlyQuestions)); qBtn.setAttribute('aria-pressed', String(onlyQuestions));
    if (!onlyQuestions) return;
    list.scrollTop = 0;
  }
  allBtn.addEventListener('click', function () { onlyQuestions = false; filterChat(); list.scrollTop = list.scrollHeight; });
  qBtn.addEventListener('click', function () { onlyQuestions = true; filterChat(); });
  chatSearch.addEventListener('input', filterChat);
  new MutationObserver(filterChat).observe(list, { childList: true });
  filterChat();
  syncBadge();

  // ── text size, in Settings ──────────────────────────────────────────────────
  // Stands in for Electron's webFrame.setZoomFactor, which scales the whole window the same way.
  var TEXT_STEPS = [85, 90, 100, 110, 120, 130], TEXT_KEY = 'sf-text-size', textPct = 100;
  try { var saved = Number(localStorage.getItem(TEXT_KEY)); if (TEXT_STEPS.indexOf(saved) >= 0) textPct = saved; } catch (e) { /* no storage: stay at 100 */ }
  var textCard = h('div', 'modal-box set-card'), textHead = h('h3', '', 'Text size'), textRow = h('div', 'ad-textrow');
  var smaller = h('button', 'ad-btn ad-a', 'A−'), bigger = h('button', 'ad-btn ad-a', 'A+'), pct = h('span', 'ad-pct'), reset = h('button', 'ad-link', 'Reset');
  smaller.setAttribute('aria-label', 'Smaller text'); bigger.setAttribute('aria-label', 'Larger text'); pct.setAttribute('role', 'status');
  function applyText() {
    var f = textPct / 100;
    document.body.style.zoom = f; document.body.style.height = (100 / f) + 'vh';
    document.body.classList.toggle('ad-big', textPct >= 120);
    pct.textContent = textPct + '%';
    smaller.disabled = textPct === TEXT_STEPS[0]; bigger.disabled = textPct === TEXT_STEPS[TEXT_STEPS.length - 1];
    try { localStorage.setItem(TEXT_KEY, String(textPct)); } catch (e) { /* the size still applies for this session */ }
  }
  function stepText(d) { var i = TEXT_STEPS.indexOf(textPct) + d; if (TEXT_STEPS[i]) { textPct = TEXT_STEPS[i]; applyText(); } }
  smaller.addEventListener('click', function () { stepText(-1); }); bigger.addEventListener('click', function () { stepText(1); });
  reset.addEventListener('click', function () { textPct = 100; applyText(); });
  textRow.appendChild(smaller); textRow.appendChild(pct); textRow.appendChild(bigger); textRow.appendChild(reset);
  textCard.appendChild(textHead); textCard.appendChild(textRow);
  document.querySelector('#settingsScreen .set-col').prepend(textCard);
  applyText();

  // ── chat desk screen ────────────────────────────────────────────────────────
  function renderDesk() {
    deskScreen.replaceChildren();
    var left = panel('Questions'), right = panel('Wishlist');
    if (!questions.length) left.appendChild(h('div', 'ad-pad', 'No questions yet.'));
    questions.forEach(function (q) {
      var r = h('div', 'ad-q2');
      var top = h('div', 'ad-sub'); top.appendChild(h('b', '', q.buyer)); top.appendChild(h('span', 'ad-tag', q.state === 'done' ? 'Posted as Host' : q.state === 'skip' ? 'Skipped' : q.reply ? 'Suggested' : 'Needs you'));
      r.appendChild(top); r.appendChild(h('div', '', q.text));
      if (q.state === 'done') r.appendChild(h('div', 'ad-host', q.reply));
      if (q.state === 'open') {
        var line = h('div', 'ad-reply'), input = h('input', 'ad-in'), ok = h('button', 'ad-btn primary', 'Approve and post');
        input.maxLength = 100; input.value = q.reply; input.placeholder = 'Write a reply'; input.setAttribute('aria-label', 'Reply to ' + q.buyer); ok.disabled = !q.reply.trim();
        input.addEventListener('input', function () { q.reply = input.value; ok.disabled = !q.reply.trim(); });
        ok.addEventListener('click', function () { q.state = 'done'; paintQuestion(q); syncBadge(); renderDesk(); });
        line.appendChild(input); line.appendChild(ok); r.appendChild(line);
      }
      left.appendChild(r);
    });
    wishes.forEach(function (w) {
      var r = h('div', 'ad-q2'), top = h('div', 'ad-sub'), who = h('div'), b = h('button', 'ad-btn', w.done ? 'Fulfilled' : 'Mark fulfilled');
      who.appendChild(h('div', '', w.wish)); who.appendChild(h('small', '', w.buyer)); top.appendChild(who); top.appendChild(b); r.appendChild(top);
      b.addEventListener('click', function () { w.done = !w.done; paintWishes(); renderDesk(); });
      right.appendChild(r);
    });
    deskScreen.appendChild(left); deskScreen.appendChild(right);
  }

  // ── label designer, inside Settings ─────────────────────────────────────────
  // Raw ZPL is read from the app's real switch (#rawZpl), so both places always agree.
  var rawZpl = $('rawZpl');
  window.labelAPI.setRawZpl = window.labelAPI.setRawZpl || function () { return Promise.resolve(true); };
  rawZpl.checked = true;
  var SIZES = { '1x1': [1, 1], '1.5x1.5': [1.5, 1.5], '2x1': [2, 1], '2x2': [2, 2], '2.25x1.25': [2.25, 1.25], '4x6': [4, 6] };
  var FONTS = ['Arial', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Impact'];
  var ZPL_FONT = '"Arial Narrow","Roboto Condensed",Arial,sans-serif';
  var NON_ZPL = /[^\u0000-ÿ]/;
  var D = { size: '2x1', sel: 'bin', regex: '(Bin [A-Z])', title: '#80 Bin A - Alo Yoga and More, No Cancels', els: [
    { id: 'lot', name: 'Lot number', src: 'lot', x: .08, y: .07, pt: 28, font: 'Arial', bold: true, italic: false, underline: false, inv: false },
    { id: 'bin', name: 'Bin', src: 'regex', x: 1.3, y: .08, pt: 15, font: 'Arial', bold: true, italic: false, underline: false, inv: true },
    { id: 'buyer', name: 'Buyer', src: 'buyer', x: .08, y: .68, pt: 11, font: 'Arial', bold: true, italic: false, underline: false, inv: false },
    { id: 'qr', name: 'QR code', src: 'qr', x: 1.48, y: .47, pt: 0, font: 'Arial', bold: false, italic: false, underline: false, inv: false }
  ] };
  function activeRegex() { return $('setRegex').value || D.regex; }
  function sampleTitle() { return $('sampleTitle').value || D.title; }
  function textOf(e) {
    if (e.src === 'lot') return '#80';
    if (e.src === 'buyer') return 'Janet Hague';
    if (e.src === 'price') return '$20.00';
    if (e.src === 'item') return 'Alo Yoga and More';
    if (e.src === 'fixed') return e.text || 'Text';
    try { var m = sampleTitle().match(new RegExp(activeRegex(), 'i')); return m ? (m[1] || m[0]) : ''; } catch (err) { return ''; }
  }
  function toggle(label, on, disabled, why, onClick) {
    var b = h('button', 'ad-toggle' + (on ? ' on' : ''), label);
    b.setAttribute('aria-pressed', String(on)); b.disabled = disabled; if (disabled) b.title = why;
    b.addEventListener('click', onClick); return b;
  }
  var canvasSlot = h('div'), propsSlot = h('div', 'ad-col');
  function renderDesigner() {
    var zpl = rawZpl.checked, size = SIZES[D.size], scale = Math.min(250, 460 / size[1], 600 / size[0]);
    var sel = D.els.filter(function (e) { return e.id === D.sel; })[0];
    canvasSlot.replaceChildren(); propsSlot.replaceChildren();

    var mode = h('div', 'ad-mode' + (zpl ? '' : ' std')), modeText = h('div'), modeBtn = h('button', 'ad-btn', zpl ? 'Use any font' : 'Use fast printing');
    modeText.appendChild(h('b', '', zpl ? 'Fast printing (raw ZPL) is on. ' : 'Standard printing is on. '));
    modeText.appendChild(document.createTextNode(zpl ? 'The printer draws its own font, so fonts, italic and underline are off. The preview uses a close match.' : 'Any font and style works, but tags print about 5× slower.'));
    modeBtn.addEventListener('click', function () { rawZpl.checked = !rawZpl.checked; rawZpl.dispatchEvent(new Event('change', { bubbles: true })); });
    mode.appendChild(modeText); mode.appendChild(modeBtn);

    var left = panel('Canvas'), tools = h('div', 'ad-tools'), select = h('select', 'ad-in');
    select.setAttribute('aria-label', 'Label size');
    Object.keys(SIZES).forEach(function (k) { var o = h('option', '', k.replace('x', ' × ') + ' in'); o.value = k; select.appendChild(o); });
    select.value = D.size; select.addEventListener('change', function () { D.size = select.value; renderDesigner(); });
    function adder(label, make) { var b = h('button', 'ad-btn', label); b.addEventListener('click', function () { var e = make(); e.id = 'x' + Date.now(); D.els.push(e); D.sel = e.id; renderDesigner(); }); return b; }
    var base = { x: .1, y: .1, pt: 12, font: 'Arial', bold: true, italic: false, underline: false, inv: false };
    tools.appendChild(select);
    tools.appendChild(adder('Add text', function () { return Object.assign({}, base, { name: 'Text', src: 'fixed', text: 'New text' }); }));
    tools.appendChild(adder('Add QR', function () { return Object.assign({}, base, { name: 'QR code', src: 'qr' }); }));
    tools.appendChild(adder('Add logo', function () { return Object.assign({}, base, { name: 'Logo', src: 'logo' }); }));
    left.querySelector('.panel-head').appendChild(tools);
    var canvas = h('div', 'ad-canvas'), label = h('div', 'ad-label');
    label.style.width = Math.round(size[0] * scale) + 'px'; label.style.height = Math.round(size[1] * scale) + 'px';
    D.els.forEach(function (e) {
      var box = e.src === 'qr' || e.src === 'logo';
      var b = h('button', 'ad-el' + (e.src === 'qr' ? ' qr' : '') + (e.src === 'logo' ? ' logo' : '') + (e.inv ? ' inv' : '') + (e.id === D.sel ? ' sel' : ''), e.src === 'qr' ? '' : e.src === 'logo' ? 'LOGO' : textOf(e));
      b.setAttribute('aria-label', e.name); b.style.left = e.x * scale + 'px'; b.style.top = e.y * scale + 'px';
      if (box) { b.style.width = b.style.height = .46 * scale + 'px'; } else {
        b.style.fontSize = Math.round(e.pt * scale / 72) + 'px';
        b.style.fontFamily = zpl ? ZPL_FONT : '"' + e.font + '",sans-serif';
        b.style.fontWeight = zpl || e.bold ? '700' : '400';
        b.style.fontStyle = !zpl && e.italic ? 'italic' : 'normal';
        b.style.textDecoration = !zpl && e.underline ? 'underline' : 'none';
      }
      b.addEventListener('pointerdown', function (ev) {
        ev.preventDefault(); var sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y, zoom = textPct / 100, snap = function (v) { return Math.round(v * 20) / 20; };
        D.sel = e.id; b.setPointerCapture(ev.pointerId);
        function move(m) { e.x = Math.min(Math.max(0, snap(ox + (m.clientX - sx) / zoom / scale)), size[0] - .2); e.y = Math.min(Math.max(0, snap(oy + (m.clientY - sy) / zoom / scale)), size[1] - .15); b.style.left = e.x * scale + 'px'; b.style.top = e.y * scale + 'px'; }
        function up() { b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); renderDesigner(); }
        b.addEventListener('pointermove', move); b.addEventListener('pointerup', up);
      });
      label.appendChild(b);
    });
    canvas.appendChild(label); left.appendChild(canvas);
    var foot = h('div', 'ad-sub ad-canvasfoot');
    foot.appendChild(h('span', '', 'Drag anything. Positions snap to 0.05 in.'));
    foot.appendChild(h('span', 'ad-tag', zpl ? 'Prints as fast ZPL' : 'Prints through the driver'));
    left.appendChild(foot);
    canvasSlot.appendChild(mode); canvasSlot.appendChild(left);

    var layers = panel('Layers'), box = h('div', 'ad-pad');
    D.els.forEach(function (e) {
      var b = h('button', 'ad-layer' + (e.id === D.sel ? ' on' : '')); b.appendChild(h('span', '', e.name));
      b.appendChild(h('small', '', e.src === 'regex' ? 'Regex' : e.src === 'qr' ? 'QR' : e.src === 'logo' ? 'Image' : e.src === 'fixed' ? 'Fixed' : 'Field'));
      b.addEventListener('click', function () { D.sel = e.id; renderDesigner(); }); box.appendChild(b);
    });
    layers.appendChild(box); propsSlot.appendChild(layers);

    var props = panel(sel ? sel.name : 'Nothing selected'), pb = h('div', 'ad-pad');
    if (sel) {
      var del = h('button', 'ad-link', 'Delete');
      del.addEventListener('click', function () { D.els = D.els.filter(function (e) { return e !== sel; }); D.sel = D.els[0] ? D.els[0].id : null; renderDesigner(); });
      props.querySelector('.panel-head').appendChild(del);
    }
    if (sel && sel.src !== 'qr' && sel.src !== 'logo') {
      var f1 = h('label', 'ad-f', 'Text comes from'), s = h('select', 'ad-in');
      [['regex', 'Regex on title'], ['lot', 'Lot number'], ['item', 'Item name'], ['buyer', 'Buyer'], ['price', 'Price'], ['fixed', 'Fixed text']].forEach(function (o) { var x = h('option', '', o[1]); x.value = o[0]; s.appendChild(x); });
      s.value = sel.src; s.addEventListener('change', function () { sel.src = s.value; renderDesigner(); if (sel.src === 'regex') openDrawer(); }); f1.appendChild(s); pb.appendChild(f1);
      if (sel.src === 'fixed') {
        var f4 = h('label', 'ad-f', 'Text'), t = h('input', 'ad-in'); t.value = sel.text || '';
        t.addEventListener('change', function () { sel.text = t.value; renderDesigner(); }); f4.appendChild(t); pb.appendChild(f4);
        if (zpl && NON_ZPL.test(sel.text || '')) pb.appendChild(h('div', 'ad-warn', 'Emoji and symbols won’t print in fast printing.'));
      }
      if (sel.src === 'regex') {
        var rx = h('div', 'ad-sub'), edit = h('button', 'ad-btn', 'Edit pattern');
        rx.appendChild(h('span', '', 'Prints: ' + (textOf(sel) || 'no match'))); rx.appendChild(edit);
        edit.addEventListener('click', openDrawer); pb.appendChild(rx);
      }
      var f5 = h('label', 'ad-f', 'Font'), fs = h('select', 'ad-in');
      if (zpl) { var zo = h('option', '', 'Printer font (ZPL)'); zo.value = ''; fs.appendChild(zo); fs.disabled = true; fs.title = 'Turn off fast printing to choose a font'; }
      else { FONTS.forEach(function (n) { var o = h('option', '', n); o.value = n; fs.appendChild(o); }); fs.value = sel.font; }
      fs.addEventListener('change', function () { sel.font = fs.value; renderDesigner(); }); f5.appendChild(fs); pb.appendChild(f5);
      var f2 = h('label', 'ad-f', 'Text size, pt'), n = h('input', 'ad-in'); n.type = 'number'; n.min = 6; n.max = 72; n.value = sel.pt;
      n.addEventListener('change', function () { sel.pt = Number(n.value) || sel.pt; renderDesigner(); }); f2.appendChild(n); pb.appendChild(f2);
      var row = h('div', 'ad-toggles'), why = 'Not available in fast printing';
      row.appendChild(toggle('Bold', zpl || sel.bold, zpl, 'The printer font is always bold', function () { sel.bold = !sel.bold; renderDesigner(); }));
      row.appendChild(toggle('Italic', !zpl && sel.italic, zpl, why, function () { sel.italic = !sel.italic; renderDesigner(); }));
      row.appendChild(toggle('Underline', !zpl && sel.underline, zpl, why, function () { sel.underline = !sel.underline; renderDesigner(); }));
      row.appendChild(toggle('White on black', sel.inv, false, '', function () { sel.inv = !sel.inv; renderDesigner(); }));
      pb.appendChild(row);
      if (zpl && sel.inv) pb.appendChild(h('div', 'ad-warn', 'Print a test tag first. Some ZPL printers ignore this.'));
    } else if (sel && sel.src === 'qr') {
      var kind = sel.qrKind || 'pack', f6 = h('label', 'ad-f', 'QR contains'), k = h('select', 'ad-in');
      [['pack', 'Pack scan code'], ['link', 'Web link'], ['fixed', 'Fixed text']].forEach(function (o) { var x = h('option', '', o[1]); x.value = o[0]; k.appendChild(x); });
      k.value = kind; k.addEventListener('change', function () { sel.qrKind = k.value; renderDesigner(); }); f6.appendChild(k); pb.appendChild(f6);
      if (kind === 'pack') {
        pb.appendChild(h('div', 'ad-sub', 'Matches the tag to its order at the pack station. Manual tags have no order, so they print without this QR.'));
      } else {
        var f7 = h('label', 'ad-f', kind === 'link' ? 'Link' : 'Text'), v = h('input', 'ad-in'), value = sel.qrText || '';
        v.value = value; v.placeholder = kind === 'link' ? 'https://your-shop-link' : 'What the QR should hold';
        v.addEventListener('change', function () { sel.qrText = v.value.trim(); renderDesigner(); }); f7.appendChild(v); pb.appendChild(f7);
        pb.appendChild(h('div', 'ad-sub', value.length + ' characters'));
        // Limits for the 0.46 in QR at 203 dpi: past 42 bytes the squares shrink to about 2 dots, past 84 to 1.
        if (!value) pb.appendChild(h('div', 'ad-warn', kind === 'link' ? 'Add a link, or this tag prints without a QR.' : 'Add text, or this tag prints without a QR.'));
        else if (value.length > 84) pb.appendChild(h('div', 'ad-warn', 'Too long to scan at this size. Use a shorter link or a larger QR.'));
        else if (value.length > 42) pb.appendChild(h('div', 'ad-warn', 'Long for this size. Print a test tag and scan it.'));
        else if (kind === 'link' && !/^https?:\/\/\S+\.\S+/i.test(value)) pb.appendChild(h('div', 'ad-warn', 'This doesn’t look like a full link. Start it with https://'));
        pb.appendChild(h('div', 'ad-warn', 'Tags with this QR can’t be scanned at the pack station.'));
      }
      var test = h('button', 'ad-btn', 'Print test tag'), sent = h('div', 'ad-sub');
      sent.setAttribute('role', 'status');
      test.addEventListener('click', function () { addLog('Test tag printed'); sent.textContent = 'Test tag sent. Scan it to check.'; });
      pb.appendChild(test); pb.appendChild(sent);
    }
    else if (sel && sel.src === 'logo') pb.appendChild(h('div', 'ad-warn', zpl ? 'Logos print as an image, so this tag will print slower.' : 'Choose your logo in the real app.'));
    else pb.appendChild(h('div', 'ad-sub', 'Add text, a QR code or a logo.'));
    props.appendChild(pb); propsSlot.appendChild(props);
  }

  // Settings becomes two tabs: the designer (with the real regex tools) and everything else.
  var sBody = document.querySelector('#settingsScreen .body'), grid = sBody.querySelector('.set-grid');
  var designerTab = h('div', 'ad-designer'), designerLeft = h('div', 'ad-col');
  var layoutCard = $('setCustom').closest('.set-card');
  layoutCard.querySelector('h3').textContent = 'Text from the title';
  layoutCard.querySelector('.fields').style.display = 'none';
  $('setSize').closest('label').style.display = 'none';
  $('setSize').value = D.size;
  grid.querySelector('.set-side').style.display = 'none';
  // The designer's banner is the one place to change this; the switch stays in the page as its state.
  var rawRow = rawZpl.closest('label'), rawNote = rawRow.nextElementSibling;
  rawRow.style.display = 'none'; if (rawNote && rawNote.classList.contains('preview')) rawNote.style.display = 'none';
  grid.style.gridTemplateColumns = 'minmax(0,720px)';
  designerLeft.appendChild(canvasSlot);
  designerTab.appendChild(designerLeft); designerTab.appendChild(propsSlot);

  // The title-text tools open in a drawer, only when a layer actually needs them.
  var scrim = h('div', 'ad-scrim'), drawer = h('div', 'ad-drawer'), drawerHead = h('div', 'ad-drawerhead'), drawerClose = h('button', 'ad-x', '✕'), drawerOpener = null;
  drawerClose.setAttribute('aria-label', 'Close'); drawerClose.title = 'Close';
  drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Text from the title'); drawer.setAttribute('aria-modal', 'true');
  layoutCard.querySelector('h3').remove();
  drawerHead.appendChild(h('h3', '', 'Text from the title')); drawerHead.appendChild(drawerClose);
  drawer.appendChild(drawerHead); drawer.appendChild(layoutCard);
  document.body.appendChild(scrim); document.body.appendChild(drawer);
  function openDrawer() {
    drawerOpener = document.activeElement; scrim.classList.add('show'); drawer.classList.add('show');
    drawerClose.focus();
  }
  function closeDrawer() {
    scrim.classList.remove('show'); drawer.classList.remove('show'); renderDesigner();
    var again = Array.prototype.filter.call(document.querySelectorAll('.ad-designer .ad-btn'), function (b) { return b.textContent === 'Edit pattern'; })[0];
    (again || drawerOpener || document.body).focus();
  }
  drawerClose.addEventListener('click', closeDrawer); scrim.addEventListener('click', closeDrawer);
  drawer.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  sBody.prepend(designerTab);
  var tabs = h('div', 'ad-tabs'), tabButtons = {};
  function setTab(name) {
    designerTab.style.display = name === 'designer' ? 'grid' : 'none';
    grid.style.display = name === 'designer' ? 'none' : 'grid';
    Object.keys(tabButtons).forEach(function (k) { tabButtons[k].classList.toggle('on', k === name); tabButtons[k].setAttribute('aria-pressed', String(k === name)); });
  }
  [['designer', 'Label designer'], ['app', 'Printer & app']].forEach(function (t) {
    var b = h('button', 'ad-tab', t[1]); b.addEventListener('click', function () { setTab(t[0]); }); tabButtons[t[0]] = b; tabs.appendChild(b);
  });
  sBody.before(tabs);
  setTab('designer');
  rawZpl.addEventListener('change', renderDesigner);
  ['setRegex', 'sampleTitle'].forEach(function (id) { $(id).addEventListener('input', renderDesigner); });
  $('presetSel').addEventListener('change', function () { setTimeout(renderDesigner, 0); });
  renderDesigner();
})();
</script>
  </body>
</html>
