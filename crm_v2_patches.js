// === CRM v2 PATCHES (monkey-patches on top of app.js) ===
// Features:
//   T-CRM-V2-RULE-UNIQUE  - cabinet only in one autorules group
//   T-CRM-V2-ACTIVE-FILTER - "only with active" toggle on Active tab
//   T-CRM-V2-TIMER-GRP    - group timer cabinets by profile_name
//   T-CRM-V2-TIMER-SAVE   - persist timers across reload (localStorage)
//   T-CRM-V2-TOKEN-BANNER - red banner on token error alert
//   T-CRM-V2-SETTINGS-FIX - persist selectedAccounts across reload
//   T-CRM-V2-RETRY-WIRE   - hook autorules adset toggle into retry queue

(function(){
    'use strict';

    function esc(s) {
        if (s == null) return '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function safeInterval(fn, gapMs, totalMs) {
        var t = setInterval(function(){
            try { if (fn()) clearInterval(t); } catch(e){}
        }, gapMs);
        setTimeout(function(){ clearInterval(t); }, totalMs || 20000);
        try { fn(); } catch(e){}
    }

    // ========================================================================
    // 1) T-CRM-V2-RULE-UNIQUE — каб только в одной группе автоправил
    // ========================================================================
    function patchRenderCabinetsSelector() {
        if (typeof window.renderCabinetsSelector !== 'function') return false;
        if (window._ruleUniquePatched) return true;
        var orig = window.renderCabinetsSelector;

        window.renderCabinetsSelector = function(selectedCabinets) {
            selectedCabinets = selectedCabinets || [];
            // Call original to populate, then post-process the DOM
            var rv = orig.apply(this, arguments);
            try { applyRuleUniqueDom(selectedCabinets); } catch(e){ console.warn('[RULE-UNIQUE] DOM patch error', e); }
            return rv;
        };
        window._ruleUniquePatched = true;
        console.log('[RULE-UNIQUE] ✅ Patched renderCabinetsSelector');
        return true;
    }

    function applyRuleUniqueDom(selectedCabinets) {
        var container = document.getElementById('cabinetsSelectorList');
        if (!container) return;
        var settings = window.autoRulesV2Settings;
        if (!settings || !Array.isArray(settings.groups)) return;
        // Determine which cabinet is in which group (by id)
        var ownerByCab = {}; // cabId -> groupName
        settings.groups.forEach(function(g){
            (g.cabinets || []).forEach(function(cid){
                if (selectedCabinets.indexOf(cid) !== -1) return; // currently edited group: do not lock its own cabs
                if (!ownerByCab[cid]) ownerByCab[cid] = g.name || 'group';
            });
        });

        var labels = container.querySelectorAll('label');
        labels.forEach(function(label){
            var cb = label.querySelector('input[type="checkbox"]');
            if (!cb) return;
            var cid = cb.value;
            var owner = ownerByCab[cid];
            if (!owner) return;
            cb.disabled = true;
            cb.checked = false;
            label.style.opacity = '0.55';
            label.style.cursor = 'not-allowed';
            label.style.background = '#fafafa';
            if (!label.querySelector('.rule-unique-tag')) {
                var tag = document.createElement('div');
                tag.className = 'rule-unique-tag';
                tag.style.cssText = 'font-size:11px;color:#c62828;font-weight:600;margin-top:4px;';
                tag.textContent = '🔒 у групі: ' + owner;
                var info = label.querySelector('div');
                if (info) info.appendChild(tag);
            }
        });
    }

    // ========================================================================
    // 2) T-CRM-V2-ACTIVE-FILTER — фильтр "только с активным" на Активные
    // ========================================================================
    function injectActiveFilterToggle() {
        var activeBtn = document.getElementById('resultsTabActive');
        if (!activeBtn) return false;
        if (document.getElementById('activeOnlyFilterToggle')) return true;

        var wrapper = document.createElement('div');
        wrapper.id = 'activeOnlyFilterToggle';
        wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--border,#e0e0e0);background:var(--bg-card,#fff);cursor:pointer;font-size:12px;color:var(--text-secondary,#666);user-select:none;';
        wrapper.innerHTML = '<input type="checkbox" id="activeOnlyFilterChk" style="cursor:pointer;"><span>Тільки з активним spend</span>';

        // Insert after the Timer tab (or after Active button as fallback)
        var anchor = document.getElementById('resultsTabTimer') || document.getElementById('resultsTabLaunch') || activeBtn;
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
        }

        var chk = wrapper.querySelector('#activeOnlyFilterChk');
        try { chk.checked = localStorage.getItem('crm_active_only_filter') === '1'; } catch(e){}
        window._activeOnlyFilter = chk.checked;

        chk.addEventListener('change', function(){
            window._activeOnlyFilter = chk.checked;
            try { localStorage.setItem('crm_active_only_filter', chk.checked ? '1' : '0'); } catch(e){}
            if (typeof window.renderActiveCampaignsTree === 'function' && window.lastResults) {
                window.renderActiveCampaignsTree(window.lastResults);
            }
        });
        console.log('[ACTIVE-FILTER] ✅ Toggle injected');
        return true;
    }

    function patchRenderActiveForFilter() {
        if (typeof window.renderActiveCampaignsTree !== 'function') return false;
        if (window._activeFilterPatched) return true;
        var orig = window.renderActiveCampaignsTree;
        window.renderActiveCampaignsTree = function(data) {
            try {
                if (window._activeOnlyFilter && Array.isArray(data)) {
                    data = data.filter(function(row){
                        if (!row || !Array.isArray(row.adsets)) return false;
                        return row.adsets.some(function(a){
                            var st = String(a.status || a.effective_status || '').toUpperCase();
                            var spend = parseFloat(a.spend) || 0;
                            return st === 'ACTIVE' && spend > 0;
                        });
                    });
                }
            } catch(e){ console.warn('[ACTIVE-FILTER] filter error', e); }
            return orig.call(this, data);
        };
        window._activeFilterPatched = true;
        console.log('[ACTIVE-FILTER] ✅ Patched renderActiveCampaignsTree');
        return true;
    }

    // ========================================================================
    // 3) T-CRM-V2-TIMER-GRP — группировка кабов в Timer по profile_name
    // ========================================================================
    function getProfileByCabId() {
        var map = {};
        var rows = window.lastResults || [];
        rows.forEach(function(r){
            var cid = r.adaccount_id || r.account_id;
            if (!cid) return;
            var pn = r.profile_name || r.profile || r.adaccount_name || cid;
            if (!map[cid]) map[cid] = pn;
        });
        return map;
    }

    function groupTimerCabsByProfile() {
        var section = document.getElementById('timerSection');
        if (!section || section.style.display === 'none') return;
        if (section.getAttribute('data-profile-grouped') === '1') return;

        // Find all .timer-cab elements
        var cabs = section.querySelectorAll('.timer-cab');
        if (!cabs.length) return;

        var profileMap = getProfileByCabId();
        // Group by profile name
        var groups = {};
        var order = [];
        cabs.forEach(function(cab){
            var hdr = cab.querySelector('.timer-cab-hdr');
            if (!hdr) return;
            var cid = hdr.getAttribute('data-cab-id');
            var pn = profileMap[cid] || 'Інше';
            if (!groups[pn]) { groups[pn] = []; order.push(pn); }
            groups[pn].push(cab);
        });
        if (order.length <= 1) {
            // Single-profile fallback — skip grouping
            section.setAttribute('data-profile-grouped', '1');
            return;
        }

        // Re-arrange: wrap each profile's cabs and insert a header
        var firstCab = cabs[0];
        var parent = firstCab.parentNode;
        order.forEach(function(pn){
            var header = document.createElement('div');
            header.className = 'timer-profile-hdr';
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin:14px 0 6px 0;border-radius:8px;background:linear-gradient(90deg,#1e3a5f 0%,#2c5282 100%);color:#fff;font-weight:700;font-size:14px;';
            header.innerHTML =
                '<span>👤 ' + esc(pn) + ' <span style="opacity:0.7;font-weight:500;font-size:12px;">(' + groups[pn].length + ' кабінетів)</span></span>' +
                '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:600;">' +
                '<input type="checkbox" data-profile-selall="' + esc(pn) + '" style="cursor:pointer;">' +
                '<span>Виділити все</span></label>';
            parent.insertBefore(header, groups[pn][0]);
            // Move all cabs of this profile to come right after header in order
            groups[pn].forEach(function(c){ parent.insertBefore(c, header.nextSibling.nextSibling || null); });
        });

        // Bind profile-select-all
        section.querySelectorAll('[data-profile-selall]').forEach(function(cb){
            cb.addEventListener('change', function(e){
                e.stopPropagation();
                var pn = this.getAttribute('data-profile-selall');
                var on = this.checked;
                // Find next siblings until next profile header — toggle adset checkboxes in those
                var node = this.closest('.timer-profile-hdr').nextSibling;
                while (node) {
                    if (node.classList && node.classList.contains('timer-profile-hdr')) break;
                    if (node.querySelectorAll) {
                        // Expand cabinet first (so adsets exist)
                        var hdr = node.querySelector ? node.querySelector('.timer-cab-hdr') : null;
                        if (hdr && on) {
                            // Click to expand if collapsed
                            var label = hdr.querySelector('span');
                            if (label && /^▶/.test(label.textContent)) hdr.click();
                        }
                        node.querySelectorAll('input[data-adset]').forEach(function(acb){
                            if (acb.checked !== on) {
                                acb.checked = on;
                                acb.dispatchEvent(new Event('change', {bubbles:true}));
                            }
                        });
                    }
                    node = node.nextSibling;
                }
            });
        });

        section.setAttribute('data-profile-grouped', '1');
    }

    function observeTimerSection() {
        var section = document.getElementById('timerSection');
        if (!section) return false;
        if (window._timerGrpObserved) return true;
        var mo = new MutationObserver(function(){
            // Re-render resets data-profile-grouped — reapply
            if (section.style.display !== 'none' &&
                section.getAttribute('data-profile-grouped') !== '1') {
                groupTimerCabsByProfile();
            }
        });
        mo.observe(section, {childList:true, subtree:true});
        // Also re-mark for grouping when any internal render clears children
        var _orig = section.innerHTML;
        // Trigger initial pass
        setTimeout(groupTimerCabsByProfile, 300);
        window._timerGrpObserved = true;
        console.log('[TIMER-GRP] ✅ Observer attached');
        return true;
    }

    // The simple flag-reset: every time we want a re-group, clear data-profile-grouped
    function patchTimerRerender() {
        // The timer UI sets section.innerHTML = h on each render. So MutationObserver
        // already triggers. But we must clear the flag.
        // We patch by listening to clicks on sub-tabs/cab-hdr which trigger re-render.
        document.addEventListener('click', function(e){
            var t = e.target;
            if (!t) return;
            if (t.closest && (t.closest('.timer-sub-tab') || t.closest('.timer-cab-hdr') || t.closest('.timer-ads-toggle'))) {
                var section = document.getElementById('timerSection');
                if (section) {
                    setTimeout(function(){
                        section.removeAttribute('data-profile-grouped');
                        groupTimerCabsByProfile();
                    }, 50);
                }
            }
        }, true);
    }

    // ========================================================================
    // 4) T-CRM-V2-TIMER-SAVE — сохранение таймеров в localStorage
    // ========================================================================
    var TIMER_LS = 'crm_scheduled_enables';

    function persistTimers() {
        try {
            var t = window._scheduledEnables || {};
            var out = {};
            Object.keys(t).forEach(function(id){
                var e = t[id];
                if (!e || !e.time) return;
                var when = (e.time instanceof Date) ? e.time.getTime() : Number(e.time);
                if (!when || when <= Date.now() - 60000) return; // skip past-due
                out[id] = {
                    when: when,
                    label: e.label || '',
                    adsetName: e.adsetName || id
                };
            });
            localStorage.setItem(TIMER_LS, JSON.stringify(out));
        } catch(e) { console.warn('[TIMER-SAVE] persist error', e.message); }
    }

    function hookTimerApis() {
        if (window._timerSaveHooked) return true;
        if (typeof window.scheduleEnable !== 'function') return false;

        var origSchedule = window.scheduleEnable;
        window.scheduleEnable = function(adsetId, timeStr){
            var res = origSchedule.apply(this, arguments);
            setTimeout(persistTimers, 50);
            return res;
        };

        if (typeof window.scheduleEnableBatch === 'function') {
            var origBatch = window.scheduleEnableBatch;
            window.scheduleEnableBatch = function(ids, timeStr){
                var res = origBatch.apply(this, arguments);
                setTimeout(persistTimers, 50);
                return res;
            };
        }

        if (typeof window.cancelScheduled === 'function') {
            var origCancel = window.cancelScheduled;
            window.cancelScheduled = function(id){
                var res = origCancel.apply(this, arguments);
                setTimeout(persistTimers, 50);
                return res;
            };
        }

        if (typeof window.cancelAllScheduled === 'function') {
            var origCancelAll = window.cancelAllScheduled;
            window.cancelAllScheduled = function(){
                var res = origCancelAll.apply(this, arguments);
                try { localStorage.removeItem(TIMER_LS); } catch(e){}
                return res;
            };
        }

        window._timerSaveHooked = true;
        console.log('[TIMER-SAVE] ✅ Hooks installed');
        return true;
    }

    function restoreTimers() {
        if (window._timerSaveRestored) return;
        try {
            var raw = localStorage.getItem(TIMER_LS);
            if (!raw) { window._timerSaveRestored = true; return; }
            var saved = JSON.parse(raw);
            var ids = Object.keys(saved);
            if (!ids.length) { window._timerSaveRestored = true; return; }
            if (typeof window.scheduleEnable !== 'function') return; // wait

            var KYIV_OFFSET_H = 3;
            var restored = 0;
            ids.forEach(function(id){
                var e = saved[id];
                if (!e || !e.when) return;
                if (e.when <= Date.now() + 5000) return; // past
                // Convert UTC ms → Kyiv yyyy-MM-dd HH:mm format expected by parseKyivTime
                var d = new Date(e.when);
                // Kyiv is UTC+3 — build a Kyiv-equivalent date by offset diff
                var kyivMs = d.getTime() + (d.getTimezoneOffset() * 60000) + (KYIV_OFFSET_H * 3600000);
                var k = new Date(kyivMs);
                var pad = function(n){ return n<10?'0'+n:''+n; };
                var timeStr = k.getFullYear() + '-' + pad(k.getMonth()+1) + '-' + pad(k.getDate()) +
                              ' ' + pad(k.getHours()) + ':' + pad(k.getMinutes());
                try {
                    window.scheduleEnable(id, timeStr);
                    restored++;
                } catch(err) { console.warn('[TIMER-SAVE] re-schedule failed for ' + id, err); }
            });
            console.log('[TIMER-SAVE] ✅ Restored ' + restored + '/' + ids.length + ' timers');
            window._timerSaveRestored = true;
        } catch(e) { console.warn('[TIMER-SAVE] restore error', e); }
    }

    // ========================================================================
    // 5) T-CRM-V2-TOKEN-BANNER — красный banner вверху при alertFired
    // ========================================================================
    function ensureTokenBanner() {
        if (document.getElementById('tokenAlertBanner')) return;
        var b = document.createElement('div');
        b.id = 'tokenAlertBanner';
        b.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(90deg,#c62828,#b71c1c);color:#fff;padding:10px 16px;font-weight:700;text-align:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        b.innerHTML = '<span id="tokenAlertText">⚠️ TOKEN ERROR</span> ' +
                      '<button id="tokenAlertClose" style="margin-left:16px;padding:4px 12px;background:#fff;color:#c62828;border:none;border-radius:6px;font-weight:700;cursor:pointer;">Сховати</button>';
        document.body.insertBefore(b, document.body.firstChild);
        var closeBtn = b.querySelector('#tokenAlertClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', function(){
                b.style.display = 'none';
                window._tokenBannerDismissed = true;
            });
        }
    }

    function checkTokenBanner() {
        var stats = window._tokenErrorStats;
        if (!stats) return;
        var b = document.getElementById('tokenAlertBanner');
        if (!b) return;
        if (stats.alertFired && !window._tokenBannerDismissed) {
            var minutes = stats.firstErrorAt ? Math.round((Date.now() - stats.firstErrorAt) / 60000) : 0;
            var msg = (stats.tokenErrors > stats.serverErrors)
                ? '🚨 TOKEN ERROR: 401/403 ' + stats.tokenErrors + ' разів за ' + minutes + ' хв. Токен ймовірно протух.'
                : '⚠️ FBTOOL LAG: 500/timeout ' + stats.serverErrors + ' разів за ' + minutes + ' хв.';
            b.querySelector('#tokenAlertText').textContent = msg;
            b.style.display = 'block';
            // Optional TG alert (one-shot)
            if (!window._tokenTgFired) {
                window._tokenTgFired = true;
                try {
                    fetch('/api/tg-alert', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({
                            type: 'token_error',
                            message: msg,
                            stats: window.getTokenErrorStats ? window.getTokenErrorStats() : null
                        })
                    }).catch(function(){});
                } catch(e){}
            }
        }
    }

    // ========================================================================
    // 6) Settings restore fix — also persist selectedAccounts
    // ========================================================================
    function patchSelectedAccountsPersist() {
        if (window._selAccPatched) return true;
        // Persist on any change. Hook into <input checkbox> changes in accountsList.
        var ls = 'crm_selected_accounts';

        document.addEventListener('change', function(e){
            var t = e.target;
            if (!t || t.type !== 'checkbox') return;
            var ac = document.getElementById('accountsList');
            if (!ac || !ac.contains(t)) return;
            try {
                var arr = window.selectedAccounts || [];
                if (window.AppState && window.AppState.selectedAccounts) arr = window.AppState.selectedAccounts;
                localStorage.setItem(ls, JSON.stringify(arr));
            } catch(err){}
        });

        // Also save on beforeunload
        window.addEventListener('beforeunload', function(){
            try {
                var arr = window.selectedAccounts || [];
                if (window.AppState && window.AppState.selectedAccounts) arr = window.AppState.selectedAccounts;
                if (arr && arr.length) localStorage.setItem(ls, JSON.stringify(arr));
            } catch(e){}
        });

        // Restore: wait for accountsList to render, then check the boxes
        // Also write window.selectedAccounts directly so subsequent restorers see it.
        try {
            var preRaw = localStorage.getItem(ls);
            if (preRaw) {
                var preSaved = JSON.parse(preRaw);
                if (Array.isArray(preSaved) && preSaved.length) {
                    if (!Array.isArray(window.selectedAccounts) || window.selectedAccounts.length === 0) {
                        window.selectedAccounts = preSaved.slice();
                        if (window.AppState) window.AppState.selectedAccounts = preSaved.slice();
                        console.log('[STATE-RESTORE+] Pre-set window.selectedAccounts (' + preSaved.length + ')');
                    }
                }
            }
        } catch(e){}

        var attempts = 0;
        var restoreTimer = setInterval(function(){
            attempts++;
            if (attempts > 60) { clearInterval(restoreTimer); return; }
            var ac = document.getElementById('accountsList');
            if (!ac) return;
            var boxes = ac.querySelectorAll('input[type="checkbox"]');
            if (!boxes.length) return;
            try {
                var raw = localStorage.getItem(ls);
                if (!raw) { clearInterval(restoreTimer); return; }
                var saved = JSON.parse(raw);
                if (!Array.isArray(saved) || !saved.length) { clearInterval(restoreTimer); return; }
                var restored = 0;
                boxes.forEach(function(cb){
                    if (saved.indexOf(cb.value) !== -1 && !cb.checked) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', {bubbles:true}));
                        restored++;
                    }
                });
                if (restored > 0) console.log('[STATE-RESTORE+] Restored ' + restored + ' selected accounts');
                clearInterval(restoreTimer);
            } catch(e){ clearInterval(restoreTimer); }
        }, 200);

        window._selAccPatched = true;
        console.log('[STATE-RESTORE+] ✅ selectedAccounts persistence wired');
        return true;
    }

    // ========================================================================
    // 7) T-CRM-V2-RETRY-WIRE — wrap fetch to /api/adsets/status with retry on 500/timeout
    // ========================================================================
    function wireRetryOnAdsetsStatus() {
        if (window._retryWired) return true;
        if (typeof window.executeWithRetry !== 'function') return false;
        // We don't replace fetch — we add a wrapper for callers who use the new helper.
        // But also instrument failures of direct fetch via response sniffing.
        var _origFetch = window.fetch;
        window.fetch = function(url, options){
            var p = _origFetch.apply(this, arguments);
            if (typeof url === 'string' && url.indexOf('/api/adsets/status') !== -1 && options && options.body) {
                p.then(function(resp){
                    if (resp && resp.status >= 500) {
                        try {
                            var body = JSON.parse(options.body);
                            if (body.adset_id && body.adaccount_id) {
                                // Show toast/notification + enqueue retry
                                console.warn('[RETRY-WIRE] 5xx on adsets/status, scheduling retry for ' + body.adset_id);
                                if (window.executeWithRetry) {
                                    window.executeWithRetry(body.adset_id, body.status || 'ACTIVE', {
                                        adaccount_id: body.adaccount_id,
                                        fbtool_account_id: body.fbtool_account_id
                                    });
                                }
                                showRetryToast(body.adset_id, body.status);
                            }
                        } catch(e){}
                    }
                }).catch(function(){});
            }
            return p;
        };
        window._retryWired = true;
        console.log('[RETRY-WIRE] ✅ Wrapper installed');
        return true;
    }

    function showRetryToast(adsetId, action) {
        var bar = document.getElementById('crmRetryToast');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'crmRetryToast';
            bar.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99998;background:#ff9800;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.25);max-width:320px;';
            document.body.appendChild(bar);
        }
        var status = window.getRetryStatus ? window.getRetryStatus() : {pendingCount:0};
        bar.innerHTML = '🔁 Retry ' + esc(action || '') + ' для ' + esc(adsetId) + '<br><small style="opacity:0.85;">Pending: ' + status.pendingCount + '</small>';
        bar.style.display = 'block';
        clearTimeout(window._retryToastT);
        window._retryToastT = setTimeout(function(){ bar.style.display = 'none'; }, 8000);
    }

    // ========================================================================
    // INIT
    // ========================================================================
    function init() {
        ensureTokenBanner();
        setInterval(checkTokenBanner, 5000);

        safeInterval(patchRenderCabinetsSelector, 500, 30000);
        safeInterval(patchRenderActiveForFilter, 500, 30000);
        safeInterval(injectActiveFilterToggle, 1000, 60000);
        safeInterval(observeTimerSection, 1500, 60000);
        safeInterval(hookTimerApis, 500, 30000);
        safeInterval(patchSelectedAccountsPersist, 1500, 30000);
        safeInterval(wireRetryOnAdsetsStatus, 1500, 30000);

        // Restore timers after scheduleEnable is loaded
        var restoreTry = 0;
        var rt = setInterval(function(){
            restoreTry++;
            if (restoreTry > 40) { clearInterval(rt); return; }
            if (typeof window.scheduleEnable === 'function' && window.lastResults) {
                restoreTimers();
                clearInterval(rt);
            }
        }, 500);

        patchTimerRerender();

        console.log('[CRM v2 PATCHES] ✅ All patches scheduled');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 200); });
    } else {
        setTimeout(init, 200);
    }
})();
