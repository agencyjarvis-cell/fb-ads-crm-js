/**
 * snapshot_collector.js v3.0 — Ghost fix v2 + glitch detection + partial data skip — Ghost campaign fix + deltas + aggregates
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
    var DB_VERSION = 2;
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
            var store;
            if (!d.objectStoreNames.contains(STORE_NAME)) {
                store = d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('date', 'date', { unique: false });
                store.createIndex('synced', 'synced', { unique: false });
            } else {
                store = e.target.transaction.objectStore(STORE_NAME);
                if (!store.indexNames.contains('synced')) {
                    store.createIndex('synced', 'synced', { unique: false });
                }
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
        snapshot.synced = false;
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
                    // FIX: adset-level maxLeadsMemory (prevents CRM glitch lead drops)
                    var adsetLeads = Number(adset.leads) || 0;
                    var adsetId = adset.id || '';
                    var adsetMemKey = 'adset_' + adsetId;
                    if (maxLeadsMemory[adsetMemKey] !== undefined && maxLeadsMemory[adsetMemKey] > adsetLeads) {
                        adsetLeads = maxLeadsMemory[adsetMemKey];
                    }
                    maxLeadsMemory[adsetMemKey] = Math.max(maxLeadsMemory[adsetMemKey] || 0, adsetLeads);

                    adsets.push({
                        id: adsetId, name: adset.name || '',
                        account_id: cabId, status: adset.status || '',
                        budget: adset.daily_budget != null ? Number(adset.daily_budget) : (adset.budget != null ? Number(adset.budget) : null),
                        spend: Number(adset.spend) || 0,
                        impressions: Number(adset.impressions) || 0,
                        clicks: Number(adset.clicks) || 0,
                        leads: adsetLeads,
                        cpl: adsetLeads > 0 ? r4((Number(adset.spend) || 0) / adsetLeads) : null,
                        ctr: asd.ctr, cpm: asd.cpm, cpc: asd.cpc, cr: asd.cr,
                        ads: ads
                    });
                    totalAdsets++;
                }
            }

            // FIX: skip ghost campaigns (spend>0 but all adsets filtered as paused)
            if (adsets.length === 0) { ghostCampaigns++; continue; }

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

        // FIX: detect partial data — if cabinets count dropped >50% from previous, mark as partial
        var prevCabCount = parseInt(localStorage.getItem('snapshot_prev_cab_count') || '0');
        if (prevCabCount > 3 && cabinets.length < prevCabCount * 0.5) {
            console.warn('[Snapshot] PARTIAL DATA DETECTED: ' + cabinets.length + ' cabs vs ' + prevCabCount + ' previous. Skipping snapshot.');
            return null;
        }
        if (cabinets.length > 0) {
            localStorage.setItem('snapshot_prev_cab_count', String(cabinets.length));
        }

        // FIX: detect mass lead reset — if >30% of tracked adsets show leads=0 while prev had leads, skip
        var leadDropCount = 0, trackedCount = 0;
        for (var lci = 0; lci < cabinets.length; lci++) {
            for (var lcj = 0; lcj < cabinets[lci].campaigns.length; lcj++) {
                var lcamp = cabinets[lci].campaigns[lcj];
                for (var lck = 0; lck < (lcamp.adsets ? lcamp.adsets.length : 0); lck++) {
                    var las = lcamp.adsets[lck];
                    var lasMemKey = 'adset_' + las.id;
                    if (maxLeadsMemory[lasMemKey] && maxLeadsMemory[lasMemKey] > 2) {
                        trackedCount++;
                        if (las.leads === 0) leadDropCount++;
                    }
                }
            }
        }
        if (trackedCount > 5 && leadDropCount / trackedCount > 0.3) {
            console.warn('[Snapshot] CRM GLITCH DETECTED: ' + leadDropCount + '/' + trackedCount + ' adsets lost leads. Skipping snapshot.');
            return null;
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
            version: 5
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

    
    // ═══ SCHEDULED SYNC MODULE ═══
    var SYNC_SCHEDULE_HOURS = [6, 20]; // 06:00 and 20:00 Kyiv time
    var SYNC_RETRY_DELAYS = [60, 300, 900, 3600]; // 1m, 5m, 15m, 1h
    var SYNC_MAX_BATCH = 100;
    var syncRetryIndex = 0;
    var syncRetryTimer = null;
    var syncInProgress = false;

    function getKyivHour() {
        try {
            var s = new Date().toLocaleString('en-US', { timeZone: 'Europe/Kiev', hour12: false });
            return parseInt(s.split(',')[1].trim().split(':')[0]);
        } catch(e) { return new Date().getHours(); }
    }

    function getKyivTimeStr() {
        try {
            return new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit' });
        } catch(e) { return new Date().toLocaleTimeString(); }
    }

    function getSyncStatus() {
        try {
            var raw = localStorage.getItem('snapshot_sync_status');
            return raw ? JSON.parse(raw) : {};
        } catch(e) { return {}; }
    }

    function saveSyncStatus(status) {
        try {
            localStorage.setItem('snapshot_sync_status', JSON.stringify(status));
        } catch(e) {}
    }

    function getUnsyncedSnapshots(callback) {
        if (!db) return callback([]);
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var results = [];
        var req = store.openCursor();
        req.onsuccess = function(e) {
            var cursor = e.target.result;
            if (cursor) {
                if (!cursor.value.synced) {
                    results.push(cursor.value);
                }
                cursor.continue();
            } else {
                callback(results);
            }
        };
        req.onerror = function() { callback([]); };
    }

    function markAsSynced(ids, callback) {
        if (!db || !ids.length) { if (callback) callback(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var done = 0;
        for (var i = 0; i < ids.length; i++) {
            (function(id) {
                var getReq = store.get(id);
                getReq.onsuccess = function() {
                    var record = getReq.result;
                    if (record) {
                        record.synced = true;
                        record.syncedAt = new Date().toISOString();
                        store.put(record);
                    }
                    done++;
                    if (done >= ids.length && callback) callback();
                };
                getReq.onerror = function() {
                    done++;
                    if (done >= ids.length && callback) callback();
                };
            })(ids[i]);
        }
    }

    function syncToServer(isRetry) {
        if (!SYNC_ENABLED) {
            console.log('[Snapshot Sync] Server not configured. Use: snapshotAPI.server(url, token)');
            return;
        }
        if (syncInProgress) {
            console.log('[Snapshot Sync] Already in progress, skipping');
            return;
        }

        syncInProgress = true;
        console.log('[Snapshot Sync] Starting sync at ' + getKyivTimeStr() + '...');

        getUnsyncedSnapshots(function(unsynced) {
            if (unsynced.length === 0) {
                console.log('[Snapshot Sync] All snapshots already synced');
                syncInProgress = false;
                syncRetryIndex = 0;
                saveSyncStatus({
                    lastSync: new Date().toISOString(),
                    lastStatus: 'ok',
                    unsyncedCount: 0,
                    kyivTime: getKyivTimeStr()
                });
                updateSyncUI('ok', 0);
                return;
            }

            console.log('[Snapshot Sync] Found ' + unsynced.length + ' unsynced snapshots');

            // Batch in chunks of SYNC_MAX_BATCH
            var batches = [];
            for (var i = 0; i < unsynced.length; i += SYNC_MAX_BATCH) {
                batches.push(unsynced.slice(i, i + SYNC_MAX_BATCH));
            }

            var batchIndex = 0;
            var totalSynced = 0;
            var totalFailed = 0;

            function processBatch() {
                if (batchIndex >= batches.length) {
                    // All batches done
                    syncInProgress = false;
                    var allOk = totalFailed === 0;
                    console.log('[Snapshot Sync] Done: ' + totalSynced + ' synced, ' + totalFailed + ' failed');

                    saveSyncStatus({
                        lastSync: new Date().toISOString(),
                        lastStatus: allOk ? 'ok' : 'partial',
                        syncedCount: totalSynced,
                        failedCount: totalFailed,
                        kyivTime: getKyivTimeStr()
                    });

                    if (allOk) {
                        syncRetryIndex = 0;
                        updateSyncUI('ok', 0);
                    } else {
                        scheduleRetry();
                        updateSyncUI('error', totalFailed);
                    }
                    return;
                }

                var batch = batches[batchIndex];
                // Strip the 'id' and 'synced' fields before sending (server assigns its own IDs)
                var payload = batch.map(function(s) {
                    var copy = {};
                    for (var k in s) {
                        if (k !== 'id' && k !== 'synced' && k !== 'syncedAt') copy[k] = s[k];
                    }
                    return copy;
                });

                var xhr = new XMLHttpRequest();
                xhr.open('POST', SERVER_URL + '/api/snapshot/batch', true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('X-Snapshot-Token', SERVER_TOKEN);
                xhr.timeout = 30000;

                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            var resp = JSON.parse(xhr.responseText);
                            if (resp.ok || resp.received > 0) {
                                // Mark successfully synced snapshots
                                var syncedIds = [];
                                if (resp.results) {
                                    for (var r = 0; r < resp.results.length; r++) {
                                        if (resp.results[r].ok) {
                                            syncedIds.push(batch[resp.results[r].index].id);
                                        }
                                    }
                                } else {
                                    // All ok if no per-item results
                                    syncedIds = batch.map(function(s) { return s.id; });
                                }
                                totalSynced += syncedIds.length;
                                totalFailed += (batch.length - syncedIds.length);

                                markAsSynced(syncedIds, function() {
                                    console.log('[Snapshot Sync] Batch ' + (batchIndex + 1) + '/' + batches.length + ': ' + syncedIds.length + '/' + batch.length + ' ok');
                                    batchIndex++;
                                    processBatch();
                                });
                                return;
                            }
                        } catch(e) {}
                    }
                    // HTTP error or parse error
                    totalFailed += batch.length;
                    console.warn('[Snapshot Sync] Batch ' + (batchIndex + 1) + ' failed: HTTP ' + xhr.status);
                    batchIndex++;
                    processBatch();
                };

                xhr.onerror = function() {
                    totalFailed += batch.length;
                    console.warn('[Snapshot Sync] Batch ' + (batchIndex + 1) + ' network error');
                    batchIndex++;
                    processBatch();
                };

                xhr.ontimeout = function() {
                    totalFailed += batch.length;
                    console.warn('[Snapshot Sync] Batch ' + (batchIndex + 1) + ' timeout');
                    batchIndex++;
                    processBatch();
                };

                xhr.send(JSON.stringify({ snapshots: payload }));
            }

            processBatch();
        });
    }

    function scheduleRetry() {
        if (syncRetryTimer) clearTimeout(syncRetryTimer);
        if (syncRetryIndex >= SYNC_RETRY_DELAYS.length) {
            console.warn('[Snapshot Sync] Max retries reached, will try at next scheduled time');
            syncRetryIndex = 0;
            return;
        }
        var delay = SYNC_RETRY_DELAYS[syncRetryIndex];
        console.log('[Snapshot Sync] Retry in ' + delay + 's (attempt ' + (syncRetryIndex + 1) + ')');
        syncRetryTimer = setTimeout(function() {
            syncRetryIndex++;
            syncToServer(true);
        }, delay * 1000);
    }

    function startSyncScheduler() {
        // Check every 5 minutes if it's time to sync
        setInterval(function() {
            var hour = getKyivHour();
            var minute;
            try {
                var s = new Date().toLocaleString('en-US', { timeZone: 'Europe/Kiev', hour12: false });
                minute = parseInt(s.split(':')[1]);
            } catch(e) { minute = new Date().getMinutes(); }

            // Trigger sync at HH:00-HH:04 for scheduled hours
            if (SYNC_SCHEDULE_HOURS.indexOf(hour) !== -1 && minute < 5) {
                var status = getSyncStatus();
                var lastSync = status.lastSync ? new Date(status.lastSync) : null;
                var now = new Date();
                // Don't sync if last sync was less than 30 min ago (prevent double trigger)
                if (!lastSync || (now - lastSync) > 30 * 60 * 1000) {
                    console.log('[Snapshot Sync] Scheduled sync triggered at ' + getKyivTimeStr());
                    syncToServer(false);
                }
            }
        }, 5 * 60 * 1000); // every 5 min

        console.log('[Snapshot Sync] Scheduler started (sync at ' + SYNC_SCHEDULE_HOURS.join(':00, ') + ':00 Kyiv)');
    }

    function startupSync() {
        // On CRM startup, check if there are unsynced snapshots and sync them
        if (!SYNC_ENABLED) return;
        setTimeout(function() {
            getUnsyncedSnapshots(function(unsynced) {
                if (unsynced.length > 0) {
                    console.log('[Snapshot Sync] Startup: found ' + unsynced.length + ' unsynced, syncing...');
                    syncToServer(false);
                } else {
                    console.log('[Snapshot Sync] Startup: all synced');
                }
            });
        }, 30000); // 30s after startup (let CRM initialize first)
    }

    function updateSyncUI(status, pendingCount) {
        var el = document.getElementById('snapshot-sync-status');
        if (!el) return;
        if (status === 'ok') {
            el.textContent = 'synced';
            el.style.color = '#00ff88';
        } else if (status === 'error') {
            el.textContent = pendingCount + ' pending';
            el.style.color = '#ff4444';
        } else {
            el.textContent = 'syncing...';
            el.style.color = '#ffaa00';
        }
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
        w.innerHTML = '<span style="font-size:14px">S</span><span id="snapshot-count" style="color:#00d4ff;font-weight:bold">0</span><span style="color:#888;font-size:10px">snaps</span><span id="snapshot-timer" style="color:#888;font-size:10px"></span><span id="snapshot-sync-status" style="color:#888;font-size:10px"></span><span id="snapshot-status" style="width:6px;height:6px;border-radius:50%;background:#00ff88;display:inline-block"></span>';
        w.addEventListener('click', function(e) { e.stopPropagation(); toggleMenu(); });
        document.body.appendChild(w);

        var menu = document.createElement('div');
        menu.id = 'snapshot-menu';
        menu.style.cssText = 'position:fixed;bottom:40px;right:10px;z-index:100000;background:#1a1a2e;border:1px solid #16213e;border-radius:8px;padding:8px;font-family:monospace;font-size:12px;color:#e0e0e0;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:160px;';
        var btns = [
            { t: 'Snap Now', fn: captureSnapshot },
            { t: 'Sync Now', fn: function() { syncToServer(false); } },
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
        syncStatus: function() {
            var s = getSyncStatus();
            return { enabled: SYNC_ENABLED, url: SERVER_URL, lastSync: s.lastSync, lastStatus: s.lastStatus, unsyncedCount: s.unsyncedCount };
        },
        syncNow: syncToServer,
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
        startSyncScheduler();
        startupSync();
        setTimeout(function() {
            if (window.lastResults && window.lastResults.length > 0) {
                captureSnapshot();
            }
        }, 10000);
    });

    console.log('[Snapshot v3.0] Ghost fix + deltas + aggregates + scheduled cloud sync (06:00/20:00 Kyiv)');
})();
