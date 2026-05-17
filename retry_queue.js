/**
 * retry_queue.js - Async retry queue for autorules API calls
 * T-CRM-V2-RETRY: 2 retries (10s, 30s), max 10 pending, per-adset
 */
(function() {
    'use strict';

    var MAX_PENDING = 10;
    var RETRY_DELAYS = [10000, 30000]; // 10s, 30s
    var _pendingRetries = {};

    window._autorulesRetryQueue = _pendingRetries;

    /**
     * Execute an API call with retry logic
     * @param {string} adsetId
     * @param {string} action - 'PAUSED' or 'ACTIVE'
     * @param {object} params - {adaccount_id, fbtool_account_id}
     * @param {function} onSuccess - callback on success
     * @returns {Promise<boolean>}
     */
    async function executeWithRetry(adsetId, action, params, onSuccess) {
        // Atomic cap check: reserve a slot BEFORE awaiting so concurrent failures
        // cannot all pass the cap check and bypass MAX_PENDING.
        if (!_pendingRetries[adsetId]) {
            var pendingCount = Object.keys(_pendingRetries).length;
            if (pendingCount >= MAX_PENDING) {
                console.warn('[RETRY] Queue full (' + MAX_PENDING + ' pending). Skipping retry slot for ' + adsetId);
                // Still attempt the first call, just no retries.
                var r0 = await doApiCall(adsetId, action, params);
                if (r0.success && onSuccess) onSuccess();
                return r0.success;
            }
            // Reserve a placeholder slot
            _pendingRetries[adsetId] = { reserved: true, scheduledAt: Date.now() };
        }

        var result = await doApiCall(adsetId, action, params);
        if (result.success) {
            console.log('[RETRY] ✅ ' + adsetId + ' → ' + action + ' succeeded (first try)');
            delete _pendingRetries[adsetId];
            if (onSuccess) onSuccess();
            return true;
        }

        console.log('[RETRY] ❌ ' + adsetId + ' failed, scheduling retry 1/' + RETRY_DELAYS.length);
        scheduleRetryAttempt(adsetId, action, params, onSuccess, 0);
        return false;
    }

    function scheduleRetryAttempt(adsetId, action, params, onSuccess, retryIndex) {
        if (retryIndex >= RETRY_DELAYS.length) {
            console.error('[RETRY] All ' + RETRY_DELAYS.length + ' retries exhausted for ' + adsetId);
            delete _pendingRetries[adsetId];
            return;
        }

        var delay = RETRY_DELAYS[retryIndex];
        console.log('[RETRY] Retry ' + (retryIndex + 1) + '/' + RETRY_DELAYS.length +
                    ' for ' + adsetId + ' in ' + (delay / 1000) + 's');

        var timerId = setTimeout(async function() {
            console.log('[RETRY] Retry ' + (retryIndex + 1) + ' firing for ' + adsetId);
            var result = await doApiCall(adsetId, action, params);

            if (result.success) {
                console.log('[RETRY] ✅ Retry ' + (retryIndex + 1) + ' succeeded for ' + adsetId);
                delete _pendingRetries[adsetId];
                if (onSuccess) onSuccess();
            } else {
                scheduleRetryAttempt(adsetId, action, params, onSuccess, retryIndex + 1);
            }
        }, delay);

        _pendingRetries[adsetId] = {
            retryIndex: retryIndex,
            timerId: timerId,
            action: action,
            scheduledAt: Date.now(),
            nextRetryAt: Date.now() + delay
        };
    }

    async function doApiCall(adsetId, action, params) {
        try {
            var _fetch = window._originalFetch || window.fetch;
            var resp = await _fetch.call(window, '/api/adsets/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adset_id: adsetId,
                    adaccount_id: params.adaccount_id,
                    fbtool_account_id: params.fbtool_account_id,
                    status: action
                })
            });

            if (!resp.ok) {
                console.error('[RETRY] HTTP ' + resp.status + ' for ' + adsetId);
                return { success: false, status: resp.status };
            }

            var data = await resp.json();
            return { success: !!data.success, data: data };
        } catch (e) {
            console.error('[RETRY] Network error for ' + adsetId + ': ' + e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Cancel a pending retry
     */
    function cancelRetry(adsetId) {
        if (_pendingRetries[adsetId]) {
            clearTimeout(_pendingRetries[adsetId].timerId);
            delete _pendingRetries[adsetId];
            console.log('[RETRY] Cancelled retry for ' + adsetId);
        }
    }

    /**
     * Get retry queue status
     */
    function getRetryStatus() {
        var pending = Object.keys(_pendingRetries).length;
        return {
            pendingCount: pending,
            maxPending: MAX_PENDING,
            entries: Object.keys(_pendingRetries).map(function(id) {
                var r = _pendingRetries[id];
                return {
                    adsetId: id,
                    retryIndex: r.retryIndex,
                    action: r.action,
                    nextRetryIn: Math.max(0, Math.round((r.nextRetryAt - Date.now()) / 1000)) + 's'
                };
            })
        };
    }

    // Export
    window.executeWithRetry = executeWithRetry;
    window.cancelRetry = cancelRetry;
    window.getRetryStatus = getRetryStatus;

    console.log('[RETRY QUEUE] Loaded: max ' + MAX_PENDING + ' pending, delays ' +
                RETRY_DELAYS.map(function(d) { return (d/1000) + 's'; }).join('/'));
})();
