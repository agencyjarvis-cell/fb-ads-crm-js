/**
 * stop_all.js v3 — Batch PAUSE active adsets only
 * - Parallel across accounts (fbtool_account_id), sequential within
 * - 5s gap within same account (prevent token ban)
 * - 3 retries per adset + TG alert on failure
 * - Only stops adsets from ACTIVE campaigns (matching CRM active tab)
 */
(function(){
    'use strict';

    var INTRA_ACCOUNT_GAP_MS = 5000;
    var RETRY_DELAYS = [3000, 5000, 8000];
    var TG_BOT_TOKEN = (window.AppConfig && window.AppConfig.TG_BOT_TOKEN) || '';
    var TG_CHAT_ID = (window.AppConfig && window.AppConfig.TG_CHAT_ID) || '';

    function sendTgAlert(text) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = 10000;
            xhr.onload = function() {
                if (xhr.status === 200) console.log('[STOP ALL] TG alert sent');
                else console.warn('[STOP ALL] TG alert failed: HTTP ' + xhr.status);
            };
            xhr.onerror = function() { console.warn('[STOP ALL] TG alert network error'); };
            xhr.send(JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' }));
        } catch(e) { console.warn('[STOP ALL] TG alert exception:', e.message); }
    }

    function isCampaignActive(campaign) {
        var totalSpend = 0;
        var totalLeads = 0;
        var hasActiveAdsets = false;
        if (campaign.adsets && Array.isArray(campaign.adsets)) {
            for (var i = 0; i < campaign.adsets.length; i++) {
                var adset = campaign.adsets[i];
                if (adset.ads && Array.isArray(adset.ads)) {
                    for (var j = 0; j < adset.ads.length; j++) {
                        totalSpend += Number(adset.ads[j].spend) || 0;
                        totalLeads += Number(adset.ads[j].leads) || 0;
                    }
                }
                totalSpend += Number(adset.spend) || 0;
                totalLeads += Number(adset.leads) || 0;
                var adsetStatus = String(adset.status || adset.effective_status || '').toUpperCase();
                if (adsetStatus.indexOf('ACTIVE') >= 0) hasActiveAdsets = true;
            }
        }
        totalSpend += Number(campaign.spend) || 0;
        totalLeads += Number(campaign.leads) || 0;
        var campStatus = String(campaign.campaign_status || campaign.campaign_effective_status || '').toUpperCase();
        var campaignActive = campStatus.indexOf('ACTIVE') >= 0;
        return totalSpend > 0 || totalLeads > 0 || (campaignActive && hasActiveAdsets);
    }

    function getActiveAdsets() {
        if (!window.lastResults || !Array.isArray(window.lastResults)) return [];
        var active = [];
        for (var ci = 0; ci < window.lastResults.length; ci++) {
            var campaign = window.lastResults[ci];
            if (!isCampaignActive(campaign)) continue;
            if (!campaign.adsets || !Array.isArray(campaign.adsets)) continue;
            var cabinetId = campaign.account_id || campaign.adaccount_id || '';
            var fbtoolId = campaign.fbtool_account_id || '';
            for (var si = 0; si < campaign.adsets.length; si++) {
                var adset = campaign.adsets[si];
                var status = String(adset.status || adset.effective_status || '').toUpperCase();
                if (status === 'ACTIVE') {
                    active.push({
                        adset_id: adset.id || adset.adset_id,
                        adaccount_id: cabinetId.replace(/^act_/, ''),
                        fbtool_account_id: fbtoolId,
                        name: adset.name || adset.adset_id || 'unknown',
                        campaign_name: campaign.campaign_name || '',
                        spend: parseFloat(adset.spend) || 0
                    });
                }
            }
        }
        return active;
    }

    function groupByAccount(adsets) {
        var groups = {};
        for (var i = 0; i < adsets.length; i++) {
            var key = adsets[i].fbtool_account_id || adsets[i].adaccount_id || '_default';
            if (!groups[key]) groups[key] = [];
            groups[key].push(adsets[i]);
        }
        return groups;
    }

    async function pauseWithRetry(adset) {
        for (var attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
            try {
                var resp = await fetch('/api/adsets/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        adset_id: adset.adset_id,
                        adaccount_id: adset.adaccount_id,
                        fbtool_account_id: adset.fbtool_account_id,
                        status: 'PAUSED'
                    })
                });
                var data = await resp.json();
                if (data.success) return { success: true, attempts: attempt + 1, error: null };
                var errMsg = data.error || 'unknown server error';
                if (attempt < RETRY_DELAYS.length) {
                    console.warn('[STOP ALL] Retry ' + (attempt+1) + ' for ' + adset.adset_id + ': ' + errMsg);
                    await new Promise(function(r) { setTimeout(r, RETRY_DELAYS[attempt]); });
                } else {
                    return { success: false, attempts: attempt + 1, error: errMsg };
                }
            } catch(e) {
                if (attempt < RETRY_DELAYS.length) {
                    console.warn('[STOP ALL] Retry ' + (attempt+1) + ' for ' + adset.adset_id + ': ' + e.message);
                    await new Promise(function(r) { setTimeout(r, RETRY_DELAYS[attempt]); });
                } else {
                    return { success: false, attempts: attempt + 1, error: e.message };
                }
            }
        }
        return { success: false, attempts: RETRY_DELAYS.length + 1, error: 'max retries' };
    }

    var _progress = { done: 0, total: 0 };

    async function processAccountGroup(groupId, adsets) {
        var ok = 0, failed = [];
        console.log('[STOP ALL] Account ' + groupId + ': ' + adsets.length + ' adsets');
        for (var i = 0; i < adsets.length; i++) {
            var a = adsets[i];
            var result = await pauseWithRetry(a);
            _progress.done++;
            if (typeof window.showLoading === 'function') {
                window.showLoading('Stop ' + _progress.done + '/' + _progress.total + ': ' + a.name);
            }
            if (result.success) {
                ok++;
                console.log('[STOP ALL] Paused ' + a.adset_id + ' (' + a.name + ')' + (result.attempts > 1 ? ' attempt ' + result.attempts : ''));
                if (window._crmFixDisabledAdsets) {
                    window._crmFixDisabledAdsets[a.adset_id] = { at: Date.now(), reason: 'stop_all' };
                }
            } else {
                failed.push({ adset: a, error: result.error, attempts: result.attempts });
                console.error('[STOP ALL] FAILED ' + a.adset_id + ': ' + result.error);
            }
            if (i < adsets.length - 1) {
                await new Promise(function(r) { setTimeout(r, INTRA_ACCOUNT_GAP_MS); });
            }
        }
        return { ok: ok, failed: failed };
    }

    async function stopAll() {
        var adsets = getActiveAdsets();
        if (adsets.length === 0) {
            alert('No active adsets to stop.');
            return;
        }
        var groups = groupByAccount(adsets);
        var groupKeys = Object.keys(groups);
        var totalSpend = adsets.reduce(function(s, a) { return s + a.spend; }, 0);
        var msg = 'STOP ALL?\n\n' +
            'Active adsets: ' + adsets.length + '\n' +
            'Accounts: ' + groupKeys.length + ' (parallel)\n' +
            'Spend: $' + totalSpend.toFixed(2) + '\n' +
            '5s delay per account, 3 retries.';
        if (!confirm(msg)) return;

        if (typeof window.acquireLock === 'function' && !window.acquireLock('Stop All')) return;
        _progress.done = 0;
        _progress.total = adsets.length;
        if (typeof window.showLoading === 'function') {
            window.showLoading('Stopping ' + groupKeys.length + ' accounts... 0/' + adsets.length);
        }
        var t0 = Date.now();
        var promises = [];
        for (var gi = 0; gi < groupKeys.length; gi++) {
            promises.push(processAccountGroup(groupKeys[gi], groups[groupKeys[gi]]));
        }
        var results = await Promise.all(promises);
        var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        if (typeof window.hideLoading === 'function') window.hideLoading();
        if (typeof window.releaseLock === 'function') window.releaseLock();

        var totalOk = 0, allFailed = [];
        for (var ri = 0; ri < results.length; ri++) {
            totalOk += results[ri].ok;
            allFailed = allFailed.concat(results[ri].failed);
        }

        if (allFailed.length > 0) {
            var tgMsg = '<b>CRM STOP ALL: ' + allFailed.length + '/' + adsets.length + ' FAILED</b>\n\n';
            for (var fi = 0; fi < allFailed.length; fi++) {
                var fa = allFailed[fi];
                tgMsg += '- ' + fa.adset.name + ' ($' + fa.adset.spend.toFixed(2) + '): ' + fa.error + '\n';
            }
            tgMsg += '\n' + totalOk + ' OK in ' + elapsed + 's';
            sendTgAlert(tgMsg);
        }

        if (typeof window.renderActiveCampaignsTree === 'function' && window.lastResults) {
            window.renderActiveCampaignsTree(window.lastResults);
        }
        alert('STOP ALL: ' + totalOk + '/' + adsets.length + ' in ' + elapsed + 's\n' +
            'Accounts: ' + groupKeys.length + '\n' +
            (allFailed.length > 0 ? 'Failed: ' + allFailed.length + ' (TG sent)\n' : ''));
    }

    function injectButton() {
        if (document.getElementById('stopAllBtn')) return;
        var btn = document.createElement('button');
        btn.id = 'stopAllBtn';
        btn.className = 'btn btn-danger';
        btn.style.cssText = 'position:fixed;bottom:10px;right:180px;z-index:9999;padding:8px 16px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        btn.innerHTML = 'STOP ALL';
        btn.title = 'Stop active adsets (parallel per account, 5s gap, 3 retries + TG)';
        btn.onclick = function(e) { e.preventDefault(); stopAll(); };
        document.body.appendChild(btn);
        console.log('[STOP ALL] Button injected');
    }

    window.stopAllAdsets = stopAll;

    window.inspectAdsetFields = function() {
        if (!window.lastResults || !window.lastResults.length) { console.log('No data'); return; }
        for (var i = 0; i < window.lastResults.length && i < 3; i++) {
            var c = window.lastResults[i];
            if (!c.adsets || !c.adsets.length) continue;
            var a = c.adsets[0];
            console.log('[INSPECT] Adset fields:', Object.keys(a).join(', '));
            console.log('[INSPECT] Sample adset:', JSON.stringify(a, null, 2).substring(0, 1000));
            return;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(injectButton, 1500); });
    } else {
        setTimeout(injectButton, 1500);
    }
    var injectTimer = setInterval(function() {
        if (document.getElementById('stopAllBtn')) { clearInterval(injectTimer); return; }
        injectButton();
    }, 3000);
    setTimeout(function() { clearInterval(injectTimer); }, 30000);

    console.log('[STOP ALL] v3 loaded. Active campaigns only, parallel, 5s gap, 3 retries + TG.');
})();
