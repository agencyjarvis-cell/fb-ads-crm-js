/**
 * afk.js - AFK режим (автоматичне оновлення)
 * FB Ads + CRM Automation
 */

// ============================================================================
// ГЛОБАЛЬНІ ЗМІННІ AFK
// ============================================================================

// Ці змінні використовуються з window.AppState
// autoRefreshInterval, autoRefreshNextUpdate, crmRefreshInterval, isAutoRefreshActive

// ============================================================================
// УПРАВЛІННЯ AFK РЕЖИМОМ
// ============================================================================

/**
 * Запуск AFK режиму з заданим інтервалом
 */
function startAutoRefresh(intervalMinutes) {
    stopAutoRefresh();

    console.log(`[AFK] Запуск АФК режиму з інтервалом ${intervalMinutes} хв`);

    const state = window.AppState;

    // Оновлюємо статус
    updateAutoRefreshStatus(intervalMinutes);

    // Встановлюємо інтервал для оновлень spend
    state.autoRefreshInterval = setInterval(() => {
        if (state.isAutoRefreshActive) {
            console.log(`[AFK] Виконую планове оновлення (spend)`);
            performAutoRefresh();
        } else {
            console.warn('[AFK] isAutoRefreshActive = false, пропускаю оновлення');
        }
    }, intervalMinutes * 60 * 1000);

    // Оновлюємо таймер "наступне оновлення" кожну секунду
    state.autoRefreshNextUpdate = setInterval(() => {
        updateNextRefreshTime(intervalMinutes);
    }, 1000);

    console.log('[AFK] Таймери встановлено: Spend кожні', intervalMinutes, 'хв');

    // Окремий таймер для CRM (кожну хвилину)
    state.crmRefreshInterval = setInterval(() => {
        if (state.isAutoRefreshActive) {
            console.log('[AFK] Автоматичне оновлення CRM (кожну хвилину)');
            if (typeof refreshCrmCacheSilently === 'function') {
                refreshCrmCacheSilently();
            }
        }
    }, 60 * 1000);

    console.log('[AFK] CRM таймер встановлено: оновлення кожну хвилину');

    // Перше оновлення через 5 секунд
    console.log('[AFK] Перше оновлення через 5 секунд...');
    setTimeout(() => {
        if (state.isAutoRefreshActive) {
            console.log('[AFK] Запускаю перше оновлення (spend)');
            performAutoRefresh();
        }
    }, 5000);

    // Перше оновлення CRM через 10 секунд
    setTimeout(() => {
        if (state.isAutoRefreshActive) {
            console.log('[AFK] Перше оновлення CRM');
            if (typeof refreshCrmCacheSilently === 'function') {
                refreshCrmCacheSilently();
            }
        }
    }, 10000);
}

/**
 * Зупинка AFK режиму
 */
function stopAutoRefresh() {
    const state = window.AppState;

    if (state.autoRefreshInterval) {
        clearInterval(state.autoRefreshInterval);
        state.autoRefreshInterval = null;
    }
    if (state.autoRefreshNextUpdate) {
        clearInterval(state.autoRefreshNextUpdate);
        state.autoRefreshNextUpdate = null;
    }
    if (state.crmRefreshInterval) {
        clearInterval(state.crmRefreshInterval);
        state.crmRefreshInterval = null;
    }
    console.log('AFK режим зупинено');
}

/**
 * Виконання автоматичного оновлення
 */
