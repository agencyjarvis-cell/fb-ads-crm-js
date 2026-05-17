/**
 * autorules.js - Автоматичні правила для управління AdSets
 * FB Ads + CRM Automation
 */

// ============================================================================
// НАЛАШТУВАННЯ АВТОПРАВИЛ (глобально в window.AutoRulesV2)
// ============================================================================

// Ініціалізація глобальних змінних для автоправил
window.autoRulesV2Settings = window.AutoRulesV2?.settings || {
    global_enabled: false,
    default_rules: {
        threshold_0_leads: 5.00,
        threshold_1_lead: 7.00,
        threshold_2_leads: 13.60,
        threshold_3_leads: 18.00,
        target_cpl_after_3: 5.00
    },
    groups: [],
    cooldown_minutes: 15,
    min_interval_minutes: 1,
    cabinet_enabled: {},
    adset_disabled_at: {}
};

window.autoRulesV2DisabledAdsets = new Set();
window.autoRulesV2Running = false;

// ============================================================================
// COOLDOWN MANAGEMENT
// ============================================================================

/**
 * Перевірка cooldown для adset
 */
function checkAdsetCooldown(adsetId) {
    const settings = window.autoRulesV2Settings;
    const disabledAt = settings.adset_disabled_at?.[adsetId];

    if (disabledAt) {
        const now = Date.now();
        const elapsed = (now - disabledAt) / 1000 / 60;
        const cooldownMinutes = settings.cooldown_minutes || 15;

        if (elapsed < cooldownMinutes) {
            return {
                inCooldown: true,
                remainingMinutes: Math.ceil(cooldownMinutes - elapsed)
            };
        }
    }

    return {inCooldown: false, remainingMinutes: 0};
}

/**
 * Встановити cooldown для adset
 */
function setAdsetCooldown(adsetId) {
    window.autoRulesV2Settings.adset_disabled_at[adsetId] = Date.now();
    if (typeof saveAutoRulesV2Settings === 'function') {
        saveAutoRulesV2Settings();
    }
}

// ============================================================================
// RULE CHECKING
// ============================================================================

// ============================================================================
// UNIQUE CABINET PER GROUP ENFORCEMENT
// ============================================================================

/**
 * Получить ID группы, в которой находится кабинет (или null)
 */
function getCabinetGroupId(cabinetId) {
    const settings = window.autoRulesV2Settings;
    for (let i = 0; i < (settings.groups || []).length; i++) {
        const group = settings.groups[i];
        if (group.cabinets && group.cabinets.includes(cabinetId)) {
            return i;
        }
    }
    return null;
}

/**
 * Получить все кабинеты, уже привязанные к какой-либо группе
 */
function getAssignedCabinets() {
    const settings = window.autoRulesV2Settings;
    const assigned = {};
    (settings.groups || []).forEach(function(group, idx) {
        (group.cabinets || []).forEach(function(cabId) {
            assigned[cabId] = { groupIndex: idx, groupName: group.name || ('Group ' + (idx + 1)) };
        });
    });
    return assigned;
}

/**
 * Получить свободные кабинеты (не привязанные ни к одной группе)
 * @param {number} excludeGroupIndex - индекс группы, которую исключить (для редактирования)
 */
function getAvailableCabinets(excludeGroupIndex) {
    const settings = window.autoRulesV2Settings;
    const assignedToOther = {};

    (settings.groups || []).forEach(function(group, idx) {
        if (idx === excludeGroupIndex) return; // skip current group being edited
        (group.cabinets || []).forEach(function(cabId) {
            assignedToOther[cabId] = true;
        });
    });

    // Get all known cabinet IDs from lastResults
    const allCabs = {};
    (window.lastResults || []).forEach(function(row) {
        var cabId = row.adaccount_id || row.account_id;
        if (cabId && !allCabs[cabId]) {
            allCabs[cabId] = { id: cabId, name: row.adaccount_name || row.account_name || cabId };
        }
    });

    var available = [];
    for (var cabId in allCabs) {
        if (!assignedToOther[cabId]) {
            available.push(allCabs[cabId]);
        }
    }
    return available;
}

