/**
 * tree.js - Рендеринг дерева кампаній (cabinets → campaigns → adsets → ads)
 * FB Ads + CRM Automation
 */

// ============================================================================
// TOGGLE ФУНКЦІЇ
// ============================================================================

/**
 * Тогл кабінету (розгортання/згортання)
 */
function toggleCabinet(cabinetId) {
    const element = document.getElementById(cabinetId);
    if (!element) return;

    const state = window.AppState;
    if (state.openCabinetIds.has(cabinetId)) {
        state.openCabinetIds.delete(cabinetId);
        element.style.display = 'none';
    } else {
        state.openCabinetIds.add(cabinetId);
        element.style.display = 'block';
    }
}

/**
 * Тогл adset (розгортання/згортання)
 */
function toggleAdset(adsetId) {
    const element = document.getElementById(adsetId);
    if (!element) return;

    const state = window.AppState;
    if (state.openCampaignIds.has(adsetId)) {
        state.openCampaignIds.delete(adsetId);
        element.style.display = 'none';
    } else {
        state.openCampaignIds.add(adsetId);
        element.style.display = 'block';
    }
}

/**
 * Тогл кампанії
 */
function toggleCampaign(campaignId) {
    const element = document.getElementById(campaignId);
    if (!element) return;

    const state = window.AppState;
    if (state.openCampaignIds.has(campaignId)) {
        state.openCampaignIds.delete(campaignId);
        element.classList.remove('open');
    } else {
        state.openCampaignIds.add(campaignId);
        element.classList.add('open');
    }
}

// ============================================================================
// РЕНДЕРИНГ ADSETS ТА ADS
// ============================================================================

/**
 * Рендерить список adsets
 */
function renderAdsets(adsets, parentKey = '', autoExpand = false) {
    if (!adsets || adsets.length === 0) {
        return '<div style="padding: 8px; color: var(--text-secondary);">Немає adsets</div>';
    }

    const state = window.AppState;
    let html = '';

    adsets.forEach((adset, idx) => {
        const adsetDomBase = `${parentKey}_adset_${sanitizeId(adset.id || `idx_${idx}`, idx)}`;
        const adsetBodyId = `${adsetDomBase}_body`;
        const isOpen = autoExpand || state.openCampaignIds.has(adsetBodyId);
        const arrow = isOpen ? '▼' : '▶';

        const adsetSpend = parseFloat(adset.spend || 0) || 0;
        const adsetLeads = calculateAdsetLeads(adset);
        const adsetCpl = formatCpl(adsetSpend, adsetLeads);
        const adsetStatus = adset.status || '';
        const normalizedStatus = normalizeStatus(adsetStatus);
        const statusStyle = getStatusStyle(adsetStatus);
        const targetStatus = getNextAdsetStatus(normalizedStatus);
        const buttonLabel = targetStatus === 'ACTIVE' ? '▶ Увімкнути' : '⏸ Вимкнути';
        const buttonClass = `adset-status-btn ${targetStatus === 'ACTIVE' ? 'on' : 'off'}`;
        const accountId = adset.account_id || adset.adaccount_id || adset.accountId || '';
        const fbtoolId = adset.fbtool_account_id || adset.fbtoolAccountId || '';

        // Перевіряємо чи можна toggle
        const canToggle = !normalizedStatus.includes('REJECT') &&
                          !normalizedStatus.includes('DISAPPROV') &&
                          normalizedStatus !== 'DELETED';

        html += `
            <div style="margin-bottom: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--bg-tertiary); border-radius: 6px; cursor: pointer;" onclick="toggleAdset('${adsetBodyId}')">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span>${arrow}</span>
                        <span style="font-weight: 500;">📋 ${adset.name || 'Unknown Adset'}</span>
                        <span style="background: ${statusStyle.bg}; color: ${statusStyle.color}; padding: 2px 6px; border-radius: 3px; font-size: 11px;">
                            ${statusStyle.icon} ${adsetStatus}
                        </span>
                    </div>
                    <div style="display: flex; gap: 16px; align-items: center;">
                        <div style="text-align: right;">
                            <div style="font-size: 11px; color: var(--text-secondary);">Spend</div>
                            <div style="font-weight: bold; color: #ff7043;">$${adsetSpend.toFixed(2)}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 11px; color: var(--text-secondary);">Ліди</div>
                            <div style="font-weight: bold; color: #42a5f5;">${adsetLeads}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 11px; color: var(--text-secondary);">CPL</div>
                            <div style="font-weight: bold; color: #66bb6a;">${adsetCpl}</div>
                        </div>
                        <button
                            class="${buttonClass}"
                            data-adset-id="${adset.id}"
                            data-current-status="${normalizedStatus}"
                            data-account-id="${accountId}"
                            data-fbtool-id="${fbtoolId}"
                            ${canToggle ? '' : 'disabled style="opacity: 0.5; cursor: not-allowed;"'}
                            onclick="handleAdsetStatusToggle(event)">
                            ${canToggle ? buttonLabel : '🚫 Неможливо'}
                        </button>
                    </div>
                </div>

                <div id="${adsetBodyId}" style="display: ${isOpen ? 'block' : 'none'}; margin-left: 24px; margin-top: 8px;">
                    ${renderAds(adset.ads || [])}
                </div>
            </div>
        `;
    });

    return html;
}

