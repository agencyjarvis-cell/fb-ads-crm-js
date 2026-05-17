/**
 * stop_all.js — Кнопка "Остановить все" (batch PAUSE всех активных адсетов)
 * Loaded via crm_fix.js loadScript chain.
 * 
 * Features:
 * - Confirms with user before stopping
 * - Sequential PAUSE requests (5s gap to avoid 502)
 * - 3 retries per adset (3s, 5s, 8s delays)
 * - Telegram notification via bot after 3 failed retries
 * - Progress indicator and summary
 */
(function(){
    'use strict';

    var PAUSE_GAP_MS = 5000; // 5s between requests
    var RETRY_DELAYS = [3000, 5000, 8000]; // retry delays (3 attempts)

    // Telegram bot config (hardcoded for CRM alerts)
    var TG_BOT_TOKEN = '7412854111:AAGDv22XteMjAkqvJNp6WHndBpihv5pbfLY';
    var TG_CHAT_ID = 1111262901;

    /**
     * Send alert to Telegram
     */
    function sendTgAlert(text) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = 10000;
            xhr.onload = function() {
                if (xhr.status === 200) {
                    console.log('[STOP ALL] TG alert sent');
                } else {
                    console.warn('[STOP ALL] TG alert failed: HTTP ' + xhr.status);
                }
            };
            xhr.onerror = function() {
                console.warn('[STOP ALL] TG alert network error');
            };
            xhr.send(JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: text,
                parse_mode: 'HTML'
            }));
        } catch(e) {
            console.warn('[STOP ALL] TG alert exception:', e.message);
        }
    }

    /**
     * Get all active adsets from lastResults
     */
    function getActiveAdsets() {
        if (!window.lastResults || !Array.isArray(window.lastResults)) return [];
        var active = [];
        for (var ci = 0; ci < window.lastResults.length; ci++) {
            var campaign = window.lastResults[ci];
            if (!campaign.adsets || !Array.isArray(campaign.adsets)) continue;
            var cabinetId = campaign.account_id || campaign.adaccount_id || '';
            var fbtoolId = campaign.fbtool_account_id || '';
            for (var si = 0; si < campaign.adsets.length; si++) {
                var adset = campaign.adsets[si];
                var status = adset.status || adset.effective_status || '';
                if (status === 'ACTIVE') {
                    active.push({
                        adset_id: adset.id || adset.adset_id,
                        adaccount_id: cabinetId.replace(/^act_/, ''),
                        fbtool_account_id: fbtoolId,
                        name: adset.name || adset.adset_id || 'unknown',
                        spend: parseFloat(adset.spend) || 0
                    });
                }
            }
        }
        return active;
    }

    /**
     * Try to pause a single adset with retries
     * Returns: { success: boolean, attempts: number, error: string|null }
     */
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
                if (data.success) {
                    return { success: true, attempts: attempt + 1, error: null };
                }
                // Server returned error but responded
                var errMsg = data.error || 'unknown server error';
                if (attempt < RETRY_DELAYS.length) {
                    console.warn('[STOP ALL] Retry ' + (attempt + 1) + '/' + RETRY_DELAYS.length + ' for ' + adset.adset_id + ': ' + errMsg);
                    await new Promise(function(r) { setTimeout(r, RETRY_DELAYS[attempt]); });
                } else {
                    return { success: false, attempts: attempt + 1, error: errMsg };
                }
            } catch(e) {
                if (attempt < RETRY_DELAYS.length) {
                    console.warn('[STOP ALL] Retry ' + (attempt + 1) + '/' + RETRY_DELAYS.length + ' for ' + adset.adset_id + ': ' + e.message);
                    await new Promise(function(r) { setTimeout(r, RETRY_DELAYS[attempt]); });
                } else {
                    return { success: false, attempts: attempt + 1, error: e.message };
                }
            }
        }
        return { success: false, attempts: RETRY_DELAYS.length + 1, error: 'max retries exceeded' };
    }

    /**
     * Pause all active adsets sequentially
     */
    async function stopAll() {
        var adsets = getActiveAdsets();
        if (adsets.length === 0) {
            alert('Нет активных адсетов для остановки.');
            return;
        }

        var totalSpend = adsets.reduce(function(s, a) { return s + a.spend; }, 0);
        var msg = 'ОСТАНОВИТЬ ВСЕ?\n\n' +
            'Активных адсетов: ' + adsets.length + '\n' +
            'Общий spend: $' + totalSpend.toFixed(2) + '\n\n' +
            'Все будут поставлены на ПАУЗУ.\n(3 попытки на каждый адсет)';
        if (!confirm(msg)) return;

        if (typeof window.acquireLock === 'function' && !window.acquireLock('Зупинка всіх адсетів')) return;
        if (typeof window.showLoading === 'function') window.showLoading('Зупинка всіх адсетів... 0/' + adsets.length);

        var ok = 0;
        var failedAdsets = [];

        for (var i = 0; i < adsets.length; i++) {
            var a = adsets[i];
            if (typeof window.showLoading === 'function') {
                window.showLoading('Зупинка ' + (i + 1) + '/' + adsets.length + ': ' + a.name);
            }

            var result = await pauseWithRetry(a);

            if (result.success) {
                ok++;
                var retryNote = result.attempts > 1 ? ' (attempt ' + result.attempts + ')' : '';
                console.log('[STOP ALL] Paused ' + a.adset_id + ' (' + a.name + ')' + retryNote);
                if (window._crmFixDisabledAdsets) {
                    window._crmFixDisabledAdsets[a.adset_id] = { at: Date.now(), reason: 'stop_all' };
                }
            } else {
                failedAdsets.push({ adset: a, error: result.error, attempts: result.attempts });
                console.error('[STOP ALL] FAILED after ' + result.attempts + ' attempts: ' + a.adset_id + ' (' + a.name + '): ' + result.error);
            }

            // Gap between adsets (except last)
            if (i < adsets.length - 1) {
                await new Promise(function(r) { setTimeout(r, PAUSE_GAP_MS); });
            }
        }

        if (typeof window.hideLoading === 'function') window.hideLoading();
        if (typeof window.releaseLock === 'function') window.releaseLock();

        // Send TG alert if any failures
        if (failedAdsets.length > 0) {
            var tgMsg = '<b>CRM STOP ALL: ' + failedAdsets.length + ' адсетов НЕ остановлены!</b>\n\n';
            for (var fi = 0; fi < failedAdsets.length; fi++) {
                var fa = failedAdsets[fi];
                tgMsg += '- ' + fa.adset.name + ' (spend: $' + fa.adset.spend.toFixed(2) + ')\n  Ошибка: ' + fa.error + '\n';
            }
            tgMsg += '\nОстановлено: ' + ok + '/' + adsets.length;
            sendTgAlert(tgMsg);
        }

        // Re-render
        if (typeof window.renderActiveCampaignsTree === 'function' && window.lastResults) {
            window.renderActiveCampaignsTree(window.lastResults);
        }

        var summary = 'STOP ALL завершён.\n\n' +
            'Остановлено: ' + ok + '/' + adsets.length + '\n' +
            (failedAdsets.length > 0 ? 'Ошибок: ' + failedAdsets.length + ' (TG уведомление отправлено)\n' : '') +
            'Всего: ' + adsets.length;
        alert(summary);
        console.log('[STOP ALL] Done: ' + ok + ' ok, ' + failedAdsets.length + ' failed out of ' + adsets.length);
    }

    /**
     * Inject the STOP ALL button into UI
     */
    function injectButton() {
        var targets = [
            document.querySelector('.step3-controls'),
            document.querySelector('.controls-bar'),
            document.querySelector('#step3 .card-header'),
            document.querySelector('.refresh-controls'),
            document.querySelector('#activeCampaignsContainer')
        ];
        var container = null;
        for (var i = 0; i < targets.length; i++) {
            if (targets[i]) { container = targets[i]; break; }
        }

        var btn = document.createElement('button');
        btn.id = 'stopAllBtn';
        btn.className = 'btn btn-danger';
        btn.style.cssText = 'margin:5px;padding:8px 16px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;';
        btn.innerHTML = 'STOP ALL';
        btn.title = 'Остановить все активные адсеты (3 попытки + TG alert)';
        btn.onclick = function(e) {
            e.preventDefault();
            stopAll();
        };

        if (container) {
            container.appendChild(btn);
            console.log('[STOP ALL] Button injected into UI');
        } else {
            btn.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:9999;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
            document.body.appendChild(btn);
            console.log('[STOP ALL] Button injected as floating');
        }
    }

    window.stopAllAdsets = stopAll;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(injectButton, 1000); });
    } else {
        setTimeout(injectButton, 1000);
    }

    var injectTimer = setInterval(function() {
        if (document.getElementById('stopAllBtn')) { clearInterval(injectTimer); return; }
        injectButton();
    }, 3000);
    setTimeout(function() { clearInterval(injectTimer); }, 30000);

    console.log('[STOP ALL] Module loaded. 3 retries per adset + TG alert on failure.');
})();
