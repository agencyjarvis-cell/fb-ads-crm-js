/**
 * token_monitor.js - T-CRM-V2-TOKEN-BOT
 * Monitor FBtool API errors for future TG bot alert.
 * Intercepts all fetch responses, counts 401/403 errors.
 * If 5 minutes of continuous errors → console.error with alert marker.
 * Distinguishes 401/403 (token dead) from 500/timeout (FBtool lag).
 */
(function() {
    'use strict';

    var ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    var CHECK_INTERVAL_MS = 30 * 1000;    // check every 30s

    window._tokenErrorStats = {
        totalRequests: 0,
        tokenErrors: 0,         // 401/403
        serverErrors: 0,        // 500/502/503/timeout
        firstErrorAt: null,     // timestamp of first error in current streak
        lastErrorAt: null,
        lastSuccessAt: null,
        consecutiveErrors: 0,
        alertFired: false,
        history: []             // last 50 events
    };

    var stats = window._tokenErrorStats;

    function recordEvent(type, status, url) {
        var entry = {
            time: Date.now(),
            type: type,  // 'success', 'token_error', 'server_error'
            status: status,
            url: (url || '').substring(0, 100)
        };

        stats.history.push(entry);
        if (stats.history.length > 50) stats.history.shift();

        stats.totalRequests++;

        if (type === 'success') {
            stats.lastSuccessAt = Date.now();
            stats.consecutiveErrors = 0;
            stats.firstErrorAt = null;
            stats.alertFired = false;
        } else if (type === 'token_error') {
            stats.tokenErrors++;
            stats.consecutiveErrors++;
            stats.lastErrorAt = Date.now();
            if (!stats.firstErrorAt) stats.firstErrorAt = Date.now();
        } else if (type === 'server_error') {
            stats.serverErrors++;
            stats.consecutiveErrors++;
            stats.lastErrorAt = Date.now();
            if (!stats.firstErrorAt) stats.firstErrorAt = Date.now();
        }
    }

    // Intercept fetch to monitor API responses
    var _prevFetch = window.fetch;
    window.fetch = function(url, options) {
        var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');

        // Only monitor API calls (not static files)
        if (!urlStr.includes('/api/')) {
            return _prevFetch.apply(this, arguments);
        }

        return _prevFetch.apply(this, arguments).then(function(response) {
            var status = response.status;

            if (status === 401 || status === 403) {
                recordEvent('token_error', status, urlStr);
                console.warn('[TOKEN-MON] 🔴 Token error ' + status + ' on ' + urlStr);
            } else if (status >= 500) {
                recordEvent('server_error', status, urlStr);
                console.warn('[TOKEN-MON] 🟡 Server error ' + status + ' on ' + urlStr);
            } else if (status >= 200 && status < 400) {
                recordEvent('success', status, urlStr);
            }

            return response;
        }).catch(function(error) {
            recordEvent('server_error', 0, urlStr);
            console.warn('[TOKEN-MON] 🟡 Network error on ' + urlStr + ': ' + error.message);
            throw error;
        });
    };

    // Periodic check for sustained errors
    function checkErrorStreak() {
        if (!stats.firstErrorAt) return;
        if (stats.alertFired) return;

        var streakDuration = Date.now() - stats.firstErrorAt;

        if (streakDuration >= ERROR_WINDOW_MS && stats.consecutiveErrors > 0) {
            // 5 minutes of continuous errors
            var tokenErrs = stats.history.filter(function(e) {
                return e.type === 'token_error' && e.time >= stats.firstErrorAt;
            }).length;
            var serverErrs = stats.history.filter(function(e) {
                return e.type === 'server_error' && e.time >= stats.firstErrorAt;
            }).length;

            if (tokenErrs > serverErrs) {
                console.error('[TOKEN-MON] 🚨 ALERT: Token errors for ' +
                    Math.round(streakDuration / 60000) + ' min! ' +
                    tokenErrs + ' token errors (401/403). TOKEN IS LIKELY DEAD. ' +
                    '[TG_ALERT_MARKER:TOKEN_DEAD]');
            } else {
                console.error('[TOKEN-MON] ⚠️ ALERT: Server errors for ' +
                    Math.round(streakDuration / 60000) + ' min! ' +
                    serverErrs + ' server errors (500/timeout). FBtool may be lagging. ' +
                    '[TG_ALERT_MARKER:FBTOOL_LAG]');
            }
            stats.alertFired = true;
        }
    }

    setInterval(checkErrorStreak, CHECK_INTERVAL_MS);

    // Public API
    window.getTokenErrorStats = function() {
        return {
            totalRequests: stats.totalRequests,
            tokenErrors: stats.tokenErrors,
            serverErrors: stats.serverErrors,
            consecutiveErrors: stats.consecutiveErrors,
            alertFired: stats.alertFired,
            streakMinutes: stats.firstErrorAt ? Math.round((Date.now() - stats.firstErrorAt) / 60000) : 0,
            lastSuccess: stats.lastSuccessAt ? new Date(stats.lastSuccessAt).toLocaleTimeString() : 'never',
            lastError: stats.lastErrorAt ? new Date(stats.lastErrorAt).toLocaleTimeString() : 'never'
        };
    };

    window.resetTokenErrorStats = function() {
        stats.totalRequests = 0;
        stats.tokenErrors = 0;
        stats.serverErrors = 0;
        stats.firstErrorAt = null;
        stats.lastErrorAt = null;
        stats.lastSuccessAt = null;
        stats.consecutiveErrors = 0;
        stats.alertFired = false;
        stats.history = [];
        console.log('[TOKEN-MON] Stats reset');
    };

    console.log('[TOKEN-MON] ✅ Loaded. Monitoring API responses. 5-min error window. Stats: window._tokenErrorStats');
})();