/**
 * Рендерить список ads
 */
function renderAds(ads) {
    if (!ads || ads.length === 0) {
        return '<div style="padding: 8px; color: var(--text-secondary); font-size: 13px;">Немає ads</div>';
    }

    let html = '';
    ads.forEach(ad => {
        const adSpend = parseFloat(ad.spend || 0);
        const adStatus = ad.status || '';
        const statusStyle = getStatusStyle(adStatus);
        const adLeads = parseFloat(ad.leads || 0) || 0;
        const adCpl = adLeads > 0 ? formatCpl(adSpend, adLeads) : '—';

        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 4px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span>📱</span>
                    <span style="font-size: 13px;">${ad.name || 'Unknown Ad'}</span>
                    <span style="background: ${statusStyle.bg}; color: ${statusStyle.color}; padding: 1px 4px; border-radius: 2px; font-size: 10px;">
                        ${statusStyle.icon} ${adStatus}
                    </span>
                </div>
                <div style="display: flex; gap: 12px; align-items: center;">
                    <div style="text-align: right;">
                        <div style="font-size: 11px; color: var(--text-secondary);">Spend</div>
                        <div style="font-size: 13px; color: #ff7043; font-weight: 600;">$${adSpend.toFixed(2)}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 11px; color: var(--text-secondary);">Ліди</div>
                        <div style="font-size: 13px; color: #42a5f5; font-weight: 600;">${adLeads}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 11px; color: var(--text-secondary);">CPL</div>
                        <div style="font-size: 13px; color: #66bb6a; font-weight: 600;">${adCpl}</div>
                    </div>
                </div>
            </div>
        `;
    });

    return html;
}

// ============================================================================
// ОБРОБНИКИ TOGGLE ДЛЯ HIERARCHY
// ============================================================================

/**
 * Ініціалізує обробники кліків на toggle елементах
 */
function initHierarchyToggles() {
    document.addEventListener('click', (e) => {
        const toggleEl = e.target.closest('.hierarchy-toggle');
        if (!toggleEl) return;

        const toggleId = toggleEl.dataset.toggleId;
        const toggleType = toggleEl.dataset.toggleType;

        if (!toggleId) return;

        if (toggleType === 'cabinet') {
            toggleCabinet(toggleId);
        } else if (toggleType === 'campaign') {
            toggleCampaign(toggleId);
        }

        // Оновлюємо стрілку
        const state = window.AppState;
        const isOpen = toggleType === 'cabinet'
            ? state.openCabinetIds.has(toggleId)
            : state.openCampaignIds.has(toggleId);
        toggleEl.textContent = isOpen ? '▼' : '▶';
    });
}

/**
 * Обробник toggle статусу adset
 */
async function handleAdsetStatusToggle(event) {
    event.stopPropagation();
    const button = event.currentTarget;
    if (!button) return;

    const adsetId = button.dataset.adsetId;
    const currentStatus = button.dataset.currentStatus || '';
    const accountId = button.dataset.accountId;
    const fbtoolId = button.dataset.fbtoolId || '';

    if (!adsetId || !accountId) {
        showError('Немає даних для зміни статусу адсету');
        return;
    }

    const targetStatus = getNextAdsetStatus(currentStatus);
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = targetStatus === 'ACTIVE' ? '▶ …' : '⏸ …';

    await changeAdsetStatus(adsetId, accountId, fbtoolId, targetStatus, button);

    if (document.body.contains(button)) {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// ============================================================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ============================================================================

/**
 * Підрахунок лідів для adset
 */
function calculateAdsetLeads(adset) {
    // Спочатку перевіряємо чи вже є leads
    if (adset.leads !== undefined && adset.leads !== null) {
        return parseInt(adset.leads) || 0;
    }
    // Потім перевіряємо історичні ліди
    if (adset.historical_leads !== undefined) {
        return parseInt(adset.historical_leads) || 0;
    }
    // Сумуємо ліди з ads
    if (Array.isArray(adset.ads)) {
        return adset.ads.reduce((sum, ad) => sum + (parseInt(ad.leads) || 0), 0);
    }
    return 0;
}

/**
 * Форматування тегу статусу
 */
function formatStatusTag(status) {
    if (!status) return '';
    const statusStyle = getStatusStyle(status);
    return `<span style="background: ${statusStyle.bg}; color: ${statusStyle.color}; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-left: 8px;">${statusStyle.icon} ${status}</span>`;
}

console.log('tree.js loaded');
