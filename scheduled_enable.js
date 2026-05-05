// === SCHEDULED ADSET ENABLE (crm_fix addon) ===
// Allows scheduling adset activation at a specific Kyiv time (GMT+3).
// Usage from console:
//   scheduleEnable('adset_id_here', '05:00')        — enable today at 05:00 Kyiv
//   scheduleEnable('adset_id_here', '2026-05-05 05:00') — specific date+time
//   listScheduled()                                  — show all pending schedules
//   cancelScheduled('adset_id_here')                 — cancel scheduled enable
//   cancelAllScheduled()                             — cancel all

(function(){
    var KYIV_OFFSET = 3; // GMT+3 (EEST, summer time)

    // Persistent storage in window
    if (!window._scheduledEnables) window._scheduledEnables = {};
    // {adsetId: {time: Date, timerId: number, label: string, adsetName: string}}

    function getKyivNow() {
        var now = new Date();
        // Convert to Kyiv: UTC + offset
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
        // Accepts "HH:MM" (today) or "YYYY-MM-DD HH:MM"
        var now = getKyivNow();
        var parts, year, month, day, hours, minutes;

        if (timeStr.indexOf('-') !== -1) {
            // Full date: "2026-05-05 05:00"
            var dateParts = timeStr.split(' ');
            var dParts = dateParts[0].split('-');
            var tParts = dateParts[1].split(':');
            year = parseInt(dParts[0]);
            month = parseInt(dParts[1]) - 1;
            day = parseInt(dParts[2]);
            hours = parseInt(tParts[0]);
            minutes = parseInt(tParts[1]) || 0;
        } else {
            // Time only: "05:00" — use today (or tomorrow if time already passed)
            var tParts = timeStr.split(':');
            hours = parseInt(tParts[0]);
            minutes = parseInt(tParts[1]) || 0;
            year = now.getFullYear();
            month = now.getMonth();
            day = now.getDate();
        }

        // Build target date in Kyiv timezone
        var targetKyiv = new Date(year, month, day, hours, minutes, 0);

        // If time-only and already passed today — schedule for tomorrow
        if (timeStr.indexOf('-') === -1 && targetKyiv <= now) {
            targetKyiv.setDate(targetKyiv.getDate() + 1);
        }

        // Convert Kyiv target to real system time
        var systemNow = new Date();
        var kyivNow = getKyivNow();
        var diffMs = targetKyiv.getTime() - kyivNow.getTime();

        return {
            systemTime: new Date(systemNow.getTime() + diffMs),
            kyivTime: targetKyiv,
            delayMs: diffMs
        };
    }

    function findAdsetName(adsetId) {
        if (!window.lastResults) return adsetId;
        for (var i = 0; i < window.lastResults.length; i++) {
            var c = window.lastResults[i];
            if (!c.adsets) continue;
            for (var j = 0; j < c.adsets.length; j++) {
                var a = c.adsets[j];
                if ((a.id || a.adset_id) === adsetId) {
                    return a.name || a.adset_name || adsetId;
                }
            }
        }
        return adsetId;
    }

    async function enableAdset(adsetId) {
        try {
            var _fetch = window._originalFetch || window.fetch;
            var resp = await _fetch.call(window, '/api/adsets/status', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({adset_id: adsetId, status: 'ACTIVE'})
            });
            var data = await resp.json();
            if (data.success) {
                console.log('[TIMER] ✅ Adset ' + adsetId + ' ENABLED successfully at ' + formatKyiv(getKyivNow()) + ' Kyiv');
                return true;
            } else {
                console.error('[TIMER] ❌ Enable failed for ' + adsetId + ':', data.error || 'unknown error');
                return false;
            }
        } catch(e) {
            console.error('[TIMER] ❌ Enable error for ' + adsetId + ':', e.message);
            return false;
        }
    }

    // === PUBLIC API ===

    window.scheduleEnable = function(adsetId, timeStr) {
        if (!adsetId || !timeStr) {
            console.log('[TIMER] Usage: scheduleEnable("adset_id", "05:00") or scheduleEnable("adset_id", "2026-05-05 05:00")');
            return;
        }

        // Cancel existing schedule for this adset
        if (window._scheduledEnables[adsetId]) {
            clearTimeout(window._scheduledEnables[adsetId].timerId);
            console.log('[TIMER] Cancelled previous schedule for ' + adsetId);
        }

        var parsed = parseKyivTime(timeStr);
        if (parsed.delayMs <= 0) {
            console.error('[TIMER] ❌ Time ' + timeStr + ' is in the past. Use future time.');
            return;
        }

        var adsetName = findAdsetName(adsetId);
        var timerId = setTimeout(async function() {
            console.log('[TIMER] ⏰ Timer fired for ' + adsetId + ' (' + adsetName + ') at ' + formatKyiv(getKyivNow()) + ' Kyiv');
            var success = await enableAdset(adsetId);
            if (success) {
                // Refresh UI
                if (typeof window.refreshCrmCacheSilently === 'function') {
                    await window.refreshCrmCacheSilently();
                }
            }
            delete window._scheduledEnables[adsetId];
        }, parsed.delayMs);

        window._scheduledEnables[adsetId] = {
            time: parsed.kyivTime,
            timerId: timerId,
            label: formatKyiv(parsed.kyivTime) + ' Kyiv',
            adsetName: adsetName
        };

        var delayMin = Math.round(parsed.delayMs / 60000);
        console.log('[TIMER] ✅ Scheduled: ' + adsetName + ' → ENABLE at ' + formatKyiv(parsed.kyivTime) + ' Kyiv (in ' + delayMin + ' min)');
        return {adsetId: adsetId, name: adsetName, enableAt: formatKyiv(parsed.kyivTime), inMinutes: delayMin};
    };

    // Schedule multiple adsets at once
    window.scheduleEnableBatch = function(adsetIds, timeStr) {
        if (!Array.isArray(adsetIds) || !timeStr) {
            console.log('[TIMER] Usage: scheduleEnableBatch(["id1","id2"], "05:00")');
            return;
        }
        var results = [];
        for (var i = 0; i < adsetIds.length; i++) {
            results.push(window.scheduleEnable(adsetIds[i], timeStr));
        }
        console.log('[TIMER] Batch scheduled: ' + adsetIds.length + ' adsets at ' + timeStr);
        return results;
    };

    window.listScheduled = function() {
        var keys = Object.keys(window._scheduledEnables);
        if (keys.length === 0) {
            console.log('[TIMER] No scheduled enables.');
            return [];
        }
        console.log('[TIMER] === Scheduled Enables (' + keys.length + ') ===');
        var now = getKyivNow();
        var list = [];
        for (var i = 0; i < keys.length; i++) {
            var s = window._scheduledEnables[keys[i]];
            var remainMin = Math.round((s.time.getTime() - now.getTime()) / 60000);
            console.log('  ' + s.adsetName + ' → ' + s.label + ' (in ' + remainMin + ' min)');
            list.push({adsetId: keys[i], name: s.adsetName, at: s.label, inMinutes: remainMin});
        }
        return list;
    };

    window.cancelScheduled = function(adsetId) {
        if (window._scheduledEnables[adsetId]) {
            clearTimeout(window._scheduledEnables[adsetId].timerId);
            var name = window._scheduledEnables[adsetId].adsetName;
            delete window._scheduledEnables[adsetId];
            console.log('[TIMER] ❌ Cancelled: ' + name);
            return true;
        }
        console.log('[TIMER] No schedule found for ' + adsetId);
        return false;
    };

    window.cancelAllScheduled = function() {
        var keys = Object.keys(window._scheduledEnables);
        for (var i = 0; i < keys.length; i++) {
            clearTimeout(window._scheduledEnables[keys[i]].timerId);
        }
        window._scheduledEnables = {};
        console.log('[TIMER] ❌ All ' + keys.length + ' schedules cancelled.');
        return keys.length;
    };

    console.log('[TIMER] Scheduled Enable module loaded. Commands: scheduleEnable(id, "05:00"), listScheduled(), cancelScheduled(id), cancelAllScheduled()');
    console.log('[TIMER] Current Kyiv time: ' + formatKyiv(getKyivNow()) + ' (GMT+' + KYIV_OFFSET + ')');
})();
