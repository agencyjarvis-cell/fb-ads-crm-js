/**
 * api.js - API виклики до бекенду
 * FB Ads + CRM Automation
 */

// ============================================================================
// ACCOUNTS API
// ============================================================================

/**
 * Завантаження списку аккаунтів FBtool
 */
async function loadAccounts() {
    try {
        const response = await fetch('/api/accounts');
        const data = await response.json();

        if (data.success) {
            window.AppState.accounts = data.accounts || [];
            renderAccounts();
        } else {
            console.error('Помилка завантаження аккаунтів:', data.error);
            document.getElementById('accountsList').innerHTML =
                '<div class="alert alert-error">Помилка завантаження аккаунтів: ' + (data.error || 'Невідома помилка') + '</div>';
        }
    } catch (error) {
        console.error('Помилка при завантаженні аккаунтів:', error);
        document.getElementById('accountsList').innerHTML =
            '<div class="alert alert-error">Помилка підключення до сервера</div>';
    }
}

/**
 * Завантаження рекламних кабінетів для вибраних аккаунтів
 */
async function loadAdaccounts(accountIds) {
    try {
        const response = await fetch('/api/adaccounts', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({account_ids: accountIds})
        });
        const data = await response.json();

        if (data.success) {
            return data.adaccounts || [];
        } else {
            console.error('Помилка завантаження кабінетів:', data.error);
            return [];
        }
    } catch (error) {
        console.error('Помилка при завантаженні кабінетів:', error);
        return [];
    }
}

// ============================================================================
// CRM API
// ============================================================================

/**
 * Тихе оновлення CRM кешу
 */
async function refreshCrmCacheSilently() {
    try {
        // FIX: Use separate CRM refresh server (new tab mode) on port 5099
        const response = await fetch('http://localhost:5099/api/refresh-crm', {method: 'POST'});
        const data = await response.json();
        if (!data.success) {
            console.warn('CRM refresh warning:', data.error);
        } else {
            console.log('CRM cache оновлено:', data.timestamp);
            // Застосовуємо нові ліди до існуючих даних в UI
            await applyCrmLeadsToUI();
        }
    } catch (error) {
        console.warn('Помилка тихого оновлення CRM:', error);
    }
}

/**
 * Застосування CRM лідів до поточних даних в UI
 * Використовує backend endpoint /api/rematch-crm з правильною логікою матчингу
 */
async function applyCrmLeadsToUI() {
    try {
        if (!window.lastResults || !Array.isArray(window.lastResults) || window.lastResults.length === 0) {
            console.log('Немає даних в window.lastResults для оновлення');
            return;
        }

        console.log(`Відправляю ${window.lastResults.length} кампаній на rematch...`);

        // DEBUG: Перевіряємо структуру даних перед відправкою
        if (window.lastResults.length > 0) {
            const first = window.lastResults[0];
            const hasAdsets = first.adsets && Array.isArray(first.adsets) && first.adsets.length > 0;
            console.log('DEBUG applyCrmLeadsToUI:');
            console.log(`  - Перша кампанія: ${first.campaign_name || first.name || 'N/A'}`);
            console.log(`  - Має adsets: ${hasAdsets}`);
            if (hasAdsets) {
                const firstAdset = first.adsets[0];
                const hasAds = firstAdset.ads && Array.isArray(firstAdset.ads) && firstAdset.ads.length > 0;
                console.log(`  - Перший adset: ${firstAdset.name || 'N/A'}`);
                console.log(`  - Має ads: ${hasAds}`);
                if (hasAds) {
                    console.log(`  - Перший ad name: ${firstAdset.ads[0].name || 'N/A'}`);
                }
            }
            const totalLeadsBefore = window.lastResults.reduce((sum, c) => sum + (Number(c.leads) || 0), 0);
            console.log(`  - Загальна кількість лідів до rematch: ${totalLeadsBefore}`);
        }

        const response = await fetch('/api/rematch-crm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({campaigns: window.lastResults})
        });

        const result = await response.json();

        if (!result.success) {
            console.warn('Rematch CRM warning:', result.error || result.message);
            return;
        }

        if (result.data && Array.isArray(result.data)) {
            window.lastResults = result.data;
            window.currentMatchedRows = [...result.data];

            // DEBUG: Перевіряємо результат після rematch
            const totalLeadsAfter = result.data.reduce((sum, c) => sum + (Number(c.leads) || 0), 0);
            console.log(`CRM rematch завершено: оновлено ${result.updated_count || 0} кампаній, matched ${result.matched_crm_count || 0} CRM записів`);
            console.log(`  - Загальна кількість лідів ПІСЛЯ rematch: ${totalLeadsAfter}`);

            // Перерендерюємо UI
            if (typeof renderAllCabinetsSection === 'function') {
                renderAllCabinetsSection();
            }
            if (typeof recomputeStatsFromRows === 'function' && typeof updateStats === 'function') {
                const stats = recomputeStatsFromRows(window.lastResults);
                console.log(`  - Статистика: total_leads=${stats.total_leads}, total_spend=${stats.total_spend}`);
                updateStats(stats);
            }
        }

    } catch (error) {
        console.error('Помилка застосування CRM лідів:', error);
    }
}

