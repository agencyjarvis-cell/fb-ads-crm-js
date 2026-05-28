// === CABINET ENABLE CONSENT ===
// Контролює чи дозволено автоправилам ВКЛЮЧАТИ адсети для кожного кабінету.
// Дефолт: всі чекбокси OFF. Скидається на reload (memory-only) і на 00:00 за Києвом.
// Disable (вимкнення по лімітам) ПРАЦЮЄ завжди — гейт стосується ЛИШЕ enable.

(function(){
    'use strict';

    var KYIV_OFFSET_HOURS = 3; // GMT+3

    // Memory-only state — пропадає на reload (Cmd+R) автоматично
    if (!window.cabinetEnableConsent) window.cabinetEnableConsent = {};

    // Public API: викликається з checkbox onchange у renderAutoRulesCabinetsList
    window.handleCabinetEnableConsentToggle = function(cabinetId, enabled) {
        if (!cabinetId) return;
        window.cabinetEnableConsent[cabinetId] = !!enabled;
        var stamp = new Date().toLocaleTimeString('uk-UA');
        console.log('[ENABLE-CONSENT] ' + stamp + ' — cabinet ' + cabinetId + ': ' + (enabled ? 'ON ✅' : 'OFF ⛔'));
    };

    // Скидання всіх галок (викликається опівночі за Києвом)
    function resetAllConsents(reason) {
        var keys = Object.keys(window.cabinetEnableConsent || {});
        var changed = 0;
        keys.forEach(function(k) {
            if (window.cabinetEnableConsent[k] === true) changed++;
            window.cabinetEnableConsent[k] = false;
        });
        console.log('[ENABLE-CONSENT] 🌙 Reset ' + changed + '/' + keys.length + ' cabinet(s) (' + (reason || 'manual') + ')');
        // Перерендерюємо UI якщо він уже намальований
        if (typeof window.renderAutoRulesCabinetsList === 'function') {
            try { window.renderAutoRulesCabinetsList(); } catch(e) {}
        }
    }
    window.resetCabinetEnableConsents = resetAllConsents;

    function getKyivNow() {
        var now = new Date();
        return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (KYIV_OFFSET_HOURS * 3600000));
    }

    function msUntilNextKyivMidnight() {
        var kyivNow = getKyivNow();
        var nextKyivMidnight = new Date(
            kyivNow.getFullYear(),
            kyivNow.getMonth(),
            kyivNow.getDate() + 1,
            0, 0, 1, 0
        );
        return Math.max(1000, nextKyivMidnight.getTime() - kyivNow.getTime());
    }

    function scheduleMidnightReset() {
        // Захист від дублів (наприклад, при повторному завантаженні скрипта)
        if (window._cabinetEnableConsentMidnightTimer) {
            clearTimeout(window._cabinetEnableConsentMidnightTimer);
        }
        var delay = msUntilNextKyivMidnight();
        window._cabinetEnableConsentMidnightTimer = setTimeout(function() {
            resetAllConsents('00:00 Kyiv auto-reset');
            // Знову плануємо на наступну добу
            scheduleMidnightReset();
        }, delay);
        var hrs = Math.floor(delay / 3600000);
        var mins = Math.round((delay % 3600000) / 60000);
        console.log('[ENABLE-CONSENT] Midnight Kyiv reset scheduled in ' + hrs + 'h ' + mins + 'm');
    }

    // Підстраховка: якщо setTimeout заснув (sleep/laptop closed) — раз на хвилину перевіряємо
    // чи Kyiv-дата змінилась. Якщо так — скидаємо одразу.
    var _lastKyivDate = (function() {
        var d = getKyivNow();
        return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    })();
    setInterval(function() {
        var d = getKyivNow();
        var key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        if (key !== _lastKyivDate) {
            _lastKyivDate = key;
            // Дата змінилась — переконуємось що галки скинуті
            var anyOn = Object.keys(window.cabinetEnableConsent).some(function(k) {
                return window.cabinetEnableConsent[k] === true;
            });
            if (anyOn) {
                resetAllConsents('Kyiv date rollover detected');
            }
            // Перепланувати таймер на наступну ніч
            scheduleMidnightReset();
        }
    }, 60000);

    scheduleMidnightReset();
    console.log('[ENABLE-CONSENT] Loaded. Kyiv now: ' + getKyivNow().toISOString().replace('T', ' ').slice(0,16) + ' (GMT+' + KYIV_OFFSET_HOURS + ')');
})();