async function performAutoRefresh() {
    const state = window.AppState;

    console.log('[AFK] performAutoRefresh викликано');

    const toggle = document.getElementById('autoRefreshToggle');
    if (!state.isAutoRefreshActive || !toggle || !toggle.checked) {
        console.warn('[AFK] Перевірка не пройдена, вихід');
        return;
    }

    // Перевірка глобального lock
    if (typeof acquireLock === 'function' && !acquireLock('AFK режим: автооновлення', true)) {
        console.warn('[AFK] Auto-refresh пропущено: зайнята інша операція');
        return;
    }

    console.log('[AFK] Lock отримано, починаю оновлення...');

    const uniqueSelected = typeof getUniqueSelectedAdaccounts === 'function' ? getUniqueSelectedAdaccounts() : [];
    const cabinetsToUpdate = state.cabinetsToUpdate || new Set();
    const cabinetsPaused = state.cabinetsPaused || new Set();

    const activeCabinets = cabinetsToUpdate.size === 0
        ? uniqueSelected
        : uniqueSelected.filter(id => cabinetsToUpdate.has(id));

    // Фільтруємо кабінети які на паузі
    const cabinetsToRefresh = activeCabinets.filter(id => !cabinetsPaused.has(id));
    const pausedCount = activeCabinets.length - cabinetsToRefresh.length;

    if (pausedCount > 0) {
        console.log(`[AFK] Пропущено ${pausedCount} кабінетів на паузі`);
    }

    if (cabinetsToRefresh.length === 0) {
        if (typeof releaseLock === 'function') releaseLock();
        console.error('[AFK] Auto-refresh зупинено: немає кабінетів для оновлення');
        showNotification('Всі кабінети на паузі для АФК режиму');
        return;
    }

    if (typeof setLastRequestedCabinets === 'function') {
        setLastRequestedCabinets(activeCabinets);
    }
    if (typeof renderAllCabinetsSection === 'function') {
        renderAllCabinetsSection();
    }

    console.log(`[AFK] Виконую автоматичне оновлення (${cabinetsToRefresh.length} кабінетів)...`);

    const dateInput = document.getElementById('dateInput');
    if (!dateInput) {
        if (typeof releaseLock === 'function') releaseLock();
        console.error('[AFK] dateInput не знайдено!');
        return;
    }
    const date = dateInput.value;

    try {
        // Переходимо на Step 4
        if (typeof showStep === 'function') {
            showStep(4);
        }

        // Батчування запитів
        console.log(`[AFK] Батчування ${cabinetsToRefresh.length} кабінетів...`);

        // Якщо є queueManager - використовуємо його
        if (typeof queueManager !== 'undefined' && queueManager.addRequest) {
            cabinetsToRefresh.forEach(adId => {
                queueManager.addRequest(adId, date, {quiet: true, skipCrm: true});
            });

            const allResults = [];
            while (queueManager.hasRequests()) {
                const batchResults = await queueManager.processBatch();
                allResults.push(...batchResults);
            }

            const successCount = allResults.filter(r => r.status === 'fulfilled').length;
            console.log(`[AFK] Батчування завершено: ${successCount}/${cabinetsToRefresh.length} успішно`);
        } else {
            // Fallback: паралельне оновлення
            const promises = cabinetsToRefresh.map(adId =>
                refreshCabinetData(adId, date, {quiet: true, skipCrm: true})
                    .catch(err => ({error: err}))
            );
            await Promise.all(promises);
        }

        // Оновлюємо статистику
        if (typeof updateLastRefreshTime === 'function') {
            updateLastRefreshTime(new Date().toISOString());
        }

        const finalStats = window.lastResults ? recomputeStatsFromRows(window.lastResults) : {};
        if (typeof updateStats === 'function') {
            updateStats(finalStats);
        }

        const statusMsg = `AFK оновлення завершено!\nОброблено: ${cabinetsToRefresh.length} кабінетів\nКампаній з лідами: ${finalStats.with_leads || 0}`;
        showNotification(statusMsg);

        // Запускаємо автоправила
        if (window.autoRulesV2Settings?.global_enabled && typeof evaluateAutoRulesV2 === 'function') {
            console.log('[AFK] Запуск автоправил після оновлення...');
            try {
                await evaluateAutoRulesV2({notifyStart: true, source: 'auto-refresh'});
            } catch (error) {
                console.error('Помилка виконання автоправил:', error);
            }
        }
    } catch (error) {
        console.error('Помилка auto-refresh:', error);
    } finally {
        if (typeof releaseLock === 'function') {
            releaseLock();
        }
    }
}

/**
 * Зупинка AFK режиму з Кроку 4
 */
function stopAutoRefreshFromStep4() {
    const state = window.AppState;
    state.isAutoRefreshActive = false;
    stopAutoRefresh();

    const toggle = document.getElementById('autoRefreshToggle');
    if (toggle) toggle.checked = false;

    const statusDiv = document.getElementById('autoRefreshStatus');
    if (statusDiv) statusDiv.style.display = 'none';

    const step4Control = document.getElementById('step4AutoRefreshControl');
    if (step4Control) step4Control.style.display = 'none';

    showNotification('Auto-refresh зупинено');
    console.log('Auto-refresh зупинено з Кроку 4');
}

/**
 * Оновлення статусу AFK режиму
 */
function updateAutoRefreshStatus(intervalMinutes) {
    const statusText = document.getElementById('autoRefreshStatusText');
    if (statusText) {
        statusText.textContent = `Auto-refresh активний (кожні ${intervalMinutes} хв)`;
    }
    updateStep4AutoRefreshControl(intervalMinutes);
}

/**
 * Оновлення контролу AFK на Кроці 4
 */
function updateStep4AutoRefreshControl(intervalMinutes) {
    const step4Control = document.getElementById('step4AutoRefreshControl');
    const step4Info = document.getElementById('step4AutoRefreshInfo');
    const currentStep = document.querySelector('.step.active');
    const state = window.AppState;

    if (step4Control && step4Info) {
        if (state.isAutoRefreshActive && currentStep && currentStep.id === 'step4') {
            step4Control.style.display = 'block';
            step4Info.textContent = `Оновлення кожні ${intervalMinutes} хв`;
        } else {
            step4Control.style.display = 'none';
        }
    }
}

/**
 * Оновлення часу до наступного оновлення
 */
function updateNextRefreshTime(intervalMinutes) {
    const nextTimeEl = document.getElementById('nextRefreshTime');
    if (!nextTimeEl) return;

    // Розраховуємо час до наступного оновлення
    const now = new Date();
    const nextUpdate = new Date(now.getTime() + intervalMinutes * 60 * 1000);
    const diff = nextUpdate - now;
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    nextTimeEl.textContent = `Наступне: ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Збереження стану AFK у файл
 */
function saveAfkStateToFile() {
    const state = window.AppState;

    const afkState = {
        isActive: state.isAutoRefreshActive || false,
        cabinets: Array.from(state.cabinetsToUpdate || []),
        pausedCabinets: Array.from(state.cabinetsPaused || []),
        lastUpdate: new Date().toISOString()
    };

    fetch('/api/afk-state', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(afkState)
    }).then(response => response.json())
      .then(data => {
          if (data.success) {
              console.log('Стан AFK збережено');
          }
      })
      .catch(err => {
          console.warn('Не вдалося зберегти стан AFK:', err);
      });
}

console.log('afk.js loaded');