/**
 * Добавить кабинет в группу, удалив из других групп
 */
function addCabinetToGroup(cabinetId, targetGroupIndex) {
    const settings = window.autoRulesV2Settings;
    // Remove from all other groups
    (settings.groups || []).forEach(function(group, idx) {
        if (idx === targetGroupIndex) return;
        if (group.cabinets) {
            var pos = group.cabinets.indexOf(cabinetId);
            if (pos !== -1) {
                group.cabinets.splice(pos, 1);
                console.log('[AUTORULES] Removed ' + cabinetId + ' from group ' + (group.name || idx));
            }
        }
    });
    // Add to target group
    if (settings.groups[targetGroupIndex]) {
        if (!settings.groups[targetGroupIndex].cabinets) {
            settings.groups[targetGroupIndex].cabinets = [];
        }
        if (settings.groups[targetGroupIndex].cabinets.indexOf(cabinetId) === -1) {
            settings.groups[targetGroupIndex].cabinets.push(cabinetId);
        }
    }
}

/**
 * Валидация: проверить нет ли дубликатов кабинетов между группами
 */
function validateCabinetUniqueness() {
    const settings = window.autoRulesV2Settings;
    const seen = {};
    const duplicates = [];

    (settings.groups || []).forEach(function(group, idx) {
        (group.cabinets || []).forEach(function(cabId) {
            if (seen[cabId] !== undefined) {
                duplicates.push({
                    cabinetId: cabId,
                    groups: [seen[cabId], idx]
                });
            } else {
                seen[cabId] = idx;
            }
        });
    });

    return { valid: duplicates.length === 0, duplicates: duplicates };
}

// Export to window for use in UI
window.getAvailableCabinets = getAvailableCabinets;
window.getAssignedCabinets = getAssignedCabinets;
window.addCabinetToGroup = addCabinetToGroup;
window.validateCabinetUniqueness = validateCabinetUniqueness;
window.getCabinetGroupId = getCabinetGroupId;

/**
 * Отримати правила для кабінету (групові або дефолтні)
 */
function getRulesForCabinet(cabinetId) {
    const settings = window.autoRulesV2Settings;

    // Шукаємо в групах
    for (const group of (settings.groups || [])) {
        if (group.cabinets && group.cabinets.includes(cabinetId)) {
            return group.rules || settings.default_rules;
        }
    }

    return settings.default_rules;
}

/**
 * Перевірка правила на вимкнення adset
 */
function checkAdsetDisableRule(adset, cabinetId) {
    const rules = getRulesForCabinet(cabinetId);
    const spend = parseFloat(adset.spend) || 0;
    const leads = parseInt(adset.leads) || 0;
    const cpl = leads > 0 ? spend / leads : 0;

    // Правило 1: 0 лідів і spend > threshold
    if (leads === 0 && spend >= rules.threshold_0_leads) {
        return {
            shouldDisable: true,
            reason: `0 лідів, spend $${spend.toFixed(2)} >= $${rules.threshold_0_leads}`,
            threshold: rules.threshold_0_leads
        };
    }

    // Правило 2: 1 лід і spend > threshold
    if (leads === 1 && spend >= rules.threshold_1_lead) {
        return {
            shouldDisable: true,
            reason: `1 лід, spend $${spend.toFixed(2)} >= $${rules.threshold_1_lead}`,
            threshold: rules.threshold_1_lead
        };
    }

    // Правило 3: 2 ліди і spend > threshold
    if (leads === 2 && spend >= rules.threshold_2_leads) {
        return {
            shouldDisable: true,
            reason: `2 ліди, spend $${spend.toFixed(2)} >= $${rules.threshold_2_leads}`,
            threshold: rules.threshold_2_leads
        };
    }

    // Правило 4: 3 ліди і CPL > target
    if (leads === 3 && cpl > rules.target_cpl_after_3) {
        return {
            shouldDisable: true,
            reason: `3 ліди, CPL $${cpl.toFixed(2)} > $${rules.target_cpl_after_3}`,
            threshold: rules.target_cpl_after_3
        };
    }

    // Правило 5: >3 лідів і CPL > target
    if (leads > 3 && cpl > rules.target_cpl_after_3) {
        return {
            shouldDisable: true,
            reason: `${leads} лідів, CPL $${cpl.toFixed(2)} > $${rules.target_cpl_after_3}`,
            threshold: rules.target_cpl_after_3
        };
    }

    return {shouldDisable: false, reason: null, threshold: 0};
}