/**
 * Перевірка статусу авто-CRM
 */
async function checkAutoCrmStatus() {
    try {
        const response = await fetch('/api/auto-crm/status');
        const data = await response.json();

        if (data.success && data.enabled) {
            window.autoCrmEnabled = true;
            const btn = document.getElementById('autoCrmBtn');
            if (btn) {
                btn.textContent = 'Авто-CRM: ON';
                btn.style.background = '#4CAF50';
            }
        }
    } catch (error) {
        console.warn('Не вдалось перевірити статус авто-CRM:', error);
    }
}

// ============================================================================
// CABINET / COLLECT API
// ============================================================================

/**
 * Оновлення даних одного кабінету
 */
async function refreshCabinetData(adaccountId, date, options = {}) {
    const {quiet = false, skipCrm = false} = options;

    // CRM refresh (якщо потрібно)
    if (!skipCrm) {
        await refreshCrmCacheSilently();
    }

    // Collect - робить всю роботу
    await collectCabinetDelta(adaccountId, date, {quiet});

    return {success: true};
}

/**
 * Збір даних для одного кабінету (delta)
 */
async function collectCabinetDelta(adaccountId, date, options = {}) {
    const quiet = !!options.quiet;
    const maxCplInput = document.getElementById('maxCplInput');
    const onlySpendCheckbox = document.getElementById('onlySpendCheckbox');

    const maxCpl = maxCplInput ? parseFloat(maxCplInput.value) || null : null;
    const onlySpend = onlySpendCheckbox ? onlySpendCheckbox.checked : false;

    const body = {
        adaccount_ids: [adaccountId],
        date,
        max_cpl: maxCpl,
        only_spend: onlySpend,
        refresh_crm: false
    };

    const response = await fetch('/api/collect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || 'Не вдалося оновити дані для кабінету');
    }

    const newRows = Array.isArray(data.data) ? data.data : [];
    const normalizedTarget = normalizeCabinetId(adaccountId || '');

    if (typeof trackRequestedCabinet === 'function') {
        trackRequestedCabinet(normalizedTarget);
    }

    const cabinetRows = newRows
        .map(row => ensureRowHasNormalizedId({...row}))
        .filter(row => getRowCabinetId(row) === normalizedTarget);

    if (cabinetRows.length) {
        if (typeof mergeCabinetRows === 'function') {
            mergeCabinetRows(adaccountId, cabinetRows);
        }

        if (typeof recomputeStatsFromRows === 'function' && typeof updateStats === 'function') {
            const aggregatedStats = recomputeStatsFromRows(window.lastResults);
            updateStats(aggregatedStats);
        }
        if (typeof renderAllCabinetsSection === 'function') {
            renderAllCabinetsSection();
        }
        if (typeof detectInactiveCabinets === 'function') {
            detectInactiveCabinets();
        }
    } else if (!quiet) {
        showNotification(`Дані для ${adaccountId} оновлено, але кампаній з витратами не знайдено за ${date}`);
    } else {
        // ⚠️ АФК режим: API повернув 0 кампаній - НЕ затираємо старі дані!
        console.warn(`⚠️ Auto-refresh: ${adaccountId} - API повернув 0 кампаній, існуючі дані збережено`);
    }
}

