/**
 * geo_toggle.js - T-CRM-V2-GEO-TOGGLE
 * Mass enable/disable adsets by geo.
 * "Our" campaigns = disabled campaign_status (PAUSED).
 * All management via adsets only — campaigns are never toggled.
 *
 * Adds "Launch" tab to Step 4 results tabs.
 */
(function() {
    'use strict';

    // ========== HELPERS ==========
    function getGeoFromRow(row) {
        if (row.geo) return row.geo;
        var name = row.campaign_name || row.campaign || '';
        var match = name.match(/^([A-Z]{2})-/);
        return match ? match[1] : '';
    }

    function isOurCampaign(row) {
        // Our campaign = disabled campaign_status
        var status = (row.campaign_status || row.campaign_effective_status || '').toUpperCase();
        return status === 'PAUSED' || status === 'DISABLED';
    }

    function getActiveAdsets(rows) {
        var adsets = [];
        (rows || []).forEach(function(row) {
            (row.adsets || []).forEach(function(a) {
                var st = (a.status || a.effective_status || '').toUpperCase();
                if (st === 'ACTIVE') {
                    adsets.push({
                        id: a.id || a.adset_id,
                        name: a.name || a.adset_name,
                        row: row
                    });
                }
            });
        });
        return adsets;
    }

    function getPausedAdsets(rows) {
        var adsets = [];
        (rows || []).forEach(function(row) {
            (row.adsets || []).forEach(function(a) {
                var st = (a.status || a.effective_status || '').toUpperCase();
                if (st === 'PAUSED') {
                    adsets.push({
                        id: a.id || a.adset_id,
                        name: a.name || a.adset_name,
                        row: row
                    });
                }
            });
        });
        return adsets;
    }

    // ========== GEO ANALYSIS ==========
    function getGeoSummary() {
        var data = window.lastResults || [];
        var geos = {};

        data.forEach(function(row) {
            var geo = getGeoFromRow(row);
            if (!geo) return;
            if (!geos[geo]) geos[geo] = { geo: geo, campaigns: [], activeAdsets: 0, pausedAdsets: 0, ourCampaigns: 0, totalSpend: 0 };

            geos[geo].campaigns.push(row);
            if (isOurCampaign(row)) geos[geo].ourCampaigns++;
            geos[geo].totalSpend += parseFloat(row.spend) || 0;

            (row.adsets || []).forEach(function(a) {
                var st = (a.status || a.effective_status || '').toUpperCase();
                if (st === 'ACTIVE') geos[geo].activeAdsets++;
                if (st === 'PAUSED') geos[geo].pausedAdsets++;
            });
        });

        return geos;
    }

    // ========== MASS ACTIONS ==========
    async function disableAdsetsByGeo(geo) {
        var data = window.lastResults || [];
        var targets = [];

        data.forEach(function(row) {
            if (getGeoFromRow(row) !== geo) return;
            if (!isOurCampaign(row)) return; // only our campaigns
            var active = getActiveAdsets([row]);
            targets = targets.concat(active);
        });

        if (!targets.length) {
            console.log('[GEO] No active adsets for geo ' + geo);
            if (typeof showNotification === 'function') showNotification('No active adsets for ' + geo);
            return 0;
        }

        console.log('[GEO] Disabling ' + targets.length + ' adsets for geo ' + geo);
        var disabled = 0;

        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            try {
                var normalizedAcct = (t.row.adaccount_id || t.row.account_id || '').replace(/^act_/, '');
                var resp = await fetch('/api/adsets/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        adset_id: t.id,
                        adaccount_id: normalizedAcct,
                        fbtool_account_id: t.row.fbtool_account_id,
                        status: 'PAUSED'
                    })
                });
                var data = await resp.json();
                if (data.success) {
                    disabled++;
                    console.log('[GEO] Disabled ' + t.name);
                }
            } catch (e) {
                console.error('[GEO] Error disabling ' + t.id + ': ' + e.message);
            }
        }

        console.log('[GEO] Disabled ' + disabled + '/' + targets.length + ' adsets for ' + geo);
        if (typeof showNotification === 'function') showNotification('Disabled ' + disabled + ' adsets for ' + geo);
        return disabled;
    }

    async function enableAdsetsByGeo(geo) {
        var data = window.lastResults || [];
        var targets = [];

        data.forEach(function(row) {
            if (getGeoFromRow(row) !== geo) return;
            if (!isOurCampaign(row)) return;
            var paused = getPausedAdsets([row]);
            targets = targets.concat(paused);
        });

        if (!targets.length) {
            console.log('[GEO] No paused adsets for geo ' + geo);
            if (typeof showNotification === 'function') showNotification('No paused adsets for ' + geo);
            return 0;
        }

        console.log('[GEO] Enabling ' + targets.length + ' adsets for geo ' + geo);
        var enabled = 0;

        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            try {
                var normalizedAcct = (t.row.adaccount_id || t.row.account_id || '').replace(/^act_/, '');
                var resp = await fetch('/api/adsets/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        adset_id: t.id,
                        adaccount_id: normalizedAcct,
                        fbtool_account_id: t.row.fbtool_account_id,
                        status: 'ACTIVE'
                    })
                });
                var data = await resp.json();
                if (data.success) {
                    enabled++;
                    console.log('[GEO] Enabled ' + t.name);
                }
            } catch (e) {
                console.error('[GEO] Error enabling ' + t.id + ': ' + e.message);
            }
        }

        console.log('[GEO] Enabled ' + enabled + '/' + targets.length + ' adsets for ' + geo);
        if (typeof showNotification === 'function') showNotification('Enabled ' + enabled + ' adsets for ' + geo);
        return enabled;
    }

    // ========== LAUNCH TAB UI ==========
    function injectLaunchTab() {
        var timerBtn = document.getElementById('resultsTabTimer');
        if (!timerBtn) { setTimeout(injectLaunchTab, 1000); return; }
        if (document.getElementById('resultsTabLaunch')) return;

        var btn = document.createElement('button');
        btn.id = 'resultsTabLaunch';
        btn.className = timerBtn.className;
        btn.textContent = '🚀 Запуск';
        btn.style.cssText = timerBtn.style.cssText;
        btn.onclick = function() { switchToLaunchTab(); };
        timerBtn.parentNode.insertBefore(btn, timerBtn.nextSibling);

        var section = document.createElement('div');
        section.id = 'launchSection';
        section.style.display = 'none';
        var timerSection = document.getElementById('timerSection');
        if (timerSection && timerSection.parentNode) {
            timerSection.parentNode.insertBefore(section, timerSection.nextSibling);
        }

        // Patch switchResultsTab to hide launch section
        var prevSwitch = window.switchResultsTab;
        if (typeof prevSwitch === 'function' && !window._launchTabPatched) {
            window.switchResultsTab = function(tab) {
                var ls = document.getElementById('launchSection');
                var lb = document.getElementById('resultsTabLaunch');
                if (ls) ls.style.display = 'none';
                if (lb) lb.classList.remove('active');
                prevSwitch(tab);
            };
            window._launchTabPatched = true;
        }
    }

    function switchToLaunchTab() {
        var sections = ['statsTabSection', 'allCabinetsSection', 'autoRulesV2Section', 'timerSection'];
        sections.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        var sortBar = document.getElementById('resultsSortBar');
        if (sortBar) sortBar.style.display = 'none';

        ['resultsTabActive', 'resultsTabAll', 'resultsTabAutoV2', 'resultsTabTimer'].forEach(function(id) {
            var b = document.getElementById(id);
            if (b) b.classList.remove('active');
        });

        var launchBtn = document.getElementById('resultsTabLaunch');
        var launchSection = document.getElementById('launchSection');
        if (launchBtn) launchBtn.classList.add('active');
        if (launchSection) {
            launchSection.style.display = 'block';
            renderLaunchPanel();
        }
        window.currentResultsTab = 'launch';
    }

    function renderLaunchPanel() {
        var section = document.getElementById('launchSection');
        if (!section) return;

        var geos = getGeoSummary();
        var geoKeys = Object.keys(geos).sort();

        var h = '<div style="padding:16px 0;">';
        h += '<h3 style="margin:0 0 16px 0;color:var(--text-primary,#333);">🚀 Запуск / Остановка по гео</h3>';
        h += '<p style="color:var(--text-secondary,#888);font-size:13px;margin-bottom:16px;">';
        h += '"Наши" кампании = с выключенным campaign_status. Управление только через adsets.</p>';

        if (!geoKeys.length) {
            h += '<div style="text-align:center;padding:40px;color:var(--text-secondary,#888);">No geo data. Load data first.</div>';
        } else {
            geoKeys.forEach(function(geo) {
                var g = geos[geo];
                h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;margin-bottom:8px;border-radius:8px;background:var(--bg-card,#fff);border:1px solid var(--border,#e0e0e0);">';
                h += '<div>';
                h += '<span style="font-size:18px;font-weight:700;color:var(--text-primary,#333);">🌍 ' + geo + '</span>';
                h += '<span style="font-size:12px;color:var(--text-secondary,#888);margin-left:12px;">';
                h += g.campaigns.length + ' campaigns | ' + g.ourCampaigns + ' our | ';
                h += g.activeAdsets + ' active, ' + g.pausedAdsets + ' paused | $' + g.totalSpend.toFixed(2);
                h += '</span>';
                h += '</div>';
                h += '<div style="display:flex;gap:8px;">';
                if (g.activeAdsets > 0) {
                    h += '<button class="timer-btn" style="background:#c62828;color:#fff;font-size:12px;padding:6px 14px;" data-geo-disable="' + geo + '">⏸ Выключить ' + geo + '</button>';
                }
                if (g.pausedAdsets > 0) {
                    h += '<button class="timer-btn" style="background:#2e7d32;color:#fff;font-size:12px;padding:6px 14px;" data-geo-enable="' + geo + '">▶ Включить ' + geo + '</button>';
                }
                h += '</div>';
                h += '</div>';
            });
        }
        h += '</div>';
        section.innerHTML = h;

        // Bind events
        section.querySelectorAll('[data-geo-disable]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var geo = this.getAttribute('data-geo-disable');
                if (confirm('Disable all active adsets for geo ' + geo + '?')) {
                    disableAdsetsByGeo(geo).then(function() { renderLaunchPanel(); });
                }
            });
        });
        section.querySelectorAll('[data-geo-enable]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var geo = this.getAttribute('data-geo-enable');
                if (confirm('Enable paused adsets for geo ' + geo + '?')) {
                    enableAdsetsByGeo(geo).then(function() { renderLaunchPanel(); });
                }
            });
        });
    }

    // Export
    window.getGeoSummary = getGeoSummary;
    window.disableAdsetsByGeo = disableAdsetsByGeo;
    window.enableAdsetsByGeo = enableAdsetsByGeo;

    // Init
    function init() {
        if (!document.getElementById('resultsTabTimer')) {
            setTimeout(init, 1000);
            return;
        }
        injectLaunchTab();
        console.log('[GEO TOGGLE] ✅ Launch tab added');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 2000); });
    } else {
        setTimeout(init, 2000);
    }
})();
