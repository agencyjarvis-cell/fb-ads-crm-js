/**
 * stats.js - Статистика та обчислення
 * FB Ads + CRM Automation
 */

// ============================================================================
// ОБЧИСЛЕННЯ СТАТИСТИКИ
// ============================================================================

/**
 * Перерахунок статистики з масиву рядків
 */
function recomputeStatsFromRows(rows) {
    const data = Array.isArray(rows) ? rows : [];
    const activeRows = data.filter(row => row.status !== 'crm_only');

    const total = activeRows.length;
    const withLeads = activeRows.filter(row => Number(row.leads) > 0).length;
    const noLeads = activeRows.filter(row => Number(row.spend) > 0 && (!row.leads || Number(row.leads) === 0)).length;
    const highCpl = activeRows.filter(row => row.status === 'high_cpl').length;
    const totalSpend = activeRows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);
    const totalLeads = activeRows.reduce((sum, row) => sum + (Number(row.leads) || 0), 0);
    const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0;
    const crmOnly = data.filter(row => row.status === 'crm_only').length;

    return {
        total,
        with_leads: withLeads,
        no_leads: noLeads,
        high_cpl: highCpl,
        total_spend: Number(totalSpend.toFixed(2)),
        total_leads: totalLeads,
        avg_cpl: Number(avgCpl.toFixed(2)),
        crm_only_count: crmOnly
    };
}

// ============================================================================
// ОНОВЛЕННЯ UI СТАТИСТИКИ
// ============================================================================

/**
 * Оновлення блоку статистики в UI
 */
function updateStats(stats) {
    const statsDiv = document.getElementById('resultsStats');
    const safeStats = stats || {};

    // Перевірка на null - елемент може не існувати якщо Крок 4 ще не відображається
    if (!statsDiv) {
        console.log('updateStats: resultsStats елемент не знайдено, пропускаю');
        // Але все одно оновлюємо міні-статистику якщо вона є
        updateMiniStats(safeStats);
        return;
    }

    statsDiv.innerHTML = `
        <div class="stat-card">
            <h3>${safeStats.total ?? 0}</h3>
            <p>Всього кампаній</p>
        </div>
        <div class="stat-card">
            <h3>${safeStats.with_leads ?? 0}</h3>
            <p>З лідами</p>
        </div>
        <div class="stat-card">
            <h3>${safeStats.no_leads ?? 0}</h3>
            <p>Без лідів</p>
        </div>
        <div class="stat-card">
            <h3>${safeStats.high_cpl ?? 0}</h3>
            <p>Високий CPL</p>
        </div>
        <div class="stat-card">
            <h3>${formatCurrency(safeStats.total_spend || 0)}</h3>
            <p>Витрати</p>
        </div>
        <div class="stat-card">
            <h3>${safeStats.total_leads ?? 0}</h3>
            <p>Ліди</p>
        </div>
        <div class="stat-card">
            <h3>${formatCurrency(safeStats.avg_cpl || 0)}</h3>
            <p>Середній CPL</p>
        </div>
    `;

    // Якщо є crm_only, показуємо окремо
    if ((safeStats.crm_only_count || 0) > 0) {
        statsDiv.innerHTML += `
            <div class="stat-card" style="background: linear-gradient(135deg, #fff3cd 0%, #fff9e6 100%); border-left: 4px solid #ffc107;">
                <h3>${safeStats.crm_only_count}</h3>
                <p>Тільки в CRM</p>
            </div>
        `;
    }

    // Оновлюємо міні-статистику
    updateMiniStats(safeStats);
}

/**
 * Оновлення міні-статистики на Кроці 4
 */
function updateMiniStats(stats) {
    const safeStats = stats || {};

    const miniSpend = document.getElementById('miniStatSpend');
    const miniLeads = document.getElementById('miniStatLeads');
    const miniCPL = document.getElementById('miniStatCPL');

    if (miniSpend) miniSpend.textContent = formatCurrency(safeStats.total_spend || 0);
    if (miniLeads) miniLeads.textContent = safeStats.total_leads ?? 0;
    if (miniCPL) miniCPL.textContent = formatCurrency(safeStats.avg_cpl || 0);
}

/**
 * Ініціалізація таблиці результатів (скидання)
 */
function initializeResultsTable() {
    window.lastResults = [];
    window.currentMatchedRows = [];
    window.currentCrmOnlyRows = [];

    if (window.AppState) {
        window.AppState.openCabinetIds = new Set();
        window.AppState.openCampaignIds = new Set();
        window.AppState.knownCabinetBodyIds = new Set();
        window.AppState.isRealtimeViewActive = true;
    }

    if (typeof updateResultsMeta === 'function') {
        updateResultsMeta(null);
    }
    if (typeof syncResultsSortSelect === 'function') {
        syncResultsSortSelect();
    }

    const statsDiv = document.getElementById('resultsStats');
    if (statsDiv) {
        statsDiv.innerHTML = `
            <div class="stat-card"><h3>0</h3><p>Всього кампаній</p></div>
            <div class="stat-card"><h3>0</h3><p>З лідами</p></div>
            <div class="stat-card"><h3>0</h3><p>Без лідів</p></div>
            <div class="stat-card"><h3>0</h3><p>Високий CPL</p></div>
            <div class="stat-card"><h3>$0.00</h3><p>Витрати</p></div>
            <div class="stat-card"><h3>0</h3><p>Ліди</p></div>
            <div class="stat-card"><h3>$0.00</h3><p>Середній CPL</p></div>
        `;
    }

    // Скидаємо міні-статистику
    updateMiniStats({total_spend: 0, total_leads: 0, avg_cpl: 0});
}

/**
 * Фіналізація результатів
 */
function finalizeResults(allData, stats, settings = null) {
    const normalizedData = (allData || []).map(row => ensureRowHasNormalizedId({...row}));
    window.lastResults = normalizedData;
    window.currentMatchedRows = [...normalizedData];
    window.currentCrmOnlyRows = allData.filter(row => row.status === 'crm_only');

    if (typeof updateResultsMeta === 'function') {
        updateResultsMeta(settings || window.AppState?.lastRunSettings);
    }
    if (typeof renderAllCabinetsSection === 'function') {
        renderAllCabinetsSection();
    }
    if (typeof detectInactiveCabinets === 'function') {
        detectInactiveCabinets();
    }
}

console.log('stats.js loaded');