/**
 * Перевірка правила на ввімкнення adset
 */
function checkAdsetEnableRule(adset, cabinetId) {
    const rules = getRulesForCabinet(cabinetId);
    const spend = parseFloat(adset.spend) || 0;
    const leads = parseInt(adset.leads) || 0;
    const cpl = leads > 0 ? spend / leads : 0;

    // Перевіряємо чи adset був вимкнений автоправилами
    if (!window.autoRulesV2DisabledAdsets.has(adset.id)) {
        return {shouldEnable: false, reason: null};
    }

    // Якщо CPL в нормі і є ліди - можна вмикати
    if (leads > 0 && cpl <= rules.target_cpl_after_3) {
        return {
            shouldEnable: true,
            reason: `CPL $${cpl.toFixed(2)} <= $${rules.target_cpl_after_3}`
        };
    }

    return {shouldEnable: false, reason: null};
}

// ============================================================================
// ADSET DISABLE/ENABLE
// ============================================================================

/**
 * Вимкнути adset
 */
async function disableAdset(adset, cabinet, reason, threshold) {
    try {
        console.log(`Вимикаю adset ${adset.id}... Причина: ${reason}`);

        const fbtoolAccountId = cabinet.fbtool_account_id;
        const cabinetId = cabinet.id;
        const normalizedAccountId = cabinetId.replace('act_', '');

        if (!fbtoolAccountId) {
            console.error(`Не знайдено fbtool_account_id для кабінету ${cabinetId}`);
            return false;
        }

        const response = await fetch('/api/adsets/status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                adset_id: adset.id,
                adaccount_id: normalizedAccountId,
                fbtool_account_id: fbtoolAccountId,
                status: 'PAUSED'
            })
        });

        const data = await response.json();

        if (data.success) {
            setAdsetCooldown(adset.id);
            window.autoRulesV2DisabledAdsets.add(adset.id);

            if (typeof updateAdsetStatusLocally === 'function') {
                updateAdsetStatusLocally(String(adset.id), String(cabinetId), 'PAUSED');
            }

            console.log(`Adset ${adset.id} вимкнено (${reason})`);
            showNotification(`Adset вимкнено: ${adset.name || adset.id}`);

            // Telegram notification
            if (typeof sendTelegramNotification === 'function') {
                sendTelegramNotification('disable', adset, cabinet, reason, threshold).catch(err => {
                    console.warn('Telegram notification failed:', err);
                });
            }

            return true;
        } else {
            console.error(`Помилка API: ${data.error || 'Unknown'}`);
            return false;
        }
    } catch (error) {
        console.error(`Помилка disableAdset:`, error);
        return false;
    }
}

/**
 * Увімкнути adset
 */
