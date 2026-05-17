/**
 * snapshot_collector.js — MVP Snapshot Collector for FB Ads CRM
 * Periodically captures window.lastResults into IndexedDB.
 * Computes derived metrics: CTR, CPM, CPC, CR.
 * Provides export to JSON and a minimal UI counter.
 *
 * Loaded via crm_fix.js auto-load chain.
 * v1.2 — 2026-05-11
 * + creative_id (first 4 digits of ad name before dot)
 * + geo (campaign name prefix: KGNG=KG, USM=UZ, GP=TJ)
 * + cabinet account_id at every level for easy filtering
 * + budget (adset daily_budget if available)
 * + server sync (POST snapshots to remote server)
 */
(function() {
    'use strict';

    var DB_NAME = 'fb_ads_snapshots';
    var DB_VERSION = 1;
    var STORE_NAME = 'snapshots';
    var INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    var db = null;
    var snapshotCount = 0;
    var timerId = null;

    // Server Sync Config
    var SERVER_URL = localStorage.getItem('snapshot_server_url') || '';
    var SERVER_TOKEN = localStorage.getItem('snapshot_server_token') || '';
    var SYNC_ENABLED = !!(SERVER_URL && SERVER_TOKEN);

    // IndexedDB Setup
    function openDB(callback) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function(e) {
            var d = e.target.result;
            if (!d.objectStoreNames.contains(STORE_NAME)) {
                var store = d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('date', 'date', { unique: false });
            }
        };
        req.onsuccess = function(e) {
            db = e.target.result;
            countSnapshots(function(n) {
                snapshotCount = n;
                updateUI();
                if (callback) callback();
            });
        };
        req.onerror = function(e) {
            console.error('[Snapshot] DB open error:', e.target.error);
        };
    }

    function countSnapshots(callback) {
        if (!db) return callback(0);
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.count();
        req.onsuccess = function() { callback(req.result); };
        req.onerror = function() { callback(0); };
    }

    function saveSnapshot(snapshot, callback) {
        if (!db) return;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.add(snapshot);
        req.onsuccess = function() {
            snapshotCount++;
            updateUI();
            console.log('[Snapshot] Saved #' + snapshotCount + ' (' + snapshot.cabinets.length + ' cabinets, ' + snapshot.total_adsets + ' adsets)');
            if (callback) callback(true);
        };
        req.onerror = function(e) {
            console.error('[Snapshot] Save error:', e.target.error);
            if (callback) callback(false);
        };
    }

    function getAllSnapshots(callback) {
        if (!db) return callback([]);
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.getAll();
        req.onsuccess = function() { callback(req.result || []); };
        req.onerror = function() { callback([]); };
    }

    // Derived Metrics
    function calcDerived(obj) {
        var imp = Number(obj.impressions) || 0;
        var cl = Number(obj.clicks) || 0;
        var sp = Number(obj.spend) || 0;
        var ld = Number(obj.leads) || 0;
        return {
            ctr: imp > 0 ? round4(cl / imp * 100) : null,
            cpm: imp > 0 ? round4(sp / imp * 1000) : null,
            cpc: cl > 0 ? round4(sp / cl) : null,
            cr:  cl > 0 ? round4(ld / cl * 100) : null
        };
    }

    function round4(n) {
        return Math.round(n * 10000) / 10000;
    }

    // Extractors
    var GEO_MAP = {
        'KGNG': 'KG',
        'USM': 'UZ',
        'GP': 'TJ'
    };

    function extractGeo(campaignName) {
        if (!campaignName) return '';
        var prefix = campaignName.split('.')[0].split('-')[0].split('_')[0];
        return GEO_MAP[prefix] || prefix;
    }

    function extractCreativeId(adName) {
        if (!adName) return '';
        var match = adName.match(/^(\d{4})/);
        return match ? match[1] : '';
    }

    // Snapshot Builder
    function buildSnapshot() {
        var results = window.lastResults;
        if (!results || !Array.isArray(results) || results.length === 0) {
            return null;
        }

        var cabinetsMap = {};
        var totalAdsets = 0;
        var totalAds = 0;

        for (var i = 0; i < results.length; i++) {
            var campaign = results[i];
            var cabId = campaign.account_id || campaign.adaccount_id || 'unknown';

            if (!cabinetsMap[cabId]) {
                cabinetsMap[cabId] = {
                    account_id: cabId,
                    account_name: campaign.account_name || '',
                    profile_name: campaign.profile_name || '',
                    fbtool_account_id: campaign.fbtool_account_id || '',
                    campaigns: []
                };
            }

            var adsets = [];
            if (campaign.adsets && Array.isArray(campaign.adsets)) {
                for (var s = 0; s < campaign.adsets.length; s++) {
                    var adset = campaign.adsets[s];
                    var adsetDerived = calcDerived(adset);

                    var ads = [];
                    if (adset.ads && Array.isArray(adset.ads)) {
                        for (var a = 0; a < adset.ads.length; a++) {
                            var ad = adset.ads[a];
                            var adDerived = calcDerived(ad);
                            ads.push({
                                id: ad.id || '',
                                name: ad.name || '',
                                creative_id: extractCreativeId(ad.name),
                                account_id: cabId,
                                status: ad.status || '',
                                spend: Number(ad.spend) || 0,
                                impressions: Number(ad.impressions) || 0,
                                clicks: Number(ad.clicks) || 0,
                                leads: Number(ad.leads) || 0,
                                cpl: ad.cpl != null ? Number(ad.cpl) : null,
                                ctr: adDerived.ctr,
                                cpm: adDerived.cpm,
                                cpc: adDerived.cpc,
                                cr: adDerived.cr
                            });
                            totalAds++;
                        }
                    }

                    adsets.push({
                        id: adset.id || '',
                        name: adset.name || '',
                        account_id: cabId,
                        status: adset.status || '',
                        budget: adset.daily_budget != null ? Number(adset.daily_budget) : (adset.budget != null ? Number(adset.budget) : null),
                        spend: Number(adset.spend) || 0,
                        impressions: Number(adset.impressions) || 0,
                        clicks: Number(adset.clicks) || 0,
                        leads: Number(adset.leads) || 0,
                        cpl: adset.cpl != null ? Number(adset.cpl) : null,
                        ctr: adsetDerived.ctr,
                        cpm: adsetDerived.cpm,
                        cpc: adsetDerived.cpc,
                        cr: adsetDerived.cr,
                        ads: ads
                    });
                    totalAdsets++;
                }
            }

            var campDerived = calcDerived(campaign);
            var geo = extractGeo(campaign.campaign_name);
            cabinetsMap[cabId].campaigns.push({
                campaign_id: campaign.campaign_id || '',
                campaign_name: campaign.campaign_name || '',
                campaign_status: campaign.campaign_status || '',
                account_id: cabId,
                geo: geo,
                spend: Number(campaign.spend) || 0,
                impressions: Number(campaign.impressions) || 0,
                clicks: Number(campaign.clicks) || 0,
                leads: Number(campaign.leads) || 0,
                cpl: campaign.cpl != null ? Number(campaign.cpl) : null,
                ctr: campDerived.ctr,
                cpm: campDerived.cpm,
                cpc: campDerived.cpc,
                cr: campDerived.cr,
                adsets: adsets
            });
        }

        var cabinets = [];
        for (var key in cabinetsMap) {
            if (cabinetsMap.hasOwnProperty(key)) {
                cabinets.push(cabinetsMap[key]);
            }
        }

        var reportDate = '';
        if (window.lastCollectSettings && window.lastCollectSettings.date) {
            reportDate = window.lastCollectSettings.date;
        } else {
            var dateInput = document.getElementById('dateInput');
            if (dateInput) reportDate = dateInput.value || '';
        }

        return {
            timestamp: new Date().toISOString(),
            date: reportDate,
            cabinets: cabinets,
            total_cabinets: cabinets.length,
            total_campaigns: results.length,
            total_adsets: totalAdsets,
            total_ads: totalAds,
            version: 2
        };
    }

    // Server Sync
    function sendToServer(snapshot) {
        if (!SYNC_ENABLED) return;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', SERVER_URL + '/api/snapshot', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('X-Snapshot-Token', SERVER_TOKEN);
        xhr.timeout = 15000;
        xhr.onload = function() {
            if (xhr.status === 200) {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    console.log('[Snapshot] Synced to server (id=' + resp.id + ', total=' + resp.total_snapshots + ')');
                } catch(e) {
                    console.log('[Snapshot] Synced to server');
                }
            } else {
                console.warn('[Snapshot] Server sync failed: HTTP ' + xhr.status);
            }
        };
        xhr.onerror = function() {
            console.warn('[Snapshot] Server sync error (network)');
        };
        xhr.ontimeout = function() {
            console.warn('[Snapshot] Server sync timeout');
        };
        xhr.send(JSON.stringify(snapshot));
    }

    function configureServer(url, token) {
        SERVER_URL = (url || '').replace(/\/+$/, '');
        SERVER_TOKEN = token || '';
        SYNC_ENABLED = !!(SERVER_URL && SERVER_TOKEN);
        localStorage.setItem('snapshot_server_url', SERVER_URL);
        localStorage.setItem('snapshot_server_token', SERVER_TOKEN);
        console.log('[Snapshot] Server sync ' + (SYNC_ENABLED ? 'ENABLED: ' + SERVER_URL : 'DISABLED'));
        return SYNC_ENABLED;
    }

    // Capture Logic
    function captureSnapshot() {
        var snapshot = buildSnapshot();
        if (!snapshot) {
            console.log('[Snapshot] Skipped - no data in window.lastResults');
            return;
        }
        saveSnapshot(snapshot);
        sendToServer(snapshot);
    }

    function startAutoCapture() {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(captureSnapshot, INTERVAL_MS);
        console.log('[Snapshot] Auto-capture every ' + (INTERVAL_MS / 60000) + ' min');
    }

    function stopAutoCapture() {
        if (timerId) { clearInterval(timerId); timerId = null; }
        console.log('[Snapshot] Auto-capture stopped');
    }

    // Export
    function exportSnapshots() {
        getAllSnapshots(function(snapshots) {
            if (snapshots.length === 0) {
                alert('No snapshots to export');
                return;
            }
            var blob = new Blob([JSON.stringify(snapshots, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'fb_snapshots_' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[Snapshot] Exported ' + snapshots.length + ' snapshots');
        });
    }

    function clearSnapshots() {
        if (!db) return;
        if (!confirm('Delete all snapshots? (' + snapshotCount + ')')) return;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = function() {
            snapshotCount = 0;
            updateUI();
            console.log('[Snapshot] All snapshots cleared');
        };
    }

    // UI
    function createUI() {
        var container = document.createElement('div');
        container.id = 'snapshot-widget';
        container.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#1a1a2e;border:1px solid #16213e;border-radius:8px;padding:6px 10px;font-family:monospace;font-size:12px;color:#e0e0e0;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,0,0,0.3);user-select:none;transition:all 0.2s;';
        container.title = 'Snapshot Collector';

        container.innerHTML = '<span style="font-size:14px">S</span><span id="snapshot-count" style="color:#00d4ff;font-weight:bold">0</span><span style="color:#888;font-size:10px">snaps</span><span id="snapshot-status" style="width:6px;height:6px;border-radius:50%;background:#00ff88;display:inline-block" title="Active"></span>';

        container.addEventListener('click', function(e) { e.stopPropagation(); toggleMenu(); });
        container.addEventListener('mouseenter', function() { this.style.borderColor = '#00d4ff'; });
        container.addEventListener('mouseleave', function() { this.style.borderColor = '#16213e'; });
        document.body.appendChild(container);

        var menu = document.createElement('div');
        menu.id = 'snapshot-menu';
        menu.style.cssText = 'position:fixed;bottom:40px;right:10px;z-index:100000;background:#1a1a2e;border:1px solid #16213e;border-radius:8px;padding:8px;font-family:monospace;font-size:12px;color:#e0e0e0;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:160px;';

        var buttons = [
            { text: 'Snap Now', action: captureSnapshot },
            { text: 'Export JSON', action: exportSnapshots },
            { text: 'Stop Auto', action: function() { stopAutoCapture(); updateUI(); } },
            { text: 'Start Auto', action: function() { startAutoCapture(); updateUI(); } },
            { text: 'Clear All', action: clearSnapshots }
        ];

        for (var i = 0; i < buttons.length; i++) {
            var btn = document.createElement('div');
            btn.textContent = buttons[i].text;
            btn.style.cssText = 'padding:5px 8px;cursor:pointer;border-radius:4px;margin:2px 0;';
            btn.addEventListener('mouseenter', function() { this.style.background = '#16213e'; });
            btn.addEventListener('mouseleave', function() { this.style.background = 'transparent'; });
            (function(action) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    action();
                    menu.style.display = 'none';
                });
            })(buttons[i].action);
            menu.appendChild(btn);
        }

        document.body.appendChild(menu);
        document.addEventListener('click', function() { menu.style.display = 'none'; });
    }

    function toggleMenu() {
        var menu = document.getElementById('snapshot-menu');
        if (menu) { menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; }
    }

    function updateUI() {
        var countEl = document.getElementById('snapshot-count');
        if (countEl) countEl.textContent = snapshotCount;
        var statusEl = document.getElementById('snapshot-status');
        if (statusEl) {
            statusEl.style.background = timerId ? '#00ff88' : '#ff4444';
            statusEl.title = timerId ? 'Auto-capture active' : 'Auto-capture stopped';
        }
    }

    // Console API
    window.snapshotAPI = {
        capture: captureSnapshot,
        export: exportSnapshots,
        clear: clearSnapshots,
        start: startAutoCapture,
        stop: stopAutoCapture,
        count: function() { return snapshotCount; },
        getAll: getAllSnapshots,
        setInterval: function(minutes) {
            INTERVAL_MS = minutes * 60 * 1000;
            if (timerId) { stopAutoCapture(); startAutoCapture(); }
            console.log('[Snapshot] Interval set to ' + minutes + ' min');
        },
        server: configureServer,
        syncStatus: function() {
            return { enabled: SYNC_ENABLED, url: SERVER_URL, hasToken: !!SERVER_TOKEN };
        }
    };

    // Init
    openDB(function() {
        createUI();
        startAutoCapture();
        setTimeout(function() {
            if (window.lastResults && window.lastResults.length > 0) {
                captureSnapshot();
            }
        }, 10000);
    });

    console.log('[Snapshot Collector v1.2] Loaded - auto-capture every 30 min, IndexedDB + server sync');
})();
