/**
 * utils.js - Утиліти та допоміжні функції
 * FB Ads + CRM Automation
 */

// ============================================================================
// ФОРМАТУВАННЯ
// ============================================================================

/**
 * Форматування суми в валюту
 */
function formatCurrency(value) {
    const numeric = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isFinite(numeric)) {
        return `$${numeric.toFixed(2)}`;
    }
    return '$0.00';
}

/**
 * Форматування CPL (Cost Per Lead)
 */
function formatCpl(spend, leads) {
    if (leads > 0) {
        return `$${(spend / leads).toFixed(2)}`;
    }
    return '—';
}

// ============================================================================
// НОРМАЛІЗАЦІЯ ID
// ============================================================================

/**
 * Нормалізація ID кабінету (додає act_ якщо немає)
 */
function normalizeCabinetId(value) {
    if (!value) return '';
    const stringValue = String(value);
    return stringValue.startsWith('act_') ? stringValue : `act_${stringValue}`;
}

/**
 * Отримати ID кабінету з рядка даних
 */
function getRowCabinetId(row) {
    if (!row) return '';
    const raw = row.account_id || row.adaccount_id || row.adaccountId || '';
    return normalizeCabinetId(raw);
}

/**
 * Забезпечити наявність нормалізованого ID в рядку
 */
function ensureRowHasNormalizedId(row) {
    if (!row) return row;
    const normalizedId = getRowCabinetId(row);
    if (normalizedId) {
        row.account_id = normalizedId;
        row.adaccount_id = normalizedId;
    }
    return row;
}

/**
 * Санітизація ID для DOM (видаляє недозволені символи)
 */
function sanitizeId(value, fallback = '') {
    if (!value) return `id_${fallback}`;
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ============================================================================
// СТАТУСИ
// ============================================================================

/**
 * Нормалізація статусу (uppercase)
 */
function normalizeStatus(statusValue) {
    return String(statusValue || '').toUpperCase();
}

/**
 * Отримати наступний статус для toggle
 */
function getNextAdsetStatus(currentStatus) {
    const normalized = normalizeStatus(currentStatus);
    return normalized.includes('ACTIVE') ? 'PAUSED' : 'ACTIVE';
}

/**
 * Отримати стиль для статусу (колір, іконка)
 */
function getStatusStyle(status) {
    const normalized = String(status || '').toUpperCase();

    // ACTIVE - зелений
    if (normalized === 'ACTIVE') {
        return { bg: '#4caf50', icon: '✅', color: 'white' };
    }

    // REJECTED/DISAPPROVED/WITH_ISSUES - червоний
    if (normalized.includes('REJECT') || normalized.includes('DISAPPROV') ||
        normalized.includes('ISSUE') || normalized === 'DELETED') {
        return { bg: '#f44336', icon: '🚫', color: 'white' };
    }

    // PAUSED - помаранчевий
    if (normalized === 'PAUSED' || normalized === 'CAMPAIGN_PAUSED' ||
        normalized === 'ADSET_PAUSED') {
        return { bg: '#ff9800', icon: '⏸️', color: 'white' };
    }

    // ARCHIVED - сірий
    if (normalized === 'ARCHIVED') {
        return { bg: '#9e9e9e', icon: '📦', color: 'white' };
    }

    // PENDING - синій
    if (normalized.includes('PENDING') || normalized.includes('IN_PROCESS')) {
        return { bg: '#2196F3', icon: '⏳', color: 'white' };
    }

    // За замовчуванням - сірий
    return { bg: '#757575', icon: '❓', color: 'white' };
}

// ============================================================================
// ДЕДУПЛІКАЦІЯ
// ============================================================================

/**
 * Видалення дублікатів кампаній
 */
function dedupeCampaignRows(rows) {
    if (!Array.isArray(rows)) return [];
    const map = new Map();

    rows.forEach((row, idx) => {
        const cabId = getRowCabinetId(row);
        const campaignKey = row.campaign_id || row.campaign_name || row.id || row.name || `row_${idx}`;
        if (!cabId || !campaignKey) return;
        const key = `${cabId}::${campaignKey}`;
        const existing = map.get(key);
        if (!existing || shouldReplaceCampaign(existing, row)) {
            map.set(key, row);
        }
    });

    // Додаємо рядки без ключа (наприклад crm_only) в кінець
    rows.forEach((row, idx) => {
        const cabId = getRowCabinetId(row);
        const campaignKey = row.campaign_id || row.campaign_name || row.id || row.name || `row_${idx}`;
        if (!cabId || !campaignKey) {
            map.set(`__misc_${idx}`, row);
        }
    });

    return Array.from(map.values());
}

/**
 * Перевірка чи слід замінити кампанію
 */
function shouldReplaceCampaign(currentRow, newRow) {
    const currentLeads = Number(currentRow?.leads) || 0;
    const newLeads = Number(newRow?.leads) || 0;
    const currentSpend = Number(currentRow?.spend) || 0;
    const newSpend = Number(newRow?.spend) || 0;

    // Замінюємо якщо новий рядок має більше лідів або витрат
    return newLeads > currentLeads || (newLeads === currentLeads && newSpend > currentSpend);
}

// ============================================================================
// СПОВІЩЕННЯ
// ============================================================================

/**
 * Показати toast notification
 */
function showNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 20px 30px;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
        z-index: 10000;
        font-size: 14px;
        white-space: pre-line;
        animation: slideInRight 0.3s ease-out;
        max-width: 400px;
    `;
    notification.innerHTML = message;

    // Додаємо CSS для анімації якщо його ще немає
    if (!document.getElementById('notificationStyles')) {
        const style = document.createElement('style');
        style.id = 'notificationStyles';
        style.innerHTML = `
            @keyframes slideInRight {
                from { transform: translateX(400px); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(400px); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    // Автоматично видаляємо через 5 секунд
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, window.AppConfig?.NOTIFICATION_DURATION || 5000);
}

/**
 * Показати помилку
 */
function showError(message) {
    alert('❌ ' + message);
}

// ============================================================================
// ДОПОМІЖНІ
// ============================================================================

/**
 * Затримка (Promise-based sleep)
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Безпечне отримання числа
 */
function safeNumber(value, defaultValue = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
}

console.log('✅ utils.js loaded');
