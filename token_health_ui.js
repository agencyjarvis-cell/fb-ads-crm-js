/**
 * token_health_ui.js - T-CRM-TOKEN-HEALTH v1.2
 * Per-profile token health bar in the header area.
 * Profiles locked from _profileNamesCache (crm_v2_patches.js) or /api/accounts.
 * Green dot = recent success (<5min). Red dot = stale/error.
 */
(function() {
    'use strict';

    var STALE_MS      = 5 * 60 * 1000;
    var UI_REFRESH_MS = 10 * 1000;
    var PANEL_ID      = 'tokenHealthBar';

    if (!window._healthProfiles) window._healthProfiles = {};
    var profiles = window._healthProfiles;
    var profilesLocked = false;

    if (!window._acctHealth) window._acctHealth = {};
    var acctHealth = window._acctHealth;

    function norm(id) {
        return id ? String(id).replace(/^act_/, '') : '';
    }

    function lockProfiles(accounts) {
        if (profilesLocked) return;
        if (!accounts || !accounts.length) return;
        accounts.forEach(function(a) {
            var fid = String(a.id || '');
            var name = a.name || ('Profile ' + fid);
            if (fid && !profiles[fid]) {
                profiles[fid] = { name: name, acctIds: [] };
            }
        });
        profilesLocked = true;
        console.log('[TOKEN-HEALTH] Locked ' + Object.keys(profiles).length + ' profiles');
        renderPanel();
    }

    // Try to lock from _profileNamesCache (populated by crm_v2_patches.js)
    function tryLockFromCache() {
        if (profilesLocked) return true;
        var cache = window._profileNamesCache || {};
        var keys = Object.keys(cache);
        if (keys.length > 0) {
            var accs = keys.map(function(k) { return { id: k, name: cache[k] }; });
            lockProfiles(accs);
            return true;
        }
        return false;
    }

    function updateAcctMapping() {
        var rows = window.lastResults || [];
        rows.forEach(function(r) {
            var cid = norm(r.adaccount_id || r.account_id);
            var fid = String(r.fbtool_account_id || '');
            if (!cid || !fid) return;
            if (profiles[fid] && profiles[fid].acctIds.indexOf(cid) === -1) {
                profiles[fid].acctIds.push(cid);
            }
        });
    }

    function trackResponse(acctId, status) {
        if (!acctHealth[acctId]) {
            acctHealth[acctId] = { lastOk: null, lastErr: null, errType: null };
        }
        var h = acctHealth[acctId];
        if (status >= 200 && status < 400) {
            h.lastOk = Date.now();
            h.errType = null;
        } else if (status === 401 || status === 403) {
            h.lastErr = Date.now();
            h.errType = 'token';
        } else {
            h.lastErr = Date.now();
            h.errType = status >= 500 ? 'server' : 'network';
        }
    }

    function trackAllSuccess() {
        var now = Date.now();
        Object.keys(profiles).forEach(function(fid) {
            profiles[fid].acctIds.forEach(function(aid) {
                if (!acctHealth[aid]) {
                    acctHealth[aid] = { lastOk: now, lastErr: null, errType: null };
                } else {
                    acctHealth[aid].lastOk = now;
                    acctHealth[aid].errType = null;
                }
            });
        });
    }

    // ── Fetch interceptor ───────────────────────────────────────────
    var _prevFetch = window.fetch;
    window.fetch = function(url, options) {
        var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');

        // Catch /api/accounts to lock profiles
        if (urlStr.includes('/api/accounts') && !urlStr.includes('5099')) {
            return _prevFetch.apply(this, arguments).then(function(resp) {
                try {
                    var clone = resp.clone();
                    clone.json().then(function(data) {
                        if (data.success && data.accounts) lockProfiles(data.accounts);
                    }).catch(function(){});
                } catch(e) {}
                return resp;
            });
        }

        // Catch /api/collect — main data fetch
        if (urlStr.includes('/api/collect') && !urlStr.includes('5099')) {
            return _prevFetch.apply(this, arguments).then(function(resp) {
                if (resp.status >= 200 && resp.status < 400) {
                    setTimeout(function() {
                        tryLockFromCache();
                        updateAcctMapping();
                        trackAllSuccess();
                        renderPanel();
                    }, 500);
                } else {
                    try {
                        if (options && options.body) {
                            var body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                            if (Array.isArray(body.adaccount_ids)) {
                                body.adaccount_ids.forEach(function(aid) { trackResponse(norm(aid), resp.status); });
                            }
                        }
                    } catch(e) {}
                    renderPanel();
                }
                return resp;
            }).catch(function(err) {
                try {
                    if (options && options.body) {
                        var body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                        if (Array.isArray(body.adaccount_ids)) {
                            body.adaccount_ids.forEach(function(aid) { trackResponse(norm(aid), 0); });
                        }
                    }
                } catch(e2) {}
                renderPanel();
                throw err;
            });
        }

        // Track individual API calls
        if (urlStr.includes('/api/') &&
            !urlStr.includes('/api/accounts') &&
            !urlStr.includes('/api/auto-rules') &&
            !urlStr.includes('/api/refresh-crm') &&
            !urlStr.includes('/api/rate-limit') &&
            !urlStr.includes('5099')) {
            var acctId = extractAcct(urlStr, options);
            if (acctId) {
                return _prevFetch.apply(this, arguments).then(function(resp) {
                    trackResponse(acctId, resp.status);
                    return resp;
                }).catch(function(err) {
                    trackResponse(acctId, 0);
                    throw err;
                });
            }
        }

        return _prevFetch.apply(this, arguments);
    };

    function extractAcct(url, options) {
        var m = url.match(/[?&](?:adaccount_id|account_id|act)=([^&]+)/i);
        if (m) return norm(m[1]);
        m = url.match(/\/api\/adsets\/(act_\d+|\d+)/);
        if (m) return norm(m[1]);
        if (options && options.body) {
            try {
                var obj = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                if (obj.adaccount_id) return norm(obj.adaccount_id);
                if (obj.account_id) return norm(obj.account_id);
            } catch(e) {}
        }
        return '';
    }

    // ── Aggregate ───────────────────────────────────────────────────
    function getRows() {
        updateAcctMapping();
        var result = [];
        Object.keys(profiles).forEach(function(fid) {
            var p = profiles[fid];
            var latestOk = null, latestErr = null, errType = null, hasData = false;
            p.acctIds.forEach(function(aid) {
                var h = acctHealth[aid];
                if (!h) return;
                hasData = true;
                if (h.lastOk && (!latestOk || h.lastOk > latestOk)) latestOk = h.lastOk;
                if (h.lastErr && (!latestErr || h.lastErr > latestErr)) { latestErr = h.lastErr; errType = h.errType; }
            });
            var now = Date.now();
            var elMs = latestOk ? (now - latestOk) : null;
            var elMin = elMs !== null ? Math.floor(elMs / 60000) : null;
            var ok = false;
            if (latestOk) {
                ok = (elMs < STALE_MS);
                if (latestErr && latestErr > latestOk) ok = false;
            }
            result.push({ name: p.name, ok: ok, elMin: elMin, hasData: hasData, errType: errType, cabs: p.acctIds.length });
        });
        result.sort(function(a, b) { if (a.ok !== b.ok) return a.ok ? 1 : -1; return a.name.localeCompare(b.name); });
        return result;
    }

    // ── Render ──────────────────────────────────────────────────────
    function renderPanel() {
        // Keep trying to lock profiles from cache if not yet locked
        if (!profilesLocked) tryLockFromCache();

        var panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL_ID;
            panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 10px;padding:4px 10px;margin-top:6px;font-size:11px;font-family:monospace;color:rgba(255,255,255,0.9);';
            var headerLeft = document.querySelector('.header > div > div:first-child');
            if (!headerLeft) { var h1 = document.querySelector('.header h1'); headerLeft = h1 ? h1.parentElement : null; }
            if (headerLeft) headerLeft.appendChild(panel); else return;
        }

        if (!profilesLocked || Object.keys(profiles).length === 0) {
            panel.innerHTML = '<span style="opacity:0.5;">Tokens: loading profiles...</span>';
            return;
        }

        var rows = getRows();
        var html = '';
        rows.forEach(function(r) {
            var dotClr = r.ok ? '#4ade80' : '#ef4444';
            var dotShadow = r.ok ? '0 0 4px #4ade80' : '0 0 4px #ef4444';
            var timeStr;
            if (!r.hasData) { timeStr = '--'; }
            else if (r.elMin === null) { timeStr = '!'; }
            else if (r.elMin === 0) { timeStr = '<1m'; }
            else {
                var clr = r.elMin > 5 ? '#ff6b6b' : r.elMin > 2 ? '#ffd93d' : '';
                timeStr = clr ? '<span style="color:' + clr + ';">' + r.elMin + 'm</span>' : r.elMin + 'm';
            }
            var title = r.name + ' (' + r.cabs + ' cabs)' + (r.errType ? ' | Error: ' + r.errType : '') + (r.elMin !== null ? ' | Last OK: ' + r.elMin + 'min ago' : '');
            var short = r.name.length > 16 ? r.name.substring(0, 14) + '..' : r.name;
            html += '<span style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap;" title="' + title + '">' +
                '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotClr + ';box-shadow:' + dotShadow + ';flex-shrink:0;"></span>' +
                '<span>' + short + '</span>' +
                '<span style="opacity:0.7;">' + timeStr + '</span></span>';
        });
        panel.innerHTML = html;
    }

    // ── Init ────────────────────────────────────────────────────────
    function init() {
        tryLockFromCache();
        // If lastResults already available, seed health
        if (window.lastResults && window.lastResults.length > 0) {
            updateAcctMapping();
            trackAllSuccess();
        }
        renderPanel();
        setInterval(renderPanel, UI_REFRESH_MS);
        console.log('[TOKEN-HEALTH] v1.2 init. Profiles locked: ' + profilesLocked + ', count: ' + Object.keys(profiles).length);
    }

    if (document.querySelector('.header h1')) {
        // Wait a bit for crm_v2_patches.js to populate _profileNamesCache
        setTimeout(init, 2000);
    } else {
        var t = setInterval(function() {
            if (document.querySelector('.header h1')) { clearInterval(t); setTimeout(init, 2000); }
        }, 500);
        setTimeout(function() { clearInterval(t); }, 30000);
    }

    window.getProfileHealth = getRows;
    window.refreshTokenHealthUI = renderPanel;
    console.log('[TOKEN-HEALTH] v1.2 Loaded.');
})();