// ============================================================================
// ADSET STATUS API
// ============================================================================

/**
 * Зміна статусу AdSet
 */
async function changeAdsetStatus(adsetId, accountId, fbtoolAccountId, status, sourceButton) {
    if (!adsetId || !accountId || !status) {
        showError('Неможливо змінити статус адсету: відсутні дані');
        return;
    }

    const container = sourceButton ? sourceButton.closest('.adset-actions') : null;
    if (container && typeof setAdsetButtonsState === 'function') {
        setAdsetButtonsState(container, true);
    }

    try {
        const normalizedAccountId = normalizeCabinetId(accountId);

        console.log(`Зміна статусу AdSet: ${adsetId} → ${status}`);
        console.log(`   Account: ${normalizedAccountId}`);
        console.log(`   FBtool ID: ${fbtoolAccountId}`);

        const response = await fetch('/api/adsets/status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                adset_id: adsetId,
                adaccount_id: normalizedAccountId,
                fbtool_account_id: fbtoolAccountId,
                status: status
            })
        });

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || 'Не вдалося змінити статус адсету');
        }

        if (typeof updateAdsetStatusLocally === 'function') {
            updateAdsetStatusLocally(String(adsetId), String(accountId), status);
        }
        showNotification(data.message || `Адсет ${adsetId} → ${status}`);
    } catch (error) {
        console.error(error);
        showError(error.message || 'Помилка зміни статусу адсету');
    } finally {
        if (container && typeof setAdsetButtonsState === 'function') {
            setAdsetButtonsState(container, false);
        }
    }
}

// ============================================================================
// TELEGRAM API
// ============================================================================

/**
 * Надіслати Telegram notification через backend
 */
async function sendTelegramNotification(type, adset, cabinet, reason, threshold = 0) {
    try {
        const cpl = adset.leads > 0 ? adset.spend / adset.leads : 0;

        const notificationData = {
            type: type,
            adset_data: {
                id: adset.id,
                name: adset.name || adset.id,
                cabinet_id: cabinet.id,
                cabinet_name: cabinet.name || cabinet.id,
                campaign_name: adset.campaign_name || 'N/A',
                spend: adset.spend,
                leads: adset.leads,
                cpl: cpl,
                threshold: threshold,
                target_cpl: window.AutoRulesV2?.settings?.target_cpl_after_3 || 5.0,
                reason: reason
            }
        };

        const response = await fetch('/api/auto-rules/notify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(notificationData)
        });

        const data = await response.json();

        if (data.success) {
            console.log(`Telegram notification надіслано (${type})`);
        } else {
            console.warn(`Telegram notification не надіслано: ${data.error || 'Unknown'}`);
        }
    } catch (error) {
        console.error(`Помилка sendTelegramNotification:`, error);
    }
}

// ============================================================================
// AUTO-RULES API
// ============================================================================

/**
 * Завантаження налаштувань автоправил
 */
async function loadAutoRulesV2Settings() {
    try {
        const response = await fetch('/api/auto-rules/settings');
        const data = await response.json();

        if (data.success && data.settings) {
            Object.assign(window.AutoRulesV2.settings, data.settings);
            console.log('Налаштування автоправил завантажено');
        }
    } catch (error) {
        console.error('Помилка завантаження налаштувань автоправил:', error);
    }
}

/**
 * Збереження налаштувань автоправил
 */
async function saveAutoRulesV2Settings() {
    try {
        const response = await fetch('/api/auto-rules/settings', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(window.AutoRulesV2.settings)
        });

        const data = await response.json();

        if (data.success) {
            showNotification('Налаштування автоправил збережено');
        } else {
            showError('Помилка збереження: ' + (data.error || 'Unknown'));
        }
    } catch (error) {
        console.error('Помилка збереження налаштувань:', error);
        showError('Помилка збереження налаштувань');
    }
}

console.log('api.js loaded');