async function enableAdset(adset, cabinet, reason) {
    try {
        console.log(`Вмикаю adset ${adset.id}... Причина: ${reason}`);

        const fbtoolAccountId = cabinet.fbtool_account_id;
        const cabinetId = cabinet.id;
        const normalizedAccountId = cabinetId.replace('act_', '');

        if (!fbtoolAccountId) {
            console.error(`Не знайдено fbtool_account_id для кабінету ${cabinetId}`);
            return false;
        }

        const response = await fetch('/api/adsets/status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                adset_id: adset.id,
                adaccount_id: normalizedAccountId,
                fbtool_account_id: fbtoolAccountId,
                status: 'ACTIVE'
            })
        });

        const data = await response.json();

        if (data.success) {
            setAdsetCooldown(adset.id);
            window.autoRulesV2DisabledAdsets.delete(adset.id);

            if (typeof updateAdsetStatusLocally === 'function') {
                updateAdsetStatusLocally(String(adset.id), String(cabinetId), 'ACTIVE');
            }

            console.log(`Adset ${adset.id} увімкнено (${reason})`);
            showNotification(`Adset увімкнено: ${adset.name || adset.id}`);

            // Telegram notification
            if (typeof sendTelegramNotification === 'function') {
                sendTelegramNotification('enable', adset, cabinet, reason).catch(err => {
                    console.warn('Telegram notification failed:', err);
                });
            }

            return true;
        } else {
            console.error(`Помилка API: ${data.error || 'Unknown'}`);
            return false;
        }
    } catch (error) {
        console.error(`Помилка enableAdset:`, error);
        return false;
    }
}

// ============================================================================
// CRM FRESHNESS CHECK
// ============================================================================

/**
 * Перевірка свіжості CRM кешу
 */
async function checkCrmCacheFreshness() {
    try {
        const response = await fetch('/api/crm-cache');
        const data = await response.json();

        if (!data.timestamp) {
            return {fresh: false, age_minutes: null, ttl_minutes: null, error: 'Немає CRM кешу'};
        }

        const cacheTime = new Date(data.timestamp);
        const now = new Date();
        const age_minutes = (now - cacheTime) / 1000 / 60;
        const ttl_minutes = data.ttl_minutes || 2;

        return {
            fresh: age_minutes <= ttl_minutes,
            age_minutes: age_minutes,
            ttl_minutes: ttl_minutes,
            total_leads: data.total_leads || 0
        };
    } catch (error) {
        console.error('Помилка перевірки CRM кешу:', error);
        return {fresh: false, age_minutes: null, ttl_minutes: null, error: error.message};
    }
}

// ============================================================================
// UI FUNCTIONS
// ============================================================================

/**
 * Додати запис до логів автоправил
 */
function appendAutoRulesLog(message, level = 'info') {
    const logContainer = document.getElementById('autoRulesLog');
    if (!logContainer) return;

    const time = new Date().toLocaleTimeString('uk-UA');
    let color = '#374151';
    if (level === 'warn') color = '#b45309';
    if (level === 'error') color = '#b91c1c';
    if (level === 'success') color = '#15803d';

    const entry = document.createElement('div');
    entry.style.marginBottom = '4px';
    entry.innerHTML = `<span style="color: var(--text-secondary);">${time} — </span><span style="color:${color};">${message}</span>`;

    logContainer.prepend(entry);
}

/**
 * Оновити інформаційну панель автоправил
 */
function updateAutoRulesInfoPanel() {
    const panel = document.getElementById('autoRulesInfoContent');
    if (!panel) return;

    const settings = window.autoRulesV2Settings;

    const totalCabinets = new Set(
        (window.lastResults || [])
            .map(row => normalizeCabinetId(row.adaccount_id || row.account_id))
            .filter(Boolean)
    ).size;

    const enabledCabinets = new Set(
        (window.lastResults || [])
            .map(row => normalizeCabinetId(row.adaccount_id || row.account_id))
            .filter(id => id && settings.cabinet_enabled[id] !== false)
    ).size;

    panel.innerHTML = `
        <div>Глобально: <strong>${settings.global_enabled ? 'Увімкнено' : 'Вимкнено'}</strong></div>
        <div>Кабінетів у даних: ${totalCabinets || 0}</div>
        <div>Кабінетів під автоправилами: ${enabledCabinets || 0}</div>
        <div>Cooldown (хв): ${settings.cooldown_minutes || 0}</div>
    `;
}

console.log('autorules.js loaded');
