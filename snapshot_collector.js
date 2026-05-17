/**
 * snapshot_collector.js v2.0 — Ghost campaign fix + deltas + aggregates
 * - STRICT: only campaigns with spend>0 OR active adsets with spend>0
 * - Strips CRM-injected leads from $0-spend campaigns (ghost fix)
 * - Delta tracking: spend/leads change since previous snapshot
 * - Max leads memory: prevents CRM sync drops
 * - Top-level aggregates: total_spend, total_leads, avg_cpl
 * - Adset name as cabinet display name
 * - IndexedDB + optional server sync
 * - 30 min auto-capture interval
 */
(function() {
    'use strict';

    var DB_NAME = 'fb_ads_snapshots';
    var DB_VERSION = 1;
    var STORE_NAME = 'snapshots';
    var INTERVAL_MS = 30 * 60 * 1000;
    var db = null;
    var snapshotCount = 0;
    var timerId = null;
    var lastCaptureTime = null;

    var SERVER_URL = localStorage.getItem('snapshot_server_url') || '';
    var SERVER_TOKEN = localStorage.getItem('snapshot_server_token') || '';
    var SYNC_ENABLED = !!(SERVER_URL && SERVER_TOKEN);

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
        req.onerror = function(e) { console.error('[Snapshot] DB error:', e.target.error); };
    }

    function countSnapshots(callback) {
        if (!db) return callback(0);
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = function() { callback(req.result); };
        req.onerror = function() { callback(0); };
    }

    function saveSnapshot(snapshot, callback) {
        if (!db) return;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var req = tx.objectStore(STORE_NAME).add(snapshot);
        req.onsuccess = function() {
            snapshotCount++;
            lastCaptureTime = Date.now();
            updateUI();
            console.log('[Snapshot] Saved #' + snapshotCount + ' (' + snapshot.total_cabinets + ' cabs, ' + snapshot.total_adsets + ' adsets, CPL=$' + (snapshot.avg_cpl || 'N/A') + ')');
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
        var req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = function() { callback(req.result || []); };
        req.onerror = function() { callback([]); };
    }

    function deleteAllSnapshots(callback) {
        if (!db) return;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = function() {
            snapshotCount = 0;
            updateUI();
            console.log('[Snapshot] DB cleared');
            if (callback) callback();
        };
    }

    var prevSnapshotData = null;
    var maxLeadsMemory = {};

    function isCampaignReal(campaign) {
        if (Number(campaign.spend) > 0) return true;
        if (campaign.adsets && Array.isArray(campaign.adsets)) {
            for (var i = 0; i < campaign.adsets.length; i++) {
                if (Number(campaign.adsets[i].spend) > 0) return true;
            }
        }
        return false;
    }

    function cleanLeads(campaign) {
        if (campaign.adsets && Array.isArray(campaign.adsets)) {
            for (var i = 0; i < campaign.adsets.length; i++) {
                var adset = campaign.adsets[i];
                if (Number(adset.spend) === 0) {
                    adset.leads = 0;
                    adset.cpl = null;
                    if (adset.ads && Array.isArray(adset.ads)) {
                        for (var a = 0; a < adset.ads.length; a++) {
                            adset.ads[a].leads = 0;
                            adset.ads[a].cpl = null;
                        }
                    }
                }
            }
        }
    }

    function getAdsetDisplayName(campaigns) {
        for (var i = 0; i < campaigns.length; i++) {
            var c = campaigns[i];
            if (c.adsets && c.adsets.length > 0) {
                for (var j = 0; j < c.adsets.length; j++) {
                    if (Number(c.adsets[j].spend) > 0 && c.adsets[j].name) return c.adsets[j].name;
                }
                if (c.adsets[0].name) return c.adsets[0].name;
            }
        }
        return '';
    }

    function calcDerived(obj) {
        var imp = Number(obj.impressions) || 0;
        var cl = Number(obj.clicks) || 0;
        var sp = Number(obj.spend) || 0;
        var ld = Number(obj.leads) || 0;
        return {
            ctr: imp > 0 ? r4(cl / imp * 100) : null,
            cpm: imp > 0 ? r4(sp / imp * 1000) : null,
            cpc: cl > 0 ? r4(sp / cl) : null,
            cr:  cl > 0 ? r4(ld / cl * 100) : null
        };
    }
    function r4(n) { return Math.round(n * 10000) / 10000; }

    var GEO_MAP = { 'KGNG': 'KG', 'USM': 'UZ', 'GP': 'TJ' };
    function extractGeo(name) {
        if (!name) return '';
        var p = name.split('.')[0].split('-')[0].split('_')[0];
        return GEO_MAP[p] || p;
    }
    function extractCreativeId(name) {
        if (!name) return '';
        var m = name.match(/^(\d{4})/);
        return m ? m[1] : '';
    }

    function buildSnapshot() {
        var results = window.lastResults;
        if (!results || !Array.isArray(results) || results.length === 0) return null;

        var cabinetsMap = {};
        var totalAdsets = 0, totalAds = 0, ghostCampaigns = 0;

        for (var i = 0; i < results.length; i++) {
            var campaign = results[i];
            if (!isCampaignReal(campaign)) { ghostCampaigns++; continue; }
            cleanLeads(campaign);

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
                    var adsetSt = String(adset.status || adset.effective_status || '').toUpperCase();
                    if (adsetSt.indexOf('ACTIVE') < 0) continue;
                    var asd = calcDerived(adset);
                    var ads = [];
                    if (adset.ads && Array.isArray(adset.ads)) {
                        for (var a = 0; a < adset.ads.length; a++) {
                            var ad = adset.ads[a];
                            var add = calcDerived(ad);
                            ads.push({
                                id: ad.id || '', name: ad.name || '',
                                creative_id: extractCreativeId(ad.name),
                                account_id: cabId, status: ad.status || '',
                                spend: Number(ad.spend) || 0,
                                impressions: Number(ad.impressions) || 0,
                                clicks: Number(ad.clicks) || 0,
                                leads: Number(ad.leads) || 0,
                                cpl: ad.cpl != null ? Number(ad.cpl) : null,
                                ctr: add.ctr, cpm: add.cpm, cpc: add.cpc, cr: add.cr
                            });
                            totalAds++;
                        }
                    }
                    adsets.push({
                        id: adset.id || '', name: adset.name || '',
                        account_id: cabId, status: adset.status || '',
                        budget: adset.daily_budget != null ? Number(adset.daily_budget) : (adset.budget != null ? Number(adset.budget) : null),
                        spend: Number(adset.spend) || 0,
                        impressions: Number(adset.impressions) || 0,
                        clicks: Number(adset.clicks) || 0,
                        leads: Number(adset.leads) || 0,
                        cpl: adset.cpl != null ? Number(adset.cpl) : null,
                        ctr: asd.ctr, cpm: asd.cpm, cpc: asd.cpc, cr: asd.cr,
                        ads: ads
                    });
                    totalAdsets++;
                }
            }

            var cd = calcDerived(campaign);
            cabinetsMap[cabId].campaigns.push({
                campaign_id: campaign.campaign_id || '',
                campaign_name: campaign.campaign_name || '',
                campaign_status: campaign.campaign_status || '',
                account_id: cabId,
                geo: extractGeo(campaign.campaign_name),
                spend: Number(campaign.spend) || 0,
                impressions: Number(campaign.impressions) || 0,
                clicks: Number(campaign.clicks) || 0,
                leads: Number(campaign.leads) || 0,
                cpl: campaign.cpl != null ? Number(campaign.cpl) : null,
                ctr: cd.ctr, cpm: cd.cpm, cpc: cd.cpc, cr: cd.cr,
                adsets: adsets
            });
        }

        var cabinets = [];
        for (var key in cabinetsMap) {
            if (cabinetsMap.hasOwnProperty(key)) {
                var cab = cabinetsMap[key];
                cab.display_name = getAdsetDisplayName(cab.campaigns);
                cabinets.push(cab);
            }
        }

        var reportDate = '';
        if (window.lastCollectSettings && window.lastCollectSettings.date) {
            reportDate = window.lastCollectSettings.date;
        } else {
            var di = document.getElementById('dateInput');
            if (di) reportDate = di.value || '';
        }

        var fbtoolTimestamp = null;
        if (window.lastCollectTimestamp) {
            fbtoolTimestamp = new Date(window.lastCollectTimestamp).toISOString();
        } else if (window.lastCollectTime) {
            fbtoolTimestamp = new Date(window.lastCollectTime).toISOString();
        }

        var aggSpend = 0, aggLeads = 0, aggClicks = 0, aggImpressions = 0;
        for (var ci2 = 0; ci2 < cabinets.length; ci2++) {
            for (var cj = 0; cj < cabinets[ci2].campaigns.length; cj++) {
                var c = cabinets[ci2].campaigns[cj];
                aggSpend += c.spend;
                aggLeads += c.leads;
                aggClicks += c.clicks;
                aggImpressions += c.impressions;
            }
        }

        var currentCampData = {};
        for (var ci3 = 0; ci3 < cabinets.length; ci3++) {
            for (var cj2 = 0; cj2 < cabinets[ci3].campaigns.length; cj2++) {
                var camp2 = cabinets[ci3].campaigns[cj2];
                var campId2 = camp2.campaign_id;
                currentCampData[campId2] = { spend: camp2.spend, leads: camp2.leads };
                if (maxLeadsMemory[campId2] !== undefined && maxLeadsMemory[campId2] > camp2.leads) {
                    camp2.leads = maxLeadsMemory[campId2];
                    camp2.cpl = camp2.leads > 0 ? r4(camp2.spend / camp2.leads) : null;
                }
                maxLeadsMemory[campId2] = Math.max(maxLeadsMemory[campId2] || 0, camp2.leads);
            }
        }

        aggLeads = 0;
        for (var ci4 = 0; ci4 < cabinets.length; ci4++) {
            for (var cj3 = 0; cj3 < cabinets[ci4].campaigns.length; cj3++) {
                aggLeads += cabinets[ci4].campaigns[cj3].leads;
            }
        }

        var deltaSpend = null, deltaLeads = null;
        if (prevSnapshotData) {
            var prevTotalSpend = 0, prevTotalLeads = 0;
            for (var pk in prevSnapshotData) {
                prevTotalSpend += prevSnapshotData[pk].spend;
                prevTotalLeads += prevSnapshotData[pk].leads;
            }
            deltaSpend = r4(aggSpend - prevTotalSpend);
            deltaLeads = aggLeads - prevTotalLeads;
        }

        prevSnapshotData = {};
        for (var dk in currentCampData) {
            prevSnapshotData[dk] = currentCampData[dk];
        }

        if (ghostCampaigns > 0) {
            console.log('[Snapshot] Filtered ' + ghostCampaigns + ' ghost campaigns (spend=$0 with CRM leads)');
        }

        return {
            timestamp: new Date().toISOString(),
            fbtool_timestamp: fbtoolTimestamp,
            date: reportDate,
            cabinets: cabinets,
            total_cabinets: cabinets.length,
            total_campaigns: cabinets.reduce(function(s,c){ return s + c.campaigns.length; }, 0),
            total_adsets: totalAdsets,
            total_ads: totalAds,
            total_spend: r4(aggSpend),
            total_leads: aggLeads,
            avg_cpl: aggLeads > 0 ? r4(aggSpend / aggLeads) : null,
            avg_ctr: aggImpressions > 0 ? r4(aggClicks / aggImpressions * 100) : null,
            delta_spend: deltaSpend,
            delta_leads: deltaLeads,
            ghost_campaigns_filtered: ghostCampaigns,
            version: 4
        };
    }

    function sendToServer(snapshot) {
        if (!SYNC_ENABLED) return;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', SERVER_URL + '/api/snapshot', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('X-Snapshot-Token', SERVER_TOKEN);
        xhr.timeout = 15000;
        xhr.onload = function() {
            if (xhr.status === 200) console.log('[Snapshot] Synced to server');
            else console.warn('[Snapshot] Server sync failed: ' + xhr.status);
        };
        xhr.onerror = function() { console.warn('[Snapshot] Server sync error'); };
        xhr.send(JSON.stringify(snapshot));
    }

    function configureServer(url, token) {
        SERVER_URL = (url || '').replace(/\/+$/, '');
        SERVER_TOKEN = token || '';
        SYNC_ENABLED = !!(SERVER_URL && SERVER_TOKEN);
        localStorage.setItem('snapshot_server_url', SERVER_URL);
        localStorage.setItem('snapshot_server_token', SERVER_TOKEN);
        console.log('[Snapshot] Server ' + (SYNC_ENABLED ? 'ON: ' + SERVER_URL : 'OFF'));
        return SYNC_ENABLED;
    }

    function captureSnapshot() {
        var snapshot = buildSnapshot();
        if (!snapshot) { console.log('[Snapshot] Skip - no active data'); return; }
        if (snapshot.total_adsets === 0) { console.log('[Snapshot] Skip - 0 active adsets'); return; }
        saveSnapshot(snapshot);
        sendToServer(snapshot);
    }

    function startAutoCapture() {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(function() {
            console.log('[Snapshot] Auto-capture tick');
            captureSnapshot();
        }, INTERVAL_MS);
        console.log('[Snapshot] Auto every ' + (INTERVAL_MS / 60000) + ' min');
    }

    function stopAutoCapture() {
        if (timerId) { clearInterval(timerId); timerId = null; }
        console.log('[Snapshot] Auto stopped');
    }

    function exportSnapshots() {
        getAllSnapshots(function(snaps) {
            if (snaps.length === 0) { alert('No snapshots'); return; }
            var blob = new Blob([JSON.stringify(snaps, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'fb_snapshots_' + new Date().toISOString().slice(0,10) + '.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    function clearSnapshots() {
        if (!confirm('Delete ALL ' + snapshotCount + ' snapshots?')) return;
        deleteAllSnapshots();
    }

    function createUI() {
        var w = document.createElement('div');
        w.id = 'snapshot-widget';
        w.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#1a1a2e;border:1px solid #16213e;border-radius:8px;padding:6px 10px;font-family:monospace;font-size:12px;color:#e0e0e0;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,0,0,0.3);user-select:none;';
        w.title = 'Snapshot Collector';
        w.innerHTML = '<span style="font-size:14px">S</span><span id="snapshot-count" style="color:#00d4ff;font-weight:bold">0</span><span style="color:#888;font-size:10px">snaps</span><span id="snapshot-timer" style="color:#888;font-size:10px"></span><span id="snapshot-status" style="width:6px;height:6px;border-radius:50%;background:#00ff88;display:inline-block"></span>';
        w.addEventListener('click', function(e) { e.stopPropagation(); toggleMenu(); });
        document.body.appendChild(w);

        var menu = document.createElement('div');
        menu.id = 'snapshot-menu';
        menu.style.cssText = 'position:fixed;bottom:40px;right:10px;z-index:100000;background:#1a1a2e;border:1px solid #16213e;border-radius:8px;padding:8px;font-family:monospace;font-size:12px;color:#e0e0e0;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:160px;';
        var btns = [
            { t: 'Snap Now', fn: captureSnapshot },
            { t: 'Export JSON', fn: exportSnapshots },
            { t: 'Stop Auto', fn: function() { stopAutoCapture(); updateUI(); } },
            { t: 'Start Auto', fn: function() { startAutoCapture(); updateUI(); } },
            { t: 'Clear DB', fn: clearSnapshots }
        ];
        for (var i = 0; i < btns.length; i++) {
            var b = document.createElement('div');
            b.textContent = btns[i].t;
            b.style.cssText = 'padding:5px 8px;cursor:pointer;border-radius:4px;margin:2px 0;';
            b.addEventListener('mouseenter', function() { this.style.background = '#16213e'; });
            b.addEventListener('mouseleave', function() { this.style.background = 'transparent'; });
            (function(fn) { b.addEventListener('click', function(e) { e.stopPropagation(); fn(); menu.style.display = 'none'; }); })(btns[i].fn);
            menu.appendChild(b);
        }
        document.body.appendChild(menu);
        document.addEventListener('click', function() { menu.style.display = 'none'; });
        setInterval(updateTimerDisplay, 60000);
    }

    function toggleMenu() {
        var m = document.getElementById('snapshot-menu');
        if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
    }

    function updateUI() {
        var c = document.getElementById('snapshot-count');
        if (c) c.textContent = snapshotCount;
        var s = document.getElementById('snapshot-status');
        if (s) { s.style.background = timerId ? '#00ff88' : '#ff4444'; }
        updateTimerDisplay();
    }

    function updateTimerDisplay() {
        var el = document.getElementById('snapshot-timer');
        if (!el || !lastCaptureTime) return;
        var mins = Math.round((Date.now() - lastCaptureTime) / 60000);
        el.textContent = mins + 'm ago';
    }

    window.snapshotAPI = {
        capture: captureSnapshot,
        export: exportSnapshots,
        clear: clearSnapshots,
        start: startAutoCapture,
        stop: stopAutoCapture,
        count: function() { return snapshotCount; },
        getAll: getAllSnapshots,
        deleteAll: deleteAllSnapshots,
        setInterval: function(min) {
            INTERVAL_MS = min * 60 * 1000;
            if (timerId) { stopAutoCapture(); startAutoCapture(); }
            console.log('[Snapshot] Interval: ' + min + ' min');
        },
        server: configureServer,
        syncStatus: function() { return { enabled: SYNC_ENABLED, url: SERVER_URL }; },
        status: function() {
            return {
                count: snapshotCount,
                autoActive: !!timerId,
                intervalMin: INTERVAL_MS / 60000,
                lastCapture: lastCaptureTime ? new Date(lastCaptureTime).toLocaleTimeString() : 'never',
                serverSync: SYNC_ENABLED
            };
        }
    };

    openDB(function() {
        createUI();
        startAutoCapture();
        setTimeout(function() {
            if (window.lastResults && window.lastResults.length > 0) {
                captureSnapshot();
            }
        }, 10000);
    });

    console.log('[Snapshot v2.0] Ghost fix + deltas + max_leads + aggregates, 30min, IndexedDB + server sync');
})();
