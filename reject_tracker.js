/**
 * reject_tracker.js - T-CRM-V2-REJECT
 * Count rejected (DISAPPROVED) ads, show reject counter on cabinet cards,
 * and provide mock appeal button.
 */
(function() {
    'use strict';

    // HTML-escape helper to prevent XSS from ad/campaign/cabinet names
    function esc(s) {
        if (s == null) return '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    /**
     * Count rejected ads across all data
     */
    function countRejects(data) {
        var results = {
            total: 0,
            byCabinet: {},
            rejectedAds: []
        };

        (data || window.lastResults || []).forEach(function(row) {
            var cabId = row.adaccount_id || row.account_id || '';
            if (!results.byCabinet[cabId]) {
                results.byCabinet[cabId] = { count: 0, cabName: row.adaccount_name || row.account_name || cabId, ads: [] };
            }

            (row.adsets || []).forEach(function(adset) {
                (adset.ads || []).forEach(function(ad) {
                    var effStatus = (ad.effective_status || '').toUpperCase();
                    if (effStatus === 'DISAPPROVED') {
                        results.total++;
                        results.byCabinet[cabId].count++;
                        results.byCabinet[cabId].ads.push({
                            id: ad.id,
                            name: ad.name,
                            adsetId: adset.id || adset.adset_id,
                            adsetName: adset.name || adset.adset_name,
                            campaignName: row.campaign_name
                        });
                        results.rejectedAds.push({
                            id: ad.id,
                            name: ad.name,
                            cabId: cabId,
                            cabName: results.byCabinet[cabId].cabName,
                            adsetName: adset.name || adset.adset_name,
                            campaignName: row.campaign_name
                        });
                    }
                });
            });
        });

        return results;
    }

    /**
     * Submit appeal for a rejected ad (mock)
     */
    async function submitAppeal(adId, adName) {
        console.log('[REJECT] Submitting appeal for ad ' + adId + ' (' + adName + ')');
        try {
            var resp = await fetch('/api/appeal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ad_id: adId, ad_name: adName })
            });
            var data = await resp.json();
            if (data.success) {
                console.log('[REJECT] ✅ Appeal submitted for ' + adId);
                alert('Appeal submitted for: ' + (adName || adId));
                return true;
            } else {
                console.error('[REJECT] Appeal failed: ' + (data.error || 'unknown'));
                return false;
            }
        } catch (e) {
            console.error('[REJECT] Appeal error: ' + e.message);
            alert('Appeal error: ' + e.message);
            return false;
        }
    }

    /**
     * Inject reject badges into the campaign tree UI
     * Called after render to add reject counters
     */
    function injectRejectBadges() {
        var rejects = countRejects();
        if (rejects.total === 0) return;

        // Add reject counter to mini stats
        var miniStats = document.getElementById('step4MiniStats');
        if (miniStats && !document.getElementById('miniStatRejects')) {
            var divider = document.createElement('div');
            divider.style.cssText = 'width:1px;background:rgba(255,255,255,0.3);';
            var rejectDiv = document.createElement('div');
            rejectDiv.style.cssText = 'flex:1;text-align:center;';
            rejectDiv.innerHTML = '<div id="miniStatRejects" style="font-size:16px;font-weight:700;color:#ff6b6b;">' + rejects.total + '</div>' +
                                  '<div style="font-size:10px;opacity:0.85;">Rejects</div>';
            miniStats.appendChild(divider);
            miniStats.appendChild(rejectDiv);
        } else if (document.getElementById('miniStatRejects')) {
            document.getElementById('miniStatRejects').textContent = rejects.total;
        }
    }

    /**
     * Render reject panel (can be added to launch tab or standalone)
     */
    function renderRejectPanel() {
        var rejects = countRejects();
        var h = '<div style="margin-top:16px;">';
        h += '<h4 style="margin:0 0 12px 0;color:var(--text-primary,#333);">🚫 Rejected Ads (' + rejects.total + ')</h4>';

        if (rejects.total === 0) {
            h += '<div style="text-align:center;padding:20px;color:var(--text-secondary,#888);">No rejected ads</div>';
        } else {
            rejects.rejectedAds.forEach(function(ad) {
                h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:4px;border-radius:6px;background:var(--bg-card,#fff);border:1px solid #ffcdd2;">';
                h += '<div style="flex:1;">';
                h += '<div style="font-size:13px;font-weight:600;color:#c62828;">' + esc(ad.name || ad.id) + '</div>';
                h += '<div style="font-size:11px;color:var(--text-secondary,#888);">' + esc(ad.campaignName) + ' | ' + esc(ad.cabName) + '</div>';
                h += '</div>';
                h += '<button class="timer-btn" style="background:#ff9800;color:#fff;font-size:11px;padding:4px 10px;" data-appeal-ad="' + esc(ad.id) + '" data-appeal-name="' + esc(ad.name || '') + '">📝 Appeal</button>';
                h += '</div>';
            });
        }
        h += '</div>';
        return h;
    }

    // Hook into render cycle
    function patchRenderForRejects() {
        if (typeof window.renderActiveCampaignsTree === 'function' && !window._rejectPatchApplied) {
            var origRender = window.renderActiveCampaignsTree;
            window.renderActiveCampaignsTree = function() {
                var result = origRender.apply(this, arguments);
                setTimeout(injectRejectBadges, 100);
                return result;
            };
            window._rejectPatchApplied = true;
        }
    }

    patchRenderForRejects();
    var patchTimer = setInterval(function() {
        patchRenderForRejects();
        if (window._rejectPatchApplied) clearInterval(patchTimer);
    }, 500);
    setTimeout(function() { clearInterval(patchTimer); }, 15000);

    // Handle appeal button clicks via delegation
    document.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-appeal-ad]');
        if (btn) {
            var adId = btn.getAttribute('data-appeal-ad');
            var adName = btn.getAttribute('data-appeal-name');
            submitAppeal(adId, adName);
        }
    });

    // Export
    window.countRejects = countRejects;
    window.submitAppeal = submitAppeal;
    window.renderRejectPanel = renderRejectPanel;

    console.log('[REJECT TRACKER] ✅ Loaded. countRejects() / submitAppeal(adId)');
})();
