/**
 * config.js - Глобальні змінні та константи
 * FB Ads + CRM Automation
 */

// ============================================================================
// ГЛОБАЛЬНІ ЗМІННІ СТАНУ
// ============================================================================

// Дані акаунтів
window.AppState = {
    accounts: [],
    adaccounts: [],
    selectedAccounts: [],
    selectedAdaccounts: [],
    cabinetsToUpdate: new Set(),
    cabinetsPaused: new Set(),

    // UI стан
    openCabinetIds: new Set(),
    openCampaignIds: new Set(),
    knownCabinetBodyIds: new Set(),
    isRealtimeViewActive: false,

    // Lock система
    isGlobalBusy: false,
    busyOperation: null,

    // Auto-refresh
    autoRefreshInterval: null,
    autoRefreshNextUpdate: null,
    crmRefreshInterval: null,
    isAutoRefreshActive: false,

    // Інше
    inactiveCabinetsData: [],
    lastRunSettings: null,
    modalContext: 'step2',
    currentSortOption: 'default',
    currentResultsTab: 'active',
    lastRequestedCabinets: [],

    // Результати
    lastResults: [],
    currentMatchedRows: [],
    currentCrmOnlyRows: []
};

// ============================================================================
// АВТОПРАВИЛА V2 - НАЛАШТУВАННЯ
// ============================================================================

window.AutoRulesV2 = {
    settings: {
        global_enabled: false,
        cabinet_enabled: {},
        disable_rules: {
            check_spend: true,
            min_spend: 3.0,
            check_leads: true,
            min_leads: 0,
            check_cpl: false,
            max_cpl: 10.0
        },
        enable_rules: {
            check_spend: false,
            min_spend: 5.0,
            check_leads: true,
            min_leads: 1,
            check_cpl: true,
            max_cpl: 5.0
        },
        cooldown_minutes: 30,
        groups: []
    },
    running: false,
    cooldowns: {},
    currentRulesTab: 'cabinets'
};

// ============================================================================
// КОНСТАНТИ
// ============================================================================

window.AppConfig = {
    // Rate limiting
    MAX_REQUESTS_PER_MINUTE: 19,

    // Timeouts
    API_TIMEOUT: 30000,

    // Auto-refresh defaults
    DEFAULT_REFRESH_INTERVAL: 3, // хвилин
    CRM_REFRESH_INTERVAL: 60000, // 1 хвилина в мс

    // UI
    NOTIFICATION_DURATION: 5000,

    // Статуси
    STATUS_ACTIVE: 'ACTIVE',
    STATUS_PAUSED: 'PAUSED'
};

// ============================================================================
// ІНІЦІАЛІЗАЦІЯ
// ============================================================================

// Зупинка auto-refresh при закритті сторінки
window.addEventListener('beforeunload', () => {
    if (window.AppState.isAutoRefreshActive) {
        window.AppState.isAutoRefreshActive = false;
        if (typeof stopAutoRefresh === 'function') {
            stopAutoRefresh();
        }
    }
});

console.log('✅ config.js loaded');
