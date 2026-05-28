/**
 * afk_optimizer.js - AFK optimization monkey-patch
 * - Skip cabinets without active CAMPAIGNS during AFK refresh
 * - Skip AFK refresh while geo toggle is running
 * Loads AFTER app.js, patches performAutoRefresh in-place.
 */
(function() {
    'use strict';

    function patchPerformAutoRefresh() {
        // Find the original performAutoRefresh (it's a closure var in app.js IIFE,
        // but it's called from setInterval which we can intercept)
        // Strategy: wrap the queue addRequest to filter cabinets before they enter the queue

        // 1. Patch queueManager.addRequest to skip cabinets with all-PAUSED campaigns
        if (window.queueManager && typeof window.queueManager.addRequest === 'function') {
            // Can't access queueManager directly (closure). Try DOM event approach instead.
        }

        // Better strategy: intercept collectCabinetDelta or refreshCabinetData
        // These are called per-cabinet during AFK. We can make them no-op for inactive cabinets.

        if (typeof window.refreshCabinetData === 'function' && !window._afkOptimizerPatched) {
            var origRefresh = window.refreshCabinetData;
            window.refreshCabinetData = function(adaccountId, date, options) {
                // Skip if geo toggle is running
                if (window._geoRunning) {
                    console.log('[AFK-OPT] Skip refresh ' + adaccountId + ' — geo toggle active');
                    return Promise.resolve({success: true, skipped: true});
                }
                // Skip cabinets where ALL campaigns are PAUSED
                if (window.lastResults && window.lastResults.length && options && options.quiet) {
                    var nId = String(adaccountId || '').replace(/^act_/, '');
                    var rows = window.lastResults.filter(function(r) {
                        var rId = String(r.adaccount_id || r.account_id || '').replace(/^act_/, '');
                        return rId === nId;
                    });
                    if (rows.length > 0) {
                        var hasActiveCampaign = rows.some(function(r) {
                            var cs = (r.campaign_status || r.campaign_effective_status || '').toUpperCase();
                            return cs === 'ACTIVE';
                        });
                        if (!hasActiveCampaign) {
                            console.log('[AFK-OPT] Skip ' + adaccountId + ' — all campaigns PAUSED');
                            return Promise.resolve({success: true, skipped: true});
                        }
                    }
                }
                return origRefresh.apply(this, arguments);
            };
            window._afkOptimizerPatched = true;
            console.log('[AFK-OPT] ✅ refreshCabinetData patched');
            return true;
        }
        return false;
    }

    // Init with retry (app.js loads first, needs time)
    function init() {
        if (patchPerformAutoRefresh()) {
            console.log('[AFK-OPT] ✅ AFK optimizer loaded');
        } else {
            setTimeout(init, 2000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 3000); });
    } else {
        setTimeout(init, 3000);
    }
})();
