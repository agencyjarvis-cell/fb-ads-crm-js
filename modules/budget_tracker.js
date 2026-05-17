/**
 * budget_tracker.js - T-CRM-BUDGET
 * Parses budget from collect response data, shows budget next to spend.
 * Budget fields: adset_daily_budget, adset_lifetime_budget (in cents, 8900 = $89)
 * Uses /api/budget/{account_id} proxy endpoint.
 */
(function() {
    'use strict';

    var _budgetCache = {}; // adsetId -> budget info

    /**
     * Parse budget data from collect response rows
     */
    function parseBudgetsFromRows(rows) {
        (rows || []).forEach(function(row) {
            (row.adsets || []).forEach(function(adset) {
                var adsetId = adset.id || adset.adset_id;
                if (!adsetId) return;

                var dailyBudget = adset.adset_daily_budget || row.adset_daily_budget || 0;
                var lifetimeBudget = adset.adset_lifetime_budget || row.adset_lifetime_budget || 0;
                var campDailyBudget = row.campaign_daily_budget || 0;
                var campLifetimeBudget = row.campaign_lifetime_budget || 0;

                _budgetCache[adsetId] = {
                    adsetDaily: dailyBudget,
                    adsetLifetime: lifetimeBudget,
                    campaignDaily: campDailyBudget,
                    campaignLifetime: campLifetimeBudget,
                    // Format to dollars (budget is in cents)
                    adsetDailyUsd: (dailyBudget / 100).toFixed(2),
                    adsetLifetimeUsd: (lifetimeBudget / 100).toFixed(2),
                    campaignDailyUsd: (campDailyBudget / 100).toFixed(2),
                    campaignLifetimeUsd: (campLifetimeBudget / 100).toFixed(2)
                };
            });
        });
        return _budgetCache;
    }

    /**
     * Fetch budget data via proxy
     */
    async function fetchBudget(accountId) {
        try {
            var resp = await fetch('/api/budget/' + accountId);
            var data = await resp.json();
            if (data.success && data.data) {
                data.data.forEach(function(item) {
                    _budgetCache[item.adset_id] = {
                        adsetDaily: item.adset_daily_budget || 0,
                        adsetLifetime: item.adset_lifetime_budget || 0,
                        campaignDaily: item.campaign_daily_budget || 0,
                        campaignLifetime: item.campaign_lifetime_budget || 0,
                        adsetDailyUsd: ((item.adset_daily_budget || 0) / 100).toFixed(2),
                        adsetLifetimeUsd: ((item.adset_lifetime_budget || 0) / 100).toFixed(2),
                        campaignDailyUsd: ((item.campaign_daily_budget || 0) / 100).toFixed(2),
                        campaignLifetimeUsd: ((item.campaign_lifetime_budget || 0) / 100).toFixed(2)
                    };
                });
                console.log('[BUDGET] Fetched budget for account ' + accountId + ': ' + data.data.length + ' adsets');
            }
        } catch (e) {
            console.warn('[BUDGET] Fetch failed for ' + accountId + ': ' + e.message);
        }
    }

    /**
     * Get budget for adset (from cache)
     */
    function getBudget(adsetId) {
        return _budgetCache[adsetId] || null;
    }

    /**
     * Format budget string for display
     */
    function formatBudgetStr(adsetId) {
        var b = _budgetCache[adsetId];
        if (!b) return '';
        if (b.adsetDaily > 0) return 'Budget: $' + b.adsetDailyUsd + '/day';
        if (b.adsetLifetime > 0) return 'Budget: $' + b.adsetLifetimeUsd + ' lifetime';
        if (b.campaignDaily > 0) return 'Camp budget: $' + b.campaignDailyUsd + '/day';
        return '';
    }

    // Hook into data collection to auto-parse budgets
    function patchCollect() {
        if (typeof window.renderActiveCampaignsTree === 'function' && !window._budgetPatchApplied) {
            var origRender = window.renderActiveCampaignsTree;
            window.renderActiveCampaignsTree = function(data) {
                parseBudgetsFromRows(data || window.lastResults);
                var result = origRender.apply(this, arguments);
                setTimeout(injectBudgetBadges, 150);
                return result;
            };
            window._budgetPatchApplied = true;
            console.log('[BUDGET] Patched renderActiveCampaignsTree for budget display');
        }
    }

    /**
     * Inject budget badges into rendered adset rows
     */
    function injectBudgetBadges() {
        // Find adset elements and add budget info
        var adsetEls = document.querySelectorAll('[data-adset-id]');
        adsetEls.forEach(function(el) {
            var adsetId = el.getAttribute('data-adset-id');
            var budgetStr = formatBudgetStr(adsetId);
            if (!budgetStr) return;

            // Check if badge already exists
            if (el.querySelector('.budget-badge')) return;

            var badge = document.createElement('span');
            badge.className = 'budget-badge';
            badge.style.cssText = 'font-size:11px;color:#1565c0;background:#e3f2fd;padding:2px 6px;border-radius:4px;margin-left:8px;';
            badge.textContent = budgetStr;

            var spendEl = el.querySelector('.adset-spend, .stat-value');
            if (spendEl) {
                spendEl.parentNode.insertBefore(badge, spendEl.nextSibling);
            }
        });
    }

    patchCollect();
    var patchTimer = setInterval(function() {
        patchCollect();
        if (window._budgetPatchApplied) clearInterval(patchTimer);
    }, 500);
    setTimeout(function() { clearInterval(patchTimer); }, 15000);

    // Parse on load if data exists
    if (window.lastResults && window.lastResults.length) {
        parseBudgetsFromRows(window.lastResults);
    }

    // Export
    window.getBudget = getBudget;
    window.fetchBudget = fetchBudget;
    window.formatBudgetStr = formatBudgetStr;
    window.parseBudgetsFromRows = parseBudgetsFromRows;
    window._budgetCache = _budgetCache;

    console.log('[BUDGET TRACKER] ✅ Loaded. getBudget(adsetId) / fetchBudget(accountId)');
})();
