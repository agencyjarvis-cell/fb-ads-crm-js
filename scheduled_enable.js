// === SCHEDULED ADSET ENABLE v2.0 (crm_fix addon) ===
// v2.0: + serial execution (5s gap) + retry logic (5m, 15m, 30m, 1h)
// Fixes 502 flooding issue from v1 where all enables fired simultaneously.
//
// Usage from console:
//   scheduleEnable('adset_id_here', '05:00')
//   scheduleEnable('adset_id_here', '2026-05-05 05:00')
//   scheduleEnableBatch(["id1","id2"], "05:00")
//   listScheduled()
//   cancelScheduled('adset_id_here')
//   cancelAllScheduled()

(function(){
    var KYIV_OFFSET = 3; // GMT+3 (EEST, summer time)
    var ENABLE_GAP_MS = 5000; // 5 sec between serial enables
    var RETRY_DELAYS = [5*60*1000, 15*60*1000, 30*60*1000, 60*60*1000]; // 5m, 15m, 30m, 1h

    if (!window._scheduledEnables) window._scheduledEnables = {};
    if (!window._retryQueue) window._retryQueue = {};

    // ========== localStorage PERSISTENCE ==========
    var LS_KEY = 'crm_scheduled_timers';

    function saveTimersToStorage() {
        try {
            var data = {};
            var timers = window._scheduledEnables;
            for (var id in timers) {
                if (!timers.hasOwnProperty(id)) continue;
                var t = timers[id];
                data[id] = {
                    kyivTimeISO: t.time.toISOString(),
                    label: t.label,
                    adsetName: t.adsetName,
                    batchId: t.batchId || null
                };
            }
            localStorage.setItem(LS_KEY, JSON.stringify(data));
            console.log('[TIMER] Saved ' + Object.keys(data).length + ' timers to localStorage');
        } catch(e) {
            console.warn('[TIMER] localStorage save failed:', e.message);
        }
    }

    function restoreTimersFromStorage() {
        try {
            var raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            var restored = 0;
            var expired = 0;

            // Group entries by batchId (or singleton) and bucket by absolute time.
            var batches = {};  // batchKey -> { kyivTime, ids: [], delayMs, batchId }
            for (var id in data) {
                if (!data.hasOwnProperty(id)) continue;
                var entry = data[id];
                var kyivTime = new Date(entry.kyivTimeISO);
                var kyivNow = getKyivNow();
                var delayMs = kyivTime.getTime() - kyivNow.getTime();

                if (delayMs <= 0) { expired++; continue; }

                var key = entry.batchId ? ('batch:' + entry.batchId) : ('single:' + id);
                if (!batches[key]) {
                    batches[key] = { kyivTime: kyivTime, delayMs: delayMs, batchId: entry.batchId || null, ids: [], names: {}, labels: {} };
                }
                batches[key].ids.push(id);
                batches[key].names[id] = entry.adsetName || id;
                batches[key].labels[id] = entry.label || formatKyiv(kyivTime) + ' Kyiv';
            }

            for (var key in batches) {
                if (!batches.hasOwnProperty(key)) continue;
                var b = batches[key];
                var timerId = (function(bRef) {
                    return setTimeout(function() {
                        var memberIds = bRef.ids.filter(function(mid) {
                            return window._scheduledEnables[mid];
                        });
                        console.log('[TIMER] Restored ' + (bRef.batchId ? 'batch' : 'timer') +
                                    ' fired for ' + memberIds.length + '/' + bRef.ids.length + ' adsets');
                        if (memberIds.length) executeEnablesBatch(memberIds);
                    }, bRef.delayMs);
                })(b);

                b.ids.forEach(function(mid) {
                    window._scheduledEnables[mid] = {
                        time: b.kyivTime,
                        timerId: timerId,
                        batchId: b.batchId,
                        label: b.labels[mid],
                        adsetName: b.names[mid]
                    };
                    restored++;
                });
            }

            if (expired > 0) {
                saveTimersToStorage();
            }
            if (restored > 0) {
                console.log('[TIMER] Restored ' + restored + ' timers from localStorage (' + expired + ' expired)');
            }
        } catch(e) {
            console.warn('[TIMER] localStorage restore failed:', e.message);
        }
    }

    // Restore on load
    restoreTimersFromStorage();

    function getKyivNow() {
        var now = new Date();
        var kyivMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (KYIV_OFFSET * 3600000);
        return new Date(kyivMs);
    }

    function formatKyiv(date) {
        var d = new Date(date.getTime());
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
               ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function parseKyivTime(timeStr) {
        var now = getKyivNow();
        var year, month, day, hours, minutes;

        if (timeStr.indexOf('-') !== -1) {
            var dateParts = timeStr.split(' ');
            var dParts = dateParts[0].split('-');
            var tParts = dateParts[1].split(':');
            year = parseInt(dParts[0]);
            month = parseInt(dParts[1]) - 1;
            day = parseInt(dParts[2]);
            hours = parseInt(tParts[0]);
            minutes = parseInt(tParts[1]) || 0;
        } else {
            var tParts2 = timeStr.split(':');
            hours = parseInt(tParts2[0]);
            minutes = parseInt(tParts2[1]) || 0;
            year = now.getFullYear();
            month = now.getMonth();
            day = now.getDate();
        }

        var targetKyiv = new Date(year, month, day, hours, minutes, 0);
        if (timeStr.indexOf('-') === -1 && targetKyiv <= now) {
            targetKyiv.setDate(targetKyiv.getDate() + 1);
        }

        var systemNow = new Date();
        var kyivNow = getKyivNow();
        var diffMs = targetKyiv.getTime() - kyivNow.getTime();

        return { systemTime: new Date(systemNow.getTime() + diffMs), kyivTime: targetKyiv, delayMs: diffMs };
    }

    function findAdsetName(adsetId) {
        if (!window.lastResults) return adsetId;
        for (var i = 0; i < window.lastResults.length; i++) {
            var c = window.lastResults[i];
            if (!c.adsets) continue;
            for (var j = 0; j < c.adsets.length; j++) {
                var a = c.adsets[j];
                if ((a.id || a.adset_id) === adsetId) return a.name || a.adset_name || adsetId;
            }
        }
        return adsetId;
    }

    function findCabinetForAdset(adsetId) {
        var rows = window.lastResults || window.currentMatchedRows;
        if (!rows || !rows.length) return null;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row) continue;
            if (row.adset_id === adsetId) {
                return { id: row.adaccount_id || row.account_id, fbtool_account_id: row.fbtool_account_id };
            }
            if (row.adsets && row.adsets.length) {
                for (var j = 0; j < row.adsets.length; j++) {
                    var a = row.adsets[j];
                    if (a && (a.id === adsetId || a.adset_id === adsetId)) {
                        return { id: row.adaccount_id || row.account_id, fbtool_account_id: row.fbtool_account_id };
                    }
                }
            }
        }
        return null;
    }

    async function enableAdset(adsetId) {
        try {
            var cabinet = findCabinetForAdset(adsetId);
            if (!cabinet) {
                console.error('[TIMER] Cabinet not found for adset ' + adsetId);
                return false;
            }
            var normalizedAccountId = (cabinet.id || '').replace(/^act_/, '');
            var fbtoolAccountId = cabinet.fbtool_account_id;

            var _fetch = window._originalFetch || window.fetch;
            var resp = await _fetch.call(window, '/api/adsets/status', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    adset_id: adsetId,
                    adaccount_id: normalizedAccountId,
                    fbtool_account_id: fbtoolAccountId,
                    status: 'ACTIVE'
                })
            });
            var data = await resp.json();
            if (data.success) {
                console.log('[TIMER] ✅ ' + adsetId + ' ENABLED at ' + formatKyiv(getKyivNow()) + ' Kyiv');
                if (window._retryQueue[adsetId]) delete window._retryQueue[adsetId];
                return true;
            } else {
                console.error('[TIMER] ❌ Enable failed ' + adsetId + ': ' + (data.error || resp.status));
                return false;
            }
        } catch(e) {
            console.error('[TIMER] ❌ Enable error ' + adsetId + ': ' + e.message);
            return false;
        }
    }

    // Schedule a retry with escalating delays
    function scheduleRetry(adsetId, retryIndex) {
        if (retryIndex >= RETRY_DELAYS.length) {
            console.error('[TIMER] All ' + RETRY_DELAYS.length + ' retries exhausted for ' + findAdsetName(adsetId));
            delete window._retryQueue[adsetId];
            return;
        }
        var delayMs = RETRY_DELAYS[retryIndex];
        var delayMin = Math.round(delayMs / 60000);
        var name = findAdsetName(adsetId);
        console.log('[TIMER] Retry ' + (retryIndex+1) + '/' + RETRY_DELAYS.length + ' for ' + name + ' in ' + delayMin + ' min');

        var retryTimerId = setTimeout(async function() {
            console.log('[TIMER] Retry ' + (retryIndex+1) + ' firing for ' + name + ' at ' + formatKyiv(getKyivNow()));
            var ok = await enableAdset(adsetId);
            if (ok) {
                console.log('[TIMER] ✅ Retry ' + (retryIndex+1) + ' succeeded for ' + name);
                delete window._retryQueue[adsetId];
            } else {
                scheduleRetry(adsetId, retryIndex + 1);
            }
        }, delayMs);

        window._retryQueue[adsetId] = {
            retryIndex: retryIndex,
            retryTimerId: retryTimerId,
            adsetName: name,
            nextRetryAt: Date.now() + delayMs
        };
    }

    // Serial batch execution — enables one by one with ENABLE_GAP_MS between each
    async function executeEnablesBatch(adsetIds) {
        var total = adsetIds.length;
        var succeeded = 0;
        var failedCount = 0;
        var retrying = 0;

        console.log('[TIMER] Starting serial batch: ' + total + ' adsets (' + (ENABLE_GAP_MS/1000) + 's gap)');

        for (var i = 0; i < adsetIds.length; i++) {
            var adsetId = adsetIds[i];
            var name = findAdsetName(adsetId);
            console.log('[TIMER] [' + (i+1) + '/' + total + '] Enabling ' + name + '...');

            var ok = await enableAdset(adsetId);
            if (ok) {
                succeeded++;
            } else {
                failedCount++;
                retrying++;
                scheduleRetry(adsetId, 0);
            }
            delete window._scheduledEnables[adsetId];

            if (i < adsetIds.length - 1) {
                await new Promise(function(resolve) { setTimeout(resolve, ENABLE_GAP_MS); });
            }
        }

        console.log('[TIMER] Batch done: ' + succeeded + ' ok, ' + failedCount + ' failed' + (retrying > 0 ? ' (' + retrying + ' retrying)' : ''));
        saveTimersToStorage();
    }

    // === PUBLIC API ===

    window.scheduleEnable = function(adsetId, timeStr) {
        if (!adsetId || !timeStr) {
            console.log('[TIMER] Usage: scheduleEnable("adset_id", "05:00")');
            return;
        }
        if (window._scheduledEnables[adsetId]) {
            clearTimeout(window._scheduledEnables[adsetId].timerId);
        }

        var parsed = parseKyivTime(timeStr);
        if (parsed.delayMs <= 0) {
            console.error('[TIMER] Time ' + timeStr + ' is in the past.');
            return;
        }

        var adsetName = findAdsetName(adsetId);
        var timerId = setTimeout(function() {
            console.log('[TIMER] Timer fired for ' + adsetName + ' at ' + formatKyiv(getKyivNow()) + ' Kyiv');
            executeEnablesBatch([adsetId]);
        }, parsed.delayMs);

        window._scheduledEnables[adsetId] = {
            time: parsed.kyivTime,
            timerId: timerId,
            label: formatKyiv(parsed.kyivTime) + ' Kyiv',
            adsetName: adsetName
        };

        var delayMin = Math.round(parsed.delayMs / 60000);
        console.log('[TIMER] Scheduled: ' + adsetName + ' at ' + formatKyiv(parsed.kyivTime) + ' Kyiv (in ' + delayMin + ' min)');
        saveTimersToStorage();
        return {adsetId: adsetId, name: adsetName, enableAt: formatKyiv(parsed.kyivTime), inMinutes: delayMin};
    };

    window.scheduleEnableBatch = function(adsetIds, timeStr) {
        if (!Array.isArray(adsetIds) || !timeStr) {
            console.log('[TIMER] Usage: scheduleEnableBatch(["id1","id2"], "05:00")');
            return;
        }

        var parsed = parseKyivTime(timeStr);
        if (parsed.delayMs <= 0) {
            console.error('[TIMER] Time ' + timeStr + ' is in the past.');
            return;
        }

        // Batch ID — each adset entry references it. Cancelling one entry just
        // removes its membership; the batch fires whatever entries remain.
        var batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

        var timerId = setTimeout(function() {
            var memberIds = [];
            for (var id in window._scheduledEnables) {
                if (window._scheduledEnables[id] && window._scheduledEnables[id].batchId === batchId) {
                    memberIds.push(id);
                }
            }
            console.log('[TIMER] Batch timer fired for ' + memberIds.length + '/' + adsetIds.length + ' remaining adsets at ' + formatKyiv(getKyivNow()) + ' Kyiv');
            if (memberIds.length) executeEnablesBatch(memberIds);
        }, parsed.delayMs);

        // Register each adset with shared batchId + the same timerId reference
        for (var i = 0; i < adsetIds.length; i++) {
            var name = findAdsetName(adsetIds[i]);
            window._scheduledEnables[adsetIds[i]] = {
                time: parsed.kyivTime,
                timerId: timerId,
                batchId: batchId,
                label: formatKyiv(parsed.kyivTime) + ' Kyiv',
                adsetName: name
            };
        }

        var delayMin = Math.round(parsed.delayMs / 60000);
        console.log('[TIMER] Batch scheduled: ' + adsetIds.length + ' adsets at ' + formatKyiv(parsed.kyivTime) + ' Kyiv (in ' + delayMin + ' min, serial ' + (ENABLE_GAP_MS/1000) + 's gap, batch=' + batchId + ')');
        saveTimersToStorage();
    };

    window.listScheduled = function() {
        var keys = Object.keys(window._scheduledEnables);
        var retryKeys = Object.keys(window._retryQueue);
        if (keys.length === 0 && retryKeys.length === 0) {
            console.log('[TIMER] No scheduled enables or pending retries.');
            return [];
        }
        var now = getKyivNow();
        if (keys.length > 0) {
            console.log('[TIMER] === Scheduled (' + keys.length + ') ===');
            for (var i = 0; i < keys.length; i++) {
                var s = window._scheduledEnables[keys[i]];
                var remainMin = Math.round((s.time.getTime() - now.getTime()) / 60000);
                console.log('  ' + s.adsetName + ' → ' + s.label + ' (in ' + remainMin + ' min)');
            }
        }
        if (retryKeys.length > 0) {
            console.log('[TIMER] === Retries (' + retryKeys.length + ') ===');
            for (var j = 0; j < retryKeys.length; j++) {
                var r = window._retryQueue[retryKeys[j]];
                var retryIn = Math.round((r.nextRetryAt - Date.now()) / 60000);
                console.log('  ' + (r.adsetName || retryKeys[j]) + ' → retry ' + (r.retryIndex+1) + '/' + RETRY_DELAYS.length + ' in ' + retryIn + ' min');
            }
        }
        return keys.concat(retryKeys);
    };

    window.cancelScheduled = function(adsetId) {
        var found = false;
        if (window._scheduledEnables[adsetId]) {
            var entry = window._scheduledEnables[adsetId];
            // If this is a batch entry, only clear the timer when no peers remain.
            if (entry.batchId) {
                delete window._scheduledEnables[adsetId];
                var peers = 0;
                for (var pid in window._scheduledEnables) {
                    if (window._scheduledEnables[pid] && window._scheduledEnables[pid].batchId === entry.batchId) {
                        peers++;
                    }
                }
                if (peers === 0) {
                    clearTimeout(entry.timerId);
                    console.log('[TIMER] Cancelled batch (last member): ' + entry.adsetName);
                } else {
                    console.log('[TIMER] Cancelled batch member: ' + entry.adsetName + ' (' + peers + ' peers remain)');
                }
            } else {
                clearTimeout(entry.timerId);
                console.log('[TIMER] Cancelled schedule: ' + entry.adsetName);
                delete window._scheduledEnables[adsetId];
            }
            found = true;
        }
        if (window._retryQueue[adsetId]) {
            clearTimeout(window._retryQueue[adsetId].retryTimerId);
            console.log('[TIMER] Cancelled retry: ' + (window._retryQueue[adsetId].adsetName || adsetId));
            delete window._retryQueue[adsetId];
            found = true;
        }
        if (!found) console.log('[TIMER] No schedule/retry found for ' + adsetId);
        if (found) saveTimersToStorage();
        return found;
    };

    window.cancelAllScheduled = function() {
        var sKeys = Object.keys(window._scheduledEnables);
        var rKeys = Object.keys(window._retryQueue);
        var clearedTimers = {};
        sKeys.forEach(function(id) {
            var tid = window._scheduledEnables[id].timerId;
            if (tid && !clearedTimers[tid]) {
                clearTimeout(tid);
                clearedTimers[tid] = true;
            }
        });
        rKeys.forEach(function(id) { clearTimeout(window._retryQueue[id].retryTimerId); });
        window._scheduledEnables = {};
        window._retryQueue = {};
        console.log('[TIMER] All cancelled (' + sKeys.length + ' schedules, ' + rKeys.length + ' retries).');
        saveTimersToStorage();
        return sKeys.length + rKeys.length;
    };

    console.log('[TIMER v2.0] Serial exec + retry (5m/15m/30m/1h) + ' + (ENABLE_GAP_MS/1000) + 's gap. Kyiv: ' + formatKyiv(getKyivNow()));
})();
