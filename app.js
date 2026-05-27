        let accounts = [];
        let adaccounts = [];
        let selectedAccounts = [];
        let selectedAdaccounts = [];
        let cabinetsToUpdate = new Set(); // Кабінети вибрані для оновлення (за замовчуванням всі)
        let cabinetsPaused = new Set(); // Кабінети на паузі для auto-refresh (не оновлюються в АФК режимі)
        let openCabinetIds = new Set();
        let openCampaignIds = new Set();
        let knownCabinetBodyIds = new Set();
        let isRealtimeViewActive = false;

        // 🔒 GLOBAL LOCK SYSTEM - запобігає паралельним запитам
        let isGlobalBusy = false;
        let busyOperation = null; // Назва поточної операції

        // Auto-refresh variables
        let autoRefreshInterval = null;
        let autoRefreshNextUpdate = null;
        let crmRefreshInterval = null;  // Окремий таймер для CRM (кожну хвилину)
        let isAutoRefreshActive = false;

        // Зупинка auto-refresh при закритті сторінки
        window.addEventListener('beforeunload', () => {
            if (isAutoRefreshActive) {
                isAutoRefreshActive = false;
                stopAutoRefresh();
            }
        });

        let inactiveCabinetsData = [];
        let lastRunSettings = null;
        let modalContext = 'step2';
        let currentSortOption = 'default';
        let currentResultsTab = 'active';
        let lastRequestedCabinets = [];

        // ============================================================================
        // 🚀 SMART BATCH REQUEST QUEUE MANAGER - Розумне батчування з пріоритетами
        // ============================================================================

        class RequestQueueManager {
            constructor() {
                this.queue = [];              // Черга звичайних запитів
                this.priorityQueue = [];      // Пріоритетна черга (адсети)
                this.maxPerMinute = 29;       // Ліміт 30 (залишаємо 1 резерв)
                this.minuteStartTime = null;  // Початок поточної хвилини
                this.requestsThisMinute = 0;  // Лічильник запитів
            }

            // Додати звичайний запит (АФК оновлення)
            addRequest(adId, date, options) {
                this.queue.push({
                    type: 'cabinet_refresh',
                    adId,
                    date,
                    options,
                    priority: 0
                });
                console.log(`📦 [Queue] Додано запит: ${adId} (черга: ${this.queue.length})`);
            }

            // Додати пріоритетний запит (pause/unpause адсету)
            addPriorityRequest(adsetId, action) {
                this.priorityQueue.push({
                    type: 'adset_action',
                    adsetId,
                    action,  // 'pause' або 'unpause'
                    priority: 10
                });
                console.log(`⚡ [Queue] Пріоритетний запит: ${adsetId} ${action} (пріоритетна черга: ${this.priorityQueue.length})`);
            }

            // Перевірка чи є запити в черзі
            hasRequests() {
                return this.queue.length > 0 || this.priorityQueue.length > 0;
            }

            // Helper функція для затримки
            sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            // Виконання одного запиту
            async executeRequest(req) {
                if (req.type === 'cabinet_refresh') {
                    return await refreshCabinetData(req.adId, req.date, req.options);
                } else if (req.type === 'adset_action') {
                    // TODO: реалізувати пріоритетні операції з адсетами
                    console.log(`⚡ Виконання пріоритетного запиту: ${req.adsetId} ${req.action}`);
                    return {success: true};
                }
            }

            // Обробка батча запитів
            async processBatch() {
                // Початок нової хвилини?
                const now = Date.now();
                if (!this.minuteStartTime || now - this.minuteStartTime >= 60000) {
                    this.minuteStartTime = now;
                    this.requestsThisMinute = 0;
                    console.log('⏱️ [Batch] Нова хвилина почалась');
                }

                // Скільки запитів можемо зробити?
                const available = this.maxPerMinute - this.requestsThisMinute;
                if (available <= 0) {
                    const waitTime = 60000 - (now - this.minuteStartTime);
                    console.log(`⏳ [Batch] Чекаємо ${Math.ceil(waitTime/1000)} сек до нової хвилини... (вже використано ${this.requestsThisMinute}/19)`);

                    // Оновлюємо UI індикатор
                    busyOperation = `⏳ Очікування нової хвилини (${Math.ceil(waitTime/1000)}с)`;
                    updateGlobalStatusIndicator();

                    await this.sleep(waitTime + 100); // +100мс для гарантії
                    return this.processBatch(); // Рекурсія після очікування
                }

                // Формуємо батч: ПРІОРИТЕТИ ПЕРШІ
                const batch = [
                    ...this.priorityQueue.splice(0, available),
                    ...this.queue.splice(0, Math.max(0, available - this.priorityQueue.length))
                ];

                if (batch.length === 0) {
                    console.log('✅ [Batch] Черга пуста');
                    return [];
                }

                const priorityCount = batch.filter(r => r.priority > 0).length;
                const regularCount = batch.length - priorityCount;

                console.log(`🚀 [Batch] Обробка батча: ${batch.length} запитів (${priorityCount} пріоритетних + ${regularCount} звичайних) [${this.requestsThisMinute + batch.length}/19 за хвилину]`);

                // Оновлюємо UI індикатор
                busyOperation = `🚀 Batch: ${batch.length} запитів [${this.requestsThisMinute + batch.length}/19]`;
                updateGlobalStatusIndicator();

                // Виконуємо ПАРАЛЕЛЬНО
                const promises = batch.map((req, idx) => {
                    return this.executeRequest(req)
                        .then(result => {
                            console.log(`✅ [Batch ${idx + 1}/${batch.length}] Запит виконано: ${req.adId || req.adsetId}`);
                            return {status: 'fulfilled', value: {success: true, ...result}};
                        })
                        .catch(error => {
                            console.warn(`❌ [Batch ${idx + 1}/${batch.length}] Помилка: ${req.adId || req.adsetId}`, error);
                            return {status: 'rejected', reason: error};
                        });
                });

                const results = await Promise.all(promises);
                this.requestsThisMinute += batch.length;

                // Статистика
                const successCount = results.filter(r => r.status === 'fulfilled').length;
                console.log(`✅ [Batch] Завершено: ${successCount}/${batch.length} успішно (використано ${this.requestsThisMinute}/19 за хвилину)`);

                return results;
            }
        }

        // Глобальний екземпляр queue manager
        const queueManager = new RequestQueueManager();

        // ============================================================================
        // АВТОПРАВИЛА - СИСТЕМА АВТОМАТИЧНИХ ПРАВИЛ
        // ============================================================================

        let autoRulesV2Settings = {
            global_enabled: true,
            // Загальні правила (за замовчуванням)
            default_rules: {
                threshold_0_leads: 5.00,
                threshold_1_lead: 7.00,
                threshold_2_leads: 13.60,
                threshold_3_leads: 18.00,
                target_cpl_after_3: 5.00
            },
            // Групи кабінетів з власними правилами
            groups: [
                // {
                //   id: 'group_1',
                //   name: 'Група 1',
                //   cabinets: ['act_123', 'act_456'],
                //   rules: { threshold_0_leads: 10, ... }
                // }
            ],
            cooldown_minutes: 15,
            min_interval_minutes: 1,
            cabinet_enabled: {},  // {cabinetId: true/false}
            adset_disabled_at: {} // {adsetId: timestamp}
        };

        let autoRulesV2DisabledAdsets = new Set(); // Adsets вимкнені автоправилами
        let autoRulesV2RateLimitQueue = []; // Черга операцій для rate limit
        let autoRulesV2Running = false; // Захист від паралельних запусків

        // ============================================================================
        // НОВІ ФУНКЦІЇ ДЛЯ КРОКУ 4 - АКТИВНІ КАМПАНІЇ
        // ============================================================================

        /**
         * Перевіряє чи кампанія активна
         * Активна = (spend > 0) OR (всі елементи ACTIVE)
         */
        function isActiveCampaign(campaign) {
            // ✅ Використовуємо реальний spend з ads, а не campaign.spend
            const actualSpend = calculateActualSpend(campaign);
            const hasSpend = actualSpend > 0;
            const hasLeads = calculateTotalLeads(campaign) > 0;

            // Перевіряємо статуси
            const statusText = String(campaign.campaign_status || campaign.campaign_effective_status || '').toUpperCase();
            const campaignActive = statusText.includes('ACTIVE');
            const hasActiveElements = campaign.adsets && campaign.adsets.some(adset => {
                const adsetStatus = String(adset.status || adset.effective_status || adset.ad_status || '').toUpperCase();
                const adsetActive = adsetStatus.includes('ACTIVE');
                if (!adset.ads || !Array.isArray(adset.ads)) {
                    return adsetActive;
                }
                const hasActiveAds = adset.ads.some(ad => {
                    const adStatus = String(ad.status || ad.effective_status || '').toUpperCase();
                    return adStatus.includes('ACTIVE');
                });
                return adsetActive && hasActiveAds;
            });

            // ✅ Активна кампанія = spend або ліди > 0, або активний статус з активними елементами
            return hasSpend || hasLeads || (campaignActive && hasActiveElements);
        }

        /**
         * Групує кампанії за кабінетами, з опцією фільтру тільки активних
         */
        function groupCampaignsByCabinet(rawData, options = {}) {
            const {onlyActive = true} = options;
            if (!rawData || !Array.isArray(rawData)) return [];

            const byCabinet = {};

            rawData.forEach(row => {
                const statusNormalized = String(row.status || '').toLowerCase();
                if (statusNormalized === 'crm_only') return;

                const cabinetRawId = row.account_id || row.adaccount_id;
                if (!cabinetRawId) return;

                if (onlyActive && !isActiveCampaign(row)) {
                    return;
                }

                const cabinetId = normalizeCabinetId(cabinetRawId);
                if (!byCabinet[cabinetId]) {
                    byCabinet[cabinetId] = {
                        id: cabinetId,
                        name: row.account_name || row.adaccount_name || 'Unknown',
                        profile: row.profile_name || row.fbtool_account_name || row.profile || '',
                        status: row.adaccount_status,
                        spend: 0,
                        leads: 0,
                        cpl: null,
                        campaigns: [],
                        __campaignMap: new Map()
                    };
                }

                const cabinet = byCabinet[cabinetId];
                const spendValue = Number(row.spend) || 0;
                const leadsValue = Number(row.leads) || 0;
                cabinet.spend += spendValue;
                cabinet.leads += leadsValue;
                cabinet.cpl = cabinet.leads > 0 ? cabinet.spend / cabinet.leads : null;
                const campaignKey = row.campaign_id || row.campaign_name || `${cabinet.campaigns.length}`;
                const existing = cabinet.__campaignMap.get(campaignKey);
                if (existing) {
                    if (shouldReplaceCampaign(existing, row)) {
                        cabinet.__campaignMap.set(campaignKey, row);
                        const idx = cabinet.campaigns.indexOf(existing);
                        if (idx >= 0) {
                            cabinet.campaigns[idx] = row;
                        }
                    }
                } else {
                    cabinet.__campaignMap.set(campaignKey, row);
                    cabinet.campaigns.push(row);
                }
            });

            return Object.values(byCabinet)
                .map(cab => {
                    delete cab.__campaignMap;
                    return cab;
                })
                .filter(cab => cab.campaigns.length > 0);
        }

        function filterActiveCampaigns(rawData) {
            return groupCampaignsByCabinet(rawData, {onlyActive: true});
        }

        /**
         * Відображає дерево активних кампаній
         */
        /**
         * Автоматично вимикає забанені адсети
         * Повертає масив ID вимкнених адсетів
         */
        async function autoDisableRejectedAdsets(data) {
            if (!Array.isArray(data) || data.length === 0) {
                return [];
            }

            const disabledAdsets = [];
            const api = {
                accountId: null,
                fbtoolAccountId: null
            };

            // Проходимо по всіх рядках даних
            for (const row of data) {
                if (!row.adsets || row.adsets.length === 0) continue;

                // Отримуємо інфо про кабінет для API запитів
                api.accountId = row.adaccount_id;
                api.fbtoolAccountId = row.fbtool_account_id;

                // Перевіряємо кожен адсет
                for (const adset of row.adsets) {
                    // Якщо адсет має заблоковані оголошення і він активний
                    if (adset.has_rejected_ads && (adset.status === 'ACTIVE' || adset.effective_status === 'ACTIVE')) {
                        console.log(`🚫 Вимикаю забанений адсет: ${adset.name} (ID: ${adset.id})`);

                        try {
                            // Вимикаємо адсет через API
                            const response = await fetch('/api/adset/status', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    adset_id: adset.id,
                                    account_id: api.accountId,
                                    fbtool_account_id: api.fbtoolAccountId,
                                    status: 'PAUSED'
                                })
                            });

                            if (response.ok) {
                                disabledAdsets.push({
                                    id: adset.id,
                                    name: adset.name,
                                    campaign: row.campaign_name
                                });
                                // Оновлюємо статус локально
                                adset.status = 'PAUSED';
                                adset.effective_status = 'PAUSED';
                            } else {
                                console.error(`❌ Не вдалось вимкнути адсет ${adset.id}`);
                            }
                        } catch (error) {
                            console.error(`❌ Помилка при вимкненні адсету ${adset.id}:`, error);
                        }
                    }
                }
            }

            return disabledAdsets;
        }

        function renderActiveCampaignsTree(data) {
            const container = document.getElementById('activeCampaignsTree');
            if (!container) return;

            // 🔍 ДЕБАГ: логуємо що приходить
            console.log('🔍 renderActiveCampaignsTree - вхідні дані:', data);

            const cabinets = filterActiveCampaigns(data);
            const sortedCabinets = applySortToHierarchy(cabinets);

            console.log('🔍 Після фільтрації cabinets:', cabinets);

            if (sortedCabinets.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
                        <div style="font-size: 48px; margin-bottom: 16px;">📭</div>
                        <div style="font-size: 18px; margin-bottom: 8px;">Немає активних кампаній</div>
                        <div style="font-size: 14px;">Спочатку завантажте дані на Кроці 3</div>
                    </div>
                `;
                return;
            }

            let html = '';
            let pausedSectionStarted = false;

            sortedCabinets.forEach(cabinet => {
                const cabinetId = normalizeCabinetId(cabinet.id);
                const isPaused = cabinetsPaused.has(cabinetId);

                // 🔹 Додаємо роздільник перед першим кабінетом на паузі
                if (isPaused && !pausedSectionStarted) {
                    pausedSectionStarted = true;
                    html += `
                        <div style="
                            margin: 24px 0;
                            padding: 16px;
                            background: linear-gradient(90deg, #f0f0f0 0%, #e0e0e0 50%, #f0f0f0 100%);
                            border-top: 2px dashed #999;
                            border-bottom: 2px dashed #999;
                            text-align: center;
                            font-weight: 600;
                            color: var(--text-secondary);
                            border-radius: 8px;
                            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                        ">
                            <span style="font-size: 18px;">⏸️</span>
                            <span style="margin-left: 8px;">AFK ОНОВЛЕННЯ ВИМКНЕНО</span>
                            <span style="font-size: 18px; margin-left: 8px;">⏸️</span>
                        </div>
                    `;
                }

                cabinet.campaigns.forEach((campaign, index) => {
                    html += renderCabinetWithCampaign(cabinet, campaign, index);
                });
            });

            container.innerHTML = html;
        }

        /**
         * Рендерить один кабінет з кампанією
         */
        /**
         * Розраховує фактичний spend: сумуємо ads → adsets, якщо нема даних — беремо campaign.spend
         */
        function calculateActualSpend(campaign) {
            let totalSpend = 0;
            if (campaign.adsets && Array.isArray(campaign.adsets)) {
                campaign.adsets.forEach(adset => {
                    let adsetTotal = 0;
                    const adsetSpend = parseFloat(adset.spend || 0);
                    if (!Number.isNaN(adsetSpend) && adsetSpend > 0) {
                        adsetTotal = adsetSpend;
                    } else if (adset.ads && Array.isArray(adset.ads)) {
                        adset.ads.forEach(ad => {
                            const adSpend = parseFloat(ad.spend || 0);
                            if (!Number.isNaN(adSpend) && adSpend > 0) {
                                adsetTotal += adSpend;
                            }
                        });
                    }
                    totalSpend += adsetTotal;
                });
            }
            if (totalSpend > 0) {
                return totalSpend;
            }
            const fallback = parseFloat(campaign.spend || 0);
            return Number.isNaN(fallback) ? 0 : fallback;
        }

        function calculateTotalLeads(campaign) {
            if (typeof campaign.leads === 'number' && !Number.isNaN(campaign.leads)) {
                return campaign.leads;
            }
            if (campaign.adsets && Array.isArray(campaign.adsets)) {
                return campaign.adsets.reduce((sum, adset) => {
                    const adsetLeads = parseFloat(adset.leads || 0);
                    return sum + (Number.isNaN(adsetLeads) ? 0 : adsetLeads);
                }, 0);
            }
            return 0;
        }

        function calculateAdsetLeads(adset) {
            const leadsValue = parseFloat(adset.leads || 0);
            if (!Number.isNaN(leadsValue) && leadsValue > 0) {
                return leadsValue;
            }
            if (adset.ads && Array.isArray(adset.ads)) {
                return adset.ads.reduce((sum, ad) => {
                    const adLeads = parseFloat(ad.leads || 0);
                    return sum + (Number.isNaN(adLeads) ? 0 : adLeads);
                }, 0);
            }
            return 0;
        }

        function formatCpl(spend, leads) {
            if (leads > 0) {
                return `$${(spend / leads).toFixed(2)}`;
            }
            return '—';
        }

        function normalizeCabinetId(value) {
            if (!value) return '';
            const stringValue = String(value);
            return stringValue.startsWith('act_') ? stringValue : `act_${stringValue}`;
        }

        function getRowCabinetId(row) {
            if (!row) return '';
            const raw = row.account_id || row.adaccount_id || row.adaccountId || '';
            return normalizeCabinetId(raw);
        }

        function ensureRowHasNormalizedId(row) {
            if (!row) return row;
            const normalizedId = getRowCabinetId(row);
            if (normalizedId) {
                row.account_id = normalizedId;
                row.adaccount_id = normalizedId;
            }
            return row;
        }

        function dedupeCampaignRows(rows) {
            if (!Array.isArray(rows)) return [];
            const map = new Map();
            rows.forEach((row, idx) => {
                const cabId = getRowCabinetId(row);
                const campaignKey = row.campaign_id || row.campaign_name || row.id || row.name || `___default`;
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
                const campaignKey = row.campaign_id || row.campaign_name || row.id || row.name || `___default`;
                if (!cabId || !campaignKey) {
                    map.set(`__misc_${idx}`, row);
                }
            });
            return Array.from(map.values());
        }

        function normalizeStatus(statusValue) {
            return String(statusValue || '').toUpperCase();
        }

        function getNextAdsetStatus(currentStatus) {
            const normalized = normalizeStatus(currentStatus);
            return normalized.includes('ACTIVE') ? 'PAUSED' : 'ACTIVE';
        }

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

        function shouldReplaceCampaign(currentRow, newRow) {
            if (!currentRow) return true;
            if (!newRow) return false;
            const currentSpend = Number(currentRow.spend) || 0;
            const newSpend = Number(newRow.spend) || 0;
            if (newSpend > currentSpend) return true;
            if (newSpend < currentSpend) return false;

            const currentActive = isActiveCampaign(currentRow);
            const newActive = isActiveCampaign(newRow);
            if (newActive && !currentActive) return true;
            if (!newActive && currentActive) return false;

            const newTimestamp = new Date(newRow.timestamp || newRow.updated_at || newRow.date || 0).getTime();
            const currentTimestamp = new Date(currentRow.timestamp || currentRow.updated_at || currentRow.date || 0).getTime();
            if (Number.isFinite(newTimestamp) && Number.isFinite(currentTimestamp)) {
                return newTimestamp > currentTimestamp;
            }
            return true;
        }

        function renderCabinetWithCampaign(cabinet, campaign, campaignIndex = 0, autoExpand = false) {
            const cabinetBase = cabinet.id || cabinet.adaccount_id || `cab_${campaignIndex}`;
            const campaignBase = campaign.campaign_id || campaign.id || campaign.campaign_name || `campaign_${campaignIndex}`;
            const uniqueKey = `cab_${sanitizeId(cabinetBase)}_${sanitizeId(campaignBase, campaignIndex)}`;
            const bodyId = `${uniqueKey}_body`;
            const isOpen = autoExpand || openCabinetIds.has(bodyId);
            const arrow = isOpen ? '▼' : '▶';

            // ✅ Використовуємо реальний spend з ads, а не campaign.spend з історією
            const totalSpend = calculateActualSpend(campaign);
            const campaignName = campaign.campaign_name || 'Unknown Campaign';
            const campaignStatus = campaign.campaign_status || '';
            const totalLeads = calculateTotalLeads(campaign);
            const campaignCpl = formatCpl(totalSpend, totalLeads);

            // Визначаємо чи кабінет забанений
            const isCabinetBanned = cabinet.status != 1 && cabinet.status !== null;
            const banLabel = isCabinetBanned ? ' <span style="color: #d32f2f; font-weight: bold;">(BAN)</span>' : '';

            const cabinetLabel = [
                cabinet.profile ? `👤 ${cabinet.profile}` : '',
                cabinet.id ? `💼 ${cabinet.id}${banLabel}` : ''
            ].filter(Boolean).join(' • ');

            const isPaused = cabinetsPaused.has(cabinet.id);
            const toggleChecked = !isPaused ? 'checked' : '';

            window.cabinetEnableConsent = window.cabinetEnableConsent || {};
            const enableConsent = window.cabinetEnableConsent[cabinet.id] === true;
            const enableConsentChecked = enableConsent ? 'checked' : '';

            let html = `
                <div class="card" style="margin-bottom: 16px; border-left: 4px solid #4caf50;">
                    <div style="display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px;">
                        <div style="display: flex; align-items: flex-start; gap: 12px; cursor: pointer; flex: 1;" onclick="toggleCabinet('${bodyId}')">
                            <span style="font-size: 18px; margin-top: 2px;">${arrow}</span>
                            <div>
                                <div style="font-weight: 600; font-size: 16px; color: var(--text-primary);">
                                    📊 ${campaignName}
                                </div>
                                ${cabinetLabel ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${cabinetLabel}</div>` : ''}
                                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px;">
                                    <span style="background: ${campaignStatus === 'ACTIVE' ? '#4caf50' : '#ff9800'}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px;">
                                        ${campaignStatus === 'ACTIVE' ? '✅ ACTIVE' : '⏸️ ' + (campaignStatus || 'UNKNOWN')}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 20px; align-items: center;">
                            <div style="text-align: right;">
                                <div style="font-size: 12px; color: var(--text-secondary);">Spend</div>
                                <div style="font-size: 18px; font-weight: bold; color: #ff7043;">$${totalSpend.toFixed(2)}</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 12px; color: var(--text-secondary);">Ліди</div>
                                <div style="font-size: 18px; font-weight: bold; color: #42a5f5;">${totalLeads}</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 12px; color: var(--text-secondary);">CPL</div>
                                <div style="font-size: 18px; font-weight: bold; color: #66bb6a;">${campaignCpl}</div>
                            </div>
            <label title="Дозволити автоправилам ВКЛЮЧАТИ адсети цього кабінету. Без галки — лише вимкнення (по лімітам). Скидається на 00:00 за Києвом і при перезавантаженні." style="display:flex; align-items:center; gap:6px; margin-left:12px; padding:6px 10px; border:1px solid var(--border-color); border-radius:6px; background: var(--bg-primary); cursor:pointer; font-size:12px; font-weight:600; color: var(--text-primary); user-select:none;" onclick="event.stopPropagation();">
                                <input type="checkbox"
                                       id="cabEnableConsentTree_${cabinet.id}"
                                       ${enableConsentChecked}
                                       onchange="window.cabinetEnableConsent = window.cabinetEnableConsent || {}; window.cabinetEnableConsent['${cabinet.id}'] = this.checked; if (typeof window.handleCabinetEnableConsentToggle === 'function') { window.handleCabinetEnableConsentToggle('${cabinet.id}', this.checked); }"
                                       style="width:16px; height:16px; accent-color:#e94560; cursor:pointer; margin:0;">
                                <span>Довключення</span>
                            </label>
                            <div class="cabinet-pause-toggle-wrapper" style="margin-left: 12px; border-left: 1px solid #e0e0e0; padding-left: 12px;" onclick="event.stopPropagation();">
                                <span style="font-size: 12px; color: var(--text-secondary); font-weight: 500;">АФК:</span>
                                <label class="cabinet-pause-toggle">
                                    <input type="checkbox"
                                           id="pauseToggle_${cabinet.id}"
                                           ${toggleChecked}
                                           onchange="toggleCabinetPause('${cabinet.id}')">
                                    <span class="cabinet-pause-toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div id="${bodyId}" style="display: ${isOpen ? 'block' : 'none'}; padding: 0 12px 12px 12px; margin-left: 30px; border-left: 2px solid #e0e0e0;">
                        ${renderAdsets(campaign.adsets || [], uniqueKey, autoExpand)}
                    </div>
                </div>
            `;

            return html;
        }

        /**
         * Рендерить adsets
         */
        function renderAdsets(adsets, parentKey = '', autoExpand = false) {
            if (!adsets || adsets.length === 0) {
                return '<div style="padding: 8px; color: var(--text-secondary);">Немає adsets</div>';
            }

            let html = '';
            adsets.forEach((adset, idx) => {
                const adsetDomBase = `${parentKey}_adset_${sanitizeId(adset.id || `idx_${idx}`, idx)}`;
                const adsetBodyId = `${adsetDomBase}_body`;
                const isOpen = autoExpand || openCampaignIds.has(adsetBodyId);
                const arrow = isOpen ? '▼' : '▶';

                // ✅ Рахуємо реальний spend з ads
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

                // Перевіряємо чи можна toggle (заборонено для REJECTED/DISAPPROVED)
                const canToggle = !normalizedStatus.includes('REJECT') && !normalizedStatus.includes('DISAPPROV') && normalizedStatus !== 'DELETED';

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
         * Рендерить ads
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
                                <div style="font-size: 13px; color: #ff7043; font-weight: 600;">
                                    $${adSpend.toFixed(2)}
                                </div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 11px; color: var(--text-secondary);">Ліди</div>
                                <div style="font-size: 13px; color: #42a5f5; font-weight: 600;">
                                    ${adLeads}
                                </div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 11px; color: var(--text-secondary);">CPL</div>
                                <div style="font-size: 13px; color: #66bb6a; font-weight: 600;">
                                    ${adCpl}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            return html;
        }

        /**
         * Тогл кабінету
         */
        function toggleCabinet(cabinetId) {
            const element = document.getElementById(cabinetId);
            if (!element) return;

            if (openCabinetIds.has(cabinetId)) {
                openCabinetIds.delete(cabinetId);
                element.style.display = 'none';
            } else {
                openCabinetIds.add(cabinetId);
                element.style.display = 'block';
            }
        }

        /**
         * Тогл adset
         */
        function toggleAdset(adsetId) {
            const element = document.getElementById(adsetId);
            if (!element) return;

            if (openCampaignIds.has(adsetId)) {
                openCampaignIds.delete(adsetId);
                element.style.display = 'none';
            } else {
                openCampaignIds.add(adsetId);
                element.style.display = 'block';
            }
        }

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
        // КІНЕЦЬ НОВИХ ФУНКЦІЙ
        // ============================================================================

        function getStatusDisplay(status) {
            const mapping = {
                ok: {text: '✅ OK', rowClass: 'row-ok'},
                no_leads: {text: '⚠️ Немає лідів', rowClass: 'row-warning'},
                high_cpl: {text: '⚠️ Високий CPL', rowClass: 'row-error'},
                no_spend: {text: '○ Без витрат', rowClass: 'row-warning'},
                crm_only: {text: '📊 Тільки CRM', rowClass: 'row-warning'},
                blocked: {text: '🚫 Заблокований', rowClass: 'row-error'}
            };
            return mapping[status] || {text: status || '—', rowClass: 'row-warning'};
        }

        function formatCurrency(value) {
            const numeric = typeof value === 'number' ? value : parseFloat(value);
            if (Number.isFinite(numeric)) {
                return `$${numeric.toFixed(2)}`;
            }
            return '$0.00';
        }

        // 🔒 ФУНКЦІЇ ГЛОБАЛЬНОГО LOCK
        function acquireLock(operationName, silent = false) {
            if (isGlobalBusy) {
                if (!silent) {
                    alert(`⚠️ Операція вже виконується!\n\nПоточна операція: ${busyOperation}\n\nБудь ласка, дочекайтесь завершення або зупиніть поточну операцію.`);
                } else {
                    console.log(`⚠️ Lock зайнятий: ${busyOperation}, пропускаю ${operationName}`);
                }
                return false;
            }
            isGlobalBusy = true;
            busyOperation = operationName;
            updateGlobalStatusIndicator();
            console.log(`🔒 Lock захоплено: ${operationName}`);
            return true;
        }

        function releaseLock() {
            const prevOperation = busyOperation;
            isGlobalBusy = false;
            busyOperation = null;
            updateGlobalStatusIndicator();
            console.log(`🔓 Lock звільнено: ${prevOperation}`);
        }

        function updateGlobalStatusIndicator() {
            let statusDiv = document.getElementById('globalStatusIndicator');
            if (!statusDiv) {
                // Створюємо індикатор якщо його немає
                statusDiv = document.createElement('div');
                statusDiv.id = 'globalStatusIndicator';
                statusDiv.style.cssText = `
                    position: fixed;
                    top: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
                    z-index: 10001;
                    font-size: 14px;
                    font-weight: 500;
                    display: none;
                    animation: slideDown 0.3s ease-out;
                `;
                document.body.appendChild(statusDiv);

                // Додаємо CSS анімацію
                if (!document.getElementById('globalStatusStyles')) {
                    const style = document.createElement('style');
                    style.id = 'globalStatusStyles';
                    style.innerHTML = `
                        @keyframes slideDown {
                            from { transform: translateX(-50%) translateY(-30px); opacity: 0; }
                            to { transform: translateX(-50%) translateY(0); opacity: 1; }
                        }
                    `;
                    document.head.appendChild(style);
                }
            }

            if (isGlobalBusy) {
                let icon = '⏳';
                if (busyOperation && busyOperation.includes('AFK')) {
                    icon = '🔄';
                } else if (busyOperation && busyOperation.includes('CRM')) {
                    icon = '📊';
                } else if (busyOperation && busyOperation.includes('Збір')) {
                    icon = '📥';
                }
                statusDiv.textContent = `${icon} ${busyOperation || 'Виконується операція...'}`;
                statusDiv.style.display = 'block';
            } else {
                statusDiv.style.display = 'none';
            }
        }

        function formatCabinetCell(row) {
            const profile = row.profile_name || row.fbtool_account_name || row.profile || '—';
            const actId = row.account_id || row.adaccount_id || '';
            const status = row.adaccount_status;
            let statusText = '';
            if (status !== undefined && status !== null) {
                statusText = status == 1 ? '<span style="color:#4CAF50;">✓ Активний</span>' : '<span style="color:#f44336;">🚫 Заблокований</span>';
            }

            let html = `<strong>${profile}</strong>`;
            html += `<br><small style="color: var(--text-secondary);">${actId || '—'}</small>`;

            if (statusText) {
                html += `<br>${statusText}`;
            }

            return html;
        }

        function formatAdsetsCell(row) {
            const adsets = row.adsets || [];
            if (!adsets.length) {
                return '<span style="color: var(--text-secondary);">—</span>';
            }
            const items = adsets.map(item => {
                const name = item.name || item.id || '—';
                const status = item.status || item.ad_status || '—';
                return `<div style="margin-bottom:4px;"><strong>${name}</strong><br><small style="color: var(--text-secondary);">${status}</small></div>`;
            });
            return items.join('');
        }

        function sanitizeId(value, fallback = '') {
            if (!value) return `id_${fallback}`;
            return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
        }

        function groupRowsByCabinet(rows) {
            const map = {};
            rows.forEach((row, index) => {
                const cabinetId = row.account_id || row.adaccount_id || `cabinet_${index}`;
                const domId = `cabinet_${sanitizeId(cabinetId, index)}`;
                if (!map[domId]) {
                    map[domId] = {
                        id: cabinetId,
                        domId,
                        profile: row.profile_name || row.fbtool_account_name || row.profile || '—',
                        status: row.adaccount_status,
                        spend: 0,
                        leads: 0,
                        campaigns: []
                    };
                }

                const spendValue = Number(row.spend) || 0;
                const leadsValue = Number(row.leads) || 0;
                map[domId].spend += spendValue;
                map[domId].leads += leadsValue;

                const campaignDomId = `${domId}_camp_${sanitizeId(row.campaign_id || row.campaign_name || `camp_${index}`, index)}`;
                map[domId].campaigns.push({
                    id: row.campaign_id || campaignDomId,
                    domId: campaignDomId,
                    name: row.campaign_name || '—',
                    status: row.campaign_status,
                    spend: spendValue,
                    leads: leadsValue,
                    cpl: Number.isFinite(row.cpl) ? row.cpl : null,
                    account_id: row.account_id || row.adaccount_id || '',
                    fbtool_account_id: row.fbtool_account_id || row.fbtoolAccountId || '',
                    adsets: buildAdsetsForRow(row)
                });
            });

            return Object.values(map).map(cab => {
                cab.cpl = cab.leads > 0 ? (cab.spend / cab.leads) : null;
                return cab;
            });
        }

        function buildAdsetsForRow(row) {
            const fallbackAccountId = row.account_id || row.adaccount_id || '';
            const fallbackFbtoolId = row.fbtool_account_id || row.fbtoolAccountId || '';

            if (Array.isArray(row.adsets) && row.adsets.length > 0) {
                // З бекенду приходить структура: adsets[{id, name, spend, ads: [{...}]}]
                return row.adsets.map((adset, idx) => {
                    const adsetId = adset.id || adset.adset_id || adset.adsetId;
                    const adsetName = adset.name || adsetId || `Adset #${idx + 1}`;
                    const accountId = adset.account_id || fallbackAccountId;
                    const fbtoolId = adset.fbtool_account_id || fallbackFbtoolId;
                    const spendValue = Number(adset.spend) || 0;
                    const leadsValue = Number(adset.leads) || 0;
                    const cplValue = (leadsValue > 0) ? (spendValue / leadsValue) : null;

                    // Вкладені ads (якщо є)
                    const adsArray = Array.isArray(adset.ads) ? adset.ads : [];
                    const hasRejected = !!adset.has_rejected_ads;

                    // DEBUG: Логуємо якщо є rejected ads
                    if (hasRejected) {
                        console.log(`🚫 DEBUG Frontend: Adset ${adsetName} має rejected ads, status=${adset.status}, ad_status=${adset.ad_status}`);
                    }

                    return {
                        id: adsetId || `adset_${idx + 1}`,
                        name: adsetName,
                        status: adset.status || adset.ad_status,
                        spend: spendValue,
                        leads: leadsValue,
                        cpl: cplValue,
                        impressions: Number(adset.impressions) || 0,
                        clicks: Number(adset.clicks) || 0,
                        has_rejected_ads: hasRejected,
                        account_id: accountId,
                        fbtool_account_id: fbtoolId,
                        ads: adsArray  // ← Зберігаємо вкладені ads
                    };
                });
            }

            return [{
                id: null,
                name: row.campaign_name || '—',
                status: row.campaign_status,
                spend: row.spend,
                leads: row.leads,
                cpl: row.cpl,
                has_rejected_ads: false,
                account_id: fallbackAccountId,
                fbtool_account_id: fallbackFbtoolId,
                ads: []  // ← Немає вкладених ads
            }];
        }

        function renderCabinetCards(rows) {
            const container = document.getElementById('resultsTable');
            if (!container) return;
            syncResultsSortSelect();
            const autoExpand = currentResultsTab === 'all';

            if (!rows || rows.length === 0) {
                container.innerHTML = `<div class="hierarchy-placeholder">Очікуємо перші результати...</div>`;
                return;
            }

            const filteredRows = (rows || []).filter(row => {
                const hasCabinet = row.account_id || row.adaccount_id;
                const notCrmOnly = String(row.status || '').toLowerCase() !== 'crm_only';
                return hasCabinet && notCrmOnly;
            });
            if (!filteredRows.length) {
                container.innerHTML = `<div class="hierarchy-placeholder">Немає даних для відображення</div>`;
                return;
            }

            const grouped = groupCampaignsByCabinet(filteredRows, {onlyActive: false});
            if (!grouped.length) {
                container.innerHTML = `<div class="hierarchy-placeholder">Немає кабінетів для відображення</div>`;
                return;
            }

            const sortedCabinets = applySortToHierarchy(grouped);
            let html = '';
            sortedCabinets.forEach(cabinet => {
                const campaigns = cabinet.campaigns.length ? cabinet.campaigns : [{
                    campaign_name: 'Немає даних',
                    campaign_status: 'NO_SPEND',
                    spend: cabinet.spend || 0,
                    leads: cabinet.leads || 0,
                    cpl: cabinet.cpl,
                    adsets: []
                }];

                campaigns.forEach((campaign, index) => {
                    html += renderCabinetWithCampaign(cabinet, campaign, index, autoExpand);
                });
            });

            container.innerHTML = html || `<div class="hierarchy-placeholder">Немає даних для відображення</div>`;
        }

        function renderAllCabinetsSection() {
            const container = document.getElementById('resultsTable');
            if (!container) return;
            const requested = Array.isArray(lastRequestedCabinets) ? lastRequestedCabinets : [];
            if (!requested.length) {
                container.innerHTML = `<div class="hierarchy-placeholder">Спочатку обери кабінети та запусти збір даних.</div>`;
                return;
            }
            const rows = getAllCabinetRowsForView();
            renderCabinetCards(rows);
        }

        function getAllCabinetRowsForView() {
            const baseRows = Array.isArray(window.currentMatchedRows)
                ? window.currentMatchedRows.filter(row => String(row.status || '').toLowerCase() !== 'crm_only')
                : [];
            const rows = [...baseRows];
            const requested = Array.isArray(lastRequestedCabinets) ? lastRequestedCabinets : [];
            const known = new Set(
                rows
                    .map(row => getRowCabinetId(row))
                    .filter(Boolean)
            );
            requested.forEach(id => {
                const normalized = normalizeCabinetId(id);
                if (!normalized || known.has(normalized)) {
                    return;
                }
                rows.push(buildPlaceholderRow(normalized));
                known.add(normalized);
            });
            return rows;
        }

        function buildPlaceholderRow(cabinetId) {
            const meta = findAdaccountMeta(cabinetId) || {};
            const profileName = meta.fbtool_account_name || meta.profile || meta.account_name || meta.name || '';
            return {
                account_id: cabinetId,
                adaccount_id: cabinetId,
                account_name: meta.name || meta.account_name || cabinetId,
                profile_name: profileName,
                fbtool_account_id: meta.fbtool_account_id || meta.fbtoolAccountId || '',
                adaccount_status: meta.account_status,
                campaign_id: `${cabinetId}_placeholder`,
                campaign_name: 'Немає даних за обрану дату',
                campaign_status: 'NO_SPEND',
                spend: 0,
                impressions: 0,
                clicks: 0,
                leads: 0,
                cpl: null,
                status: 'no_spend',
                adsets: []
            };
        }

        function findAdaccountMeta(cabinetId) {
            if (!cabinetId || !Array.isArray(adaccounts)) return null;
            const normalized = normalizeCabinetId(cabinetId);
            return adaccounts.find(acc => acc.id === normalized) || null;
        }

        function trackRequestedCabinet(cabinetId) {
            const normalized = normalizeCabinetId(cabinetId);
            if (!normalized) return;
            if (!Array.isArray(lastRequestedCabinets)) {
                lastRequestedCabinets = [];
            }
            if (!lastRequestedCabinets.includes(normalized)) {
                lastRequestedCabinets.push(normalized);
            }
        }

        function setLastRequestedCabinets(cabinetIds) {
            if (!Array.isArray(cabinetIds)) {
                lastRequestedCabinets = [];
                return;
            }
            lastRequestedCabinets = cabinetIds
                .map(normalizeCabinetId)
                .filter(Boolean);
        }

        function splitCabinetsByActivity(cabinets) {
            const activeCabinets = [];
            const inactiveCabinets = [];
            cabinets.forEach(cabinet => {
                if (cabinetHasActiveAdsets(cabinet)) {
                    activeCabinets.push(cabinet);
                } else {
                    inactiveCabinets.push(cabinet);
                }
            });
            return {activeCabinets, inactiveCabinets};
        }

        function cabinetHasActiveAdsets(cabinet) {
            return cabinet.campaigns.some(campaign => (campaign.adsets || []).some(isAdsetActive));
        }

        function isAdsetActive(adset) {
            const status = String(adset.status || adset.ad_status || '').toUpperCase();
            return status.includes('ACTIVE');
        }
        function renderCabinetHTML(cabinet) {
            const bodyId = `${cabinet.domId}_body`;
            const isOpen = openCabinetIds.has(bodyId);
            const arrow = isOpen ? '▼' : '▶';
            const campaignsHTML = cabinet.campaigns.map((campaign, idx) => renderCampaignHTML(bodyId, campaign, idx)).join('');
            const isChecked = cabinetsToUpdate.size === 0 || cabinetsToUpdate.has(cabinet.id);
            return `
                <div class="cabinet-card" data-cabinet-id="${cabinet.id}" id="${cabinet.domId}_card">
                    <div class="cabinet-header">
                        <div class="cabinet-info">
                            <input type="checkbox"
                                   class="cabinet-checkbox"
                                   data-cabinet-id="${cabinet.id}"
                                   data-status="active"
                                   ${isChecked ? 'checked' : ''}
                                   onchange="toggleCabinetForUpdate('${cabinet.id}')"
                                   style="margin-right: 8px; width: 18px; height: 18px; cursor: pointer;">
                            <span class="hierarchy-toggle" data-toggle-id="${bodyId}" data-toggle-type="cabinet">${arrow}</span>
                            <div>
                                <strong style="font-size: 16px;">📊 ${cabinet.profile}</strong> • <span style="font-size: 12px; color: var(--text-secondary);">${cabinet.id}${cabinet.status != 1 && cabinet.status !== null ? ' <span style="color: #d32f2f; font-weight: bold;">(BAN)</span>' : ''}</span>
                            </div>
                            <button class="cabinet-refresh-btn"
                                    data-refresh-cabinet="${cabinet.id}"
                                    onclick="refreshSingleCabinet('${cabinet.id}')">
                                ⟳ Оновити
                            </button>
                            <div class="cabinet-pause-toggle-wrapper" style="margin-left: 12px; border-left: 1px solid #e0e0e0; padding-left: 12px;">
                                <span style="font-size: 12px; color: var(--text-secondary); font-weight: 500;">АФК режим:</span>
                                <label class="cabinet-pause-toggle">
                                    <input type="checkbox"
                                           id="pauseToggle_${cabinet.id}"
                                           ${!cabinetsPaused.has(cabinet.id) ? 'checked' : ''}
                                           onchange="toggleCabinetPause('${cabinet.id}')">
                                    <span class="cabinet-pause-toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                        <div class="cabinet-total">
                            💰 ${formatCurrency(cabinet.spend || 0)}
                            <br><small>👥 Ліди: ${cabinet.leads || 0}</small>
                        </div>
                    </div>
                    <div class="cabinet-campaigns ${isOpen ? 'open' : ''}" id="${bodyId}">
                        ${campaignsHTML || '<div class="hierarchy-placeholder" style="padding:10px 0;">Немає кампаній</div>'}
                    </div>
                </div>
            `;
        }

        function renderCampaignHTML(cabinetBodyId, campaign, index) {
            const adsets = Array.isArray(campaign.adsets) ? campaign.adsets : [];
            const hasToggle = adsets.length > 1;
            const toggleId = `${campaign.domId}_${index}`;
            const isOpen = hasToggle && openCampaignIds.has(toggleId);
            const arrow = hasToggle ? (isOpen ? '▼' : '▶') : '';
            const inlineAd = (!hasToggle && adsets.length === 1)
                ? renderInlineAdset(adsets[0], campaign)
                : '';
            const adListHTML = hasToggle
                ? `<div class="campaign-ad-list ${isOpen ? 'open' : ''}" id="${toggleId}">
                        ${adsets.map(adset => renderAdsetRow(adset, campaign)).join('')}
                   </div>`
                : '';
            const spend = Number(campaign.spend) || 0;
            const leads = Number(campaign.leads) || 0;
            const cplText = Number.isFinite(campaign.cpl) ? formatCurrency(campaign.cpl) : '—';

            return `
                <div class="campaign-row">
                    <div class="campaign-info">
                        <div class="campaign-top">
                            ${hasToggle ? `<span class="hierarchy-toggle" data-toggle-id="${toggleId}" data-toggle-type="campaign">${arrow}</span>` : '<span style="display:inline-block;width:18px;"></span>'}
                            <div>
                                <strong>📁 Campaign: ${campaign.name}</strong>
                                ${formatStatusTag(campaign.status)}
                            </div>
                        </div>
                        ${inlineAd}
                    </div>
                    <div class="campaign-metrics">
                        <div>💰 ${formatCurrency(spend)}</div>
                        <div>👥 Ліди: ${leads}</div>
                        <div>🎯 CPL: ${cplText}</div>
                    </div>
                </div>
                ${adListHTML}
            `;
        }

        function renderInlineAdset(adset, campaign) {
            // Показуємо попередження ТІЛЬКИ якщо адсет має заблоковані оголошення
            const warning = adset.has_rejected_ads
                ? `<div class="adset-warning">⚠️ ЗАБАНЕНО - оголошення відхилені модерацією</div>`
                : '';
            const adsHtml = renderAdsList(adset.ads || []);
            // ВАЖЛИВО: Використовуємо account_id з adset (fallback на campaign якщо немає)
            const accountId = adset.account_id || campaign.account_id;
            const fbtoolId = adset.fbtool_account_id || campaign.fbtool_account_id;
            return `
                <div class="campaign-inline-ad">
                    <div>📦 Ad set: ${adset.name} ${formatStatusTag(adset.status)}</div>
                    ${warning}
                    ${renderAdsetActions(adset, accountId, fbtoolId)}
                    ${adsHtml}
                </div>
            `;
        }

        function renderAdsetRow(adset, campaign) {
            const spend = Number(adset.spend);
            const leads = Number(adset.leads);
            const cpl = adset.cpl;
            // ВАЖЛИВО: Використовуємо account_id з adset (fallback на campaign якщо немає)
            const accountId = adset.account_id || campaign.account_id;
            const fbtoolId = adset.fbtool_account_id || campaign.fbtool_account_id;
            const actions = renderAdsetActions(adset, accountId, fbtoolId);
            const label = adset.name || adset.id || '—';
            // Показуємо попередження ТІЛЬКИ якщо адсет має заблоковані оголошення
            const warning = adset.has_rejected_ads
                ? `<div class="adset-warning">⚠️ ЗАБАНЕНО - оголошення відхилені модерацією</div>`
                : '';

            // Рендеримо список ads (якщо є)
            const adsHtml = renderAdsList(adset.ads || []);

            return `
                <div class="row">
                    <div>
                        <strong>📦 Ad set: ${label}</strong>
                        ${formatStatusTag(adset.status || adset.ad_status)}
                        ${warning}
                    </div>
                    <div style="text-align:right;">
                        ${Number.isFinite(spend) ? formatCurrency(spend) : ''}
                        ${Number.isFinite(leads) ? `<span style="margin-left:10px;">Ліди: ${leads}</span>` : ''}
                        ${Number.isFinite(cpl) ? `<span style="margin-left:10px;">CPL: ${formatCurrency(cpl)}</span>` : ''}
                        ${actions}
                    </div>
                </div>
                ${adsHtml}
            `;
        }

        function renderAdsList(ads) {
            if (!ads || ads.length === 0) {
                return '';
            }

            const adsItems = ads.map(ad => {
                const adStatus = formatStatusTag(ad.status);
                return `
                    <div style="padding: 8px 0 8px 40px; border-left: 2px solid #e0e0e0; margin-left: 20px; color: var(--text-secondary);">
                        📄 Ad: <strong>${ad.name || ad.id || '—'}</strong>
                        ${adStatus}
                    </div>
                `;
            }).join('');

            return `
                <div style="padding-left: 20px; margin-top: 8px;">
                    ${adsItems}
                </div>
            `;
        }

        function renderAdsetActions(adset, accountId, fbtoolAccountId) {
            const adsetId = adset.id || adset.adset_id || adset.adsetId;
            if (!adsetId || !accountId) {
                return '<div class="adset-actions-disabled">ID адсету недоступний</div>';
            }

            const normalized = String(adset.status || '').toUpperCase();
            const isActive = normalized.includes('ACTIVE');
            const safeAccountId = String(accountId);
            const safeFbtoolId = fbtoolAccountId ? String(fbtoolAccountId) : '';

            return `
                <div class="adset-actions">
                    <button
                        class="adset-action-btn ${isActive ? 'selected' : ''}"
                        data-adset-id="${adsetId}"
                        data-account-id="${safeAccountId}"
                        data-fbtool-id="${safeFbtoolId}"
                        data-target-status="ACTIVE"
                        title="Увімкнути адсет"
                        onclick="handleAdsetToggle(event)"
                    >Увімкнути</button>
                    <button
                        class="adset-action-btn ${!isActive ? 'selected' : ''}"
                        data-adset-id="${adsetId}"
                        data-account-id="${safeAccountId}"
                        data-fbtool-id="${safeFbtoolId}"
                        data-target-status="PAUSED"
                        title="Вимкнути адсет"
                        onclick="handleAdsetToggle(event)"
                    >Вимкнути</button>
                </div>
            `;
        }

        function changeResultsSort(value) {
            currentSortOption = value || 'default';
            syncResultsSortSelect();
            if (currentResultsTab === 'all') {
                renderAllCabinetsSection();
            } else if (currentResultsTab === 'active') {
                const source = Array.isArray(window.currentMatchedRows) && window.currentMatchedRows.length
                    ? window.currentMatchedRows
                    : (Array.isArray(window.lastResults) ? window.lastResults : []);
                renderActiveCampaignsTree(source);
            }
        }

        function syncResultsSortSelect() {
            const select = document.getElementById('resultsSortSelect');
            if (select && select.value !== currentSortOption) {
                select.value = currentSortOption;
            }
        }

        function applySortToHierarchy(cabinets) {
            if (!Array.isArray(cabinets)) return [];

            // 🎯 РОЗДІЛЯЄМО на активні та на паузі (AFK)
            const activeCabinets = [];
            const pausedCabinets = [];

            cabinets.forEach(cabinet => {
                const cabinetId = normalizeCabinetId(cabinet.id);
                if (cabinetsPaused.has(cabinetId)) {
                    pausedCabinets.push(cabinet);
                } else {
                    activeCabinets.push(cabinet);
                }
            });

            // Сортуємо кожну групу ОКРЕМО
            if (currentSortOption !== 'default') {
                const cabinetComparator = buildHierarchyComparator(currentSortOption);
                activeCabinets.sort(cabinetComparator);
                pausedCabinets.sort(cabinetComparator);
            }

            // Сортуємо кампанії всередині кабінетів
            activeCabinets.forEach(cabinet => {
                sortCampaigns(cabinet.campaigns);
            });
            pausedCabinets.forEach(cabinet => {
                sortCampaigns(cabinet.campaigns);
            });

            // ✅ Активні зверху, на паузі внизу
            return [...activeCabinets, ...pausedCabinets];
        }

        function sortCampaigns(campaigns) {
            if (!Array.isArray(campaigns) || currentSortOption === 'default') return;
            const comparator = buildHierarchyComparator(currentSortOption);
            campaigns.sort(comparator);
        }

        function buildHierarchyComparator(option) {
            switch (option) {
                case 'spend_desc':
                    return (a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0);
                case 'spend_asc':
                    return (a, b) => (Number(a.spend) || 0) - (Number(b.spend) || 0);
                case 'leads_desc':
                    return (a, b) => (Number(b.leads) || 0) - (Number(a.leads) || 0);
                case 'leads_asc':
                    return (a, b) => (Number(a.leads) || 0) - (Number(b.leads) || 0);
                case 'cpl':
                case 'cpl_asc':
                    return (a, b) => {
                        const aCpl = Number(a.cpl);
                        const bCpl = Number(b.cpl);
                        if (!Number.isFinite(aCpl) && !Number.isFinite(bCpl)) return 0;
                        if (!Number.isFinite(aCpl)) return 1;
                        if (!Number.isFinite(bCpl)) return -1;
                        return aCpl - bCpl;
                    };
                case 'cpl_desc':
                    return (a, b) => {
                        const aCpl = Number(a.cpl);
                        const bCpl = Number(b.cpl);
                        if (!Number.isFinite(aCpl) && !Number.isFinite(bCpl)) return 0;
                        if (!Number.isFinite(aCpl)) return 1;
                        if (!Number.isFinite(bCpl)) return -1;
                        return bCpl - aCpl; // Зворотний порядок
                    };
                case 'status':
                    return (a, b) => {
                        const order = {ACTIVE: 0, 'IN PROCESS': 1, PAUSED: 2, NO_SPEND: 3, default: 4};
                        const aStatus = String((a.campaigns?.[0]?.campaign_status) || a.status || '').toUpperCase();
                        const bStatus = String((b.campaigns?.[0]?.campaign_status) || b.status || '').toUpperCase();
                        const aValue = order[aStatus] ?? order.default;
                        const bValue = order[bStatus] ?? order.default;
                        if (aValue === bValue) return 0;
                        return aValue - bValue;
                    };
                case 'profile':
                    return (a, b) => {
                        const profileA = (a.profile || '').toLowerCase();
                        const profileB = (b.profile || '').toLowerCase();
                        if (profileA === profileB) {
                            const nameA = (a.name || '').toLowerCase();
                            const nameB = (b.name || '').toLowerCase();
                            return nameA.localeCompare(nameB);
                        }
                        return profileA.localeCompare(profileB);
                    };
                default:
                    return () => 0;
            }
        }

        function rerenderActiveView() {
            if (typeof renderActiveCampaignsTree !== 'function') {
                return;
            }
            try {
                const data = Array.isArray(window.currentMatchedRows) ? window.currentMatchedRows : [];
                renderActiveCampaignsTree(data);
            } catch (err) {
                console.warn('Не вдалося оновити дерево активних кампаній:', err);
            }
        }

        function mergeCabinetRows(adaccountId, newRows) {
            if (!Array.isArray(window.lastResults)) {
                window.lastResults = [];
            }
            const normalizedId = normalizeCabinetId(adaccountId || '');
            const preparedRows = (newRows || []).map(row => ensureRowHasNormalizedId({...row}));

            // ✅ ЗАХИСТ: Якщо нові дані порожні - не затираємо існуючі!
            const oldRowsForCabinet = window.lastResults.filter(row => getRowCabinetId(row) === normalizedId);
            if (preparedRows.length === 0 && oldRowsForCabinet.length > 0) {
                console.warn(`⚠️ mergeCabinetRows: нові дані для ${normalizedId} порожні, зберігаю ${oldRowsForCabinet.length} існуючих записів`);
                return; // Не змінюємо дані
            }

            // ✅ РОЗУМНИЙ MERGE: оновлюємо існуючі кампанії, додаємо нові, зберігаємо зниклі
            const newCampaignIds = new Set(preparedRows.map(r => r.campaign_id).filter(Boolean));
            const oldRowsOtherCabinets = window.lastResults.filter(row => getRowCabinetId(row) !== normalizedId);

            // Кампанії цього кабінету, яких НЕМАЄ в нових даних - зберігаємо їх (могли тимчасово зникнути)
            const preservedRows = oldRowsForCabinet.filter(oldRow => {
                const oldCampaignId = oldRow.campaign_id;
                // Якщо кампанія є в нових даних - не зберігаємо стару (буде оновлена)
                if (oldCampaignId && newCampaignIds.has(oldCampaignId)) {
                    return false;
                }
                // Якщо кампанії НЕМАЄ в нових даних і вона мала adsets - зберігаємо!
                const hasAdsets = oldRow.adsets && Array.isArray(oldRow.adsets) && oldRow.adsets.length > 0;
                if (hasAdsets) {
                    console.log(`📌 mergeCabinetRows: зберігаю кампанію "${oldRow.campaign_name}" (${oldCampaignId}) - має adsets, але відсутня в нових даних`);
                    return true;
                }
                return false;
            });

            if (preservedRows.length > 0) {
                console.log(`📌 mergeCabinetRows: збережено ${preservedRows.length} кампаній що тимчасово зникли`);
            }

            window.lastResults = dedupeCampaignRows([...oldRowsOtherCabinets, ...preparedRows, ...preservedRows]);
            window.lastResults = dedupeCampaignRows(window.lastResults);
            window.currentMatchedRows = [...window.lastResults];
            window.currentCrmOnlyRows = window.lastResults.filter(row => row.status === 'crm_only');
            renderAllCabinetsSection();
            rerenderActiveView();
            detectInactiveCabinets();
        }

        /**
         * Зливає нові дані з існуючими
         * Оновлює тільки кабінети які є в newData, інші залишає без змін
         */
        function mergeResultsData(newData, newStats, newSettings) {
            if (!Array.isArray(window.lastResults)) {
                window.lastResults = [];
            }

            // ✅ ЗАХИСТ: Якщо newData порожній або undefined - залишаємо старі дані
            if (!newData || newData.length === 0) {
                console.warn('⚠️ Merge: newData порожній або undefined, залишаю існуючі дані');
                console.warn(`   Поточних рядків: ${window.lastResults.length}`);
                // Просто перемальовуємо існуючі дані
                renderResults(window.lastResults, newStats, newSettings, true);
                return;
            }

            const preparedNewData = newData.map(row => ensureRowHasNormalizedId({...row}));

            const updatedCabinets = new Set();
            preparedNewData.forEach(row => {
                const cabId = getRowCabinetId(row);
                if (cabId) updatedCabinets.add(cabId);
            });

            console.log(`🔄 Merge: оновлюємо ${updatedCabinets.size} кабінетів, залишаємо інші`);

            // Видаляємо старі дані цих кабінетів
            const oldDataFromOtherCabinets = window.lastResults.filter(row => !updatedCabinets.has(getRowCabinetId(row)));

            console.log(`   Старих рядків (інші кабінети): ${oldDataFromOtherCabinets.length}`);
            console.log(`   Нових рядків (оновлені кабінети): ${newData.length}`);

            // Зливаємо: старі дані інших кабінетів + нові дані оновлених кабінетів, з дедуплікацією кампаній
            window.lastResults = dedupeCampaignRows([...oldDataFromOtherCabinets, ...preparedNewData]);
            window.currentMatchedRows = [...window.lastResults];

            // Перераховуємо crm_only
            window.currentCrmOnlyRows = window.lastResults.filter(row => row.status === 'crm_only');

            console.log(`   ✅ Всього рядків після merge: ${window.lastResults.length}`);

            // Відображаємо
            renderResults(window.lastResults, newStats, newSettings, true);
            rerenderActiveView();
        }

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

        async function refreshSingleCabinet(adaccountId) {
            if (!adaccountId) return;
            const dateInput = document.getElementById('dateInput');
            const date = dateInput && dateInput.value ? dateInput.value : (() => {
                const d = new Date();
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();
            const button = document.querySelector(`[data-refresh-cabinet="${adaccountId}"]`);
            const originalText = button ? button.textContent : '';

            try {
                if (button) {
                    button.disabled = true;
                    button.textContent = '⟳...';
                }

                await refreshCabinetData(adaccountId, date);
            } catch (error) {
                console.error(error);
                showError(error.message || 'Помилка оновлення кабінету');
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = originalText || '⟳ Оновити';
                }
            }
        }

        async function refreshCabinetData(adaccountId, date, options = {}) {
            const {quiet = false, skipCrm = false} = options;

            // ✅ ОПТИМІЗАЦІЯ: Видалено дублювання /api/refresh-cabinet
            // collectCabinetDelta вже викликає /api/collect який робить ту саму роботу

            // CRM refresh (якщо потрібно)
            if (!skipCrm) {
                await refreshCrmCacheSilently();
            }

            // Collect - робить всю роботу: оновлення даних + notification
            await collectCabinetDelta(adaccountId, date, {quiet});

            return {success: true};
        }

        async function refreshProblemCabinets() {
            if (!inactiveCabinetsData.length) {
                alert('Немає проблемних кабінетів для оновлення.');
                return;
            }

            // 🔒 Перевірка глобального lock
            if (!acquireLock('Оновлення проблемних кабінетів')) {
                return;
            }

            const confirmMsg = `⟳ Оновити ${inactiveCabinetsData.length} проблемних кабінетів?\n\nБудуть послідовно оновлені CRM + FB дані для кожного кабінету з цього списку.`;
            const confirmed = confirm(confirmMsg);
            if (!confirmed) {
                releaseLock();
                return;
            }

            showLoading('Оновлення проблемних кабінетів...');

            try {
                await refreshCrmCacheSilently();
                const dateInput = document.getElementById('dateInput');
                const date = dateInput && dateInput.value ? dateInput.value : (() => {
                const d = new Date();
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            })();

                // 🚀 ПАРАЛЕЛЬНА ОБРОБКА: оновлюємо всі проблемні кабінети одночасно
                console.log(`🚀 Паралельне оновлення ${inactiveCabinetsData.length} проблемних кабінетів...`);

                const refreshPromises = inactiveCabinetsData
                    .filter(cabinet => cabinet.id)
                    .map(cabinet => {
                        return refreshCabinetData(cabinet.id, date, {quiet: true, skipCrm: true})
                            .then(() => ({success: true, id: cabinet.id}))
                            .catch(error => {
                                console.warn(`Не вдалося оновити ${cabinet.id}:`, error);
                                return {success: false, id: cabinet.id, error};
                            });
                    });

                const results = await Promise.allSettled(refreshPromises);

                // Підраховуємо успішні оновлення
                const successCount = results.filter(r =>
                    r.status === 'fulfilled' && r.value.success
                ).length;

                showNotification(`✅ Оновлено ${successCount}/${inactiveCabinetsData.length} проблемних кабінетів`);
            } catch (error) {
                console.error(error);
                showError('Помилка оновлення проблемних кабінетів: ' + error.message);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
                hideLoading();
            }
        }

        async function collectCabinetDelta(adaccountId, date, options = {}) {
            const quiet = !!options.quiet;
            const maxCpl = parseFloat(document.getElementById('maxCplInput').value) || null;
            const onlySpend = document.getElementById('onlySpendCheckbox').checked;
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
            trackRequestedCabinet(normalizedTarget);
            const cabinetRows = newRows
                .map(row => ensureRowHasNormalizedId({...row}))
                .filter(row => getRowCabinetId(row) === normalizedTarget);

            if (cabinetRows.length) {
                mergeCabinetRows(adaccountId, cabinetRows);

                const aggregatedStats = recomputeStatsFromRows(window.lastResults);
                updateStats(aggregatedStats);
                renderAllCabinetsSection();
                detectInactiveCabinets();
            } else if (!quiet) {
                showNotification(`Дані для ${adaccountId} оновлено, але кампаній з витратами не знайдено за ${date}`);
            } else {
                console.log(`Auto-refresh: немає кампаній зі спендом для ${adaccountId}`);
            }
        }

        async function refreshCrmCacheSilently() {
            try {
                const response = await fetch('/api/refresh-crm', {method: 'POST'});
                const data = await response.json();
                if (!data.success) {
                    console.warn('CRM refresh warning:', data.error);
                } else {
                    console.log('CRM cache оновлено:', data.timestamp);

                    // ✅ Застосовуємо нові ліди до існуючих даних в UI
                    await applyCrmLeadsToUI();
                }
            } catch (error) {
                console.warn('Помилка тихого оновлення CRM:', error);
            }
        }

        // ✅ Функція для застосування CRM лідів до поточних даних в UI
        // Використовує backend endpoint /api/rematch-crm з правильною логікою матчингу
        async function applyCrmLeadsToUI() {
            try {
                // Перевіряємо чи є дані для оновлення
                if (!window.lastResults || !Array.isArray(window.lastResults) || window.lastResults.length === 0) {
                    console.log('⚠️ Немає даних в window.lastResults для оновлення');
                    return;
                }

                console.log(`🔄 Відправляю ${window.lastResults.length} кампаній на rematch...`);

                // Викликаємо backend для перематчингу лідів
                const response = await fetch('/api/rematch-crm', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({campaigns: window.lastResults})
                });

                const result = await response.json();

                if (!result.success) {
                    console.warn('⚠️ Rematch CRM warning:', result.error || result.message);
                    return;
                }

                // Оновлюємо window.lastResults з новими даними
                if (result.data && Array.isArray(result.data)) {
                    window.lastResults = dedupeCampaignRows(result.data);
                    window.currentMatchedRows = [...result.data];

                    console.log(`✅ CRM rematch завершено: оновлено ${result.updated_count || 0} кампаній, matched ${result.matched_crm_count || 0} CRM записів`);

                    // Перерендерюємо UI
                    renderAllCabinetsSection();
                    const stats = recomputeStatsFromRows(window.lastResults);
                    updateStats(stats);
                }

            } catch (error) {
                console.error('❌ Помилка застосування CRM лідів:', error);
            }
        }

        function switchResultsTab(tab) {
            if (currentResultsTab === tab) return;
            currentResultsTab = tab;
            const statsSection = document.getElementById('statsTabSection');
            const allSection = document.getElementById('allCabinetsSection');
            const autoV2Section = document.getElementById('autoRulesV2Section');
            const activeBtn = document.getElementById('resultsTabActive');
            const allBtn = document.getElementById('resultsTabAll');
            const autoV2Btn = document.getElementById('resultsTabAutoV2');
            const sortBar = document.getElementById('resultsSortBar');

            // Ховаємо всі секції
            if (statsSection) statsSection.style.display = tab === 'active' ? 'block' : 'none';
            if (allSection) allSection.style.display = tab === 'all' ? 'block' : 'none';
            if (autoV2Section) autoV2Section.style.display = tab === 'autoV2' ? 'flex' : 'none';

            // Оновлюємо активні кнопки
            if (activeBtn) activeBtn.classList.toggle('active', tab === 'active');
            if (allBtn) allBtn.classList.toggle('active', tab === 'all');
            if (autoV2Btn) autoV2Btn.classList.toggle('active', tab === 'autoV2');

            // Сортування тільки для автоправил
            if (sortBar) sortBar.style.display = tab === 'autoV2' ? 'none' : 'block';

            // Завантаження даних для відповідних вкладок
            if (tab === 'autoV2') {
                // Завантажуємо налаштування автоправил і оновлюємо UI
                loadAutoRulesV2Settings();
            }
            if (tab === 'all') {
                renderAllCabinetsSection();
            }
        }

        function formatAccountStatusBadge(status) {
            if (status === undefined || status === null) return '';
            if (status == 1) {
                return '<span class="status-badge status-active">✓ Активний</span>';
            }
            return '<span class="status-badge status-banned">✗ Заблокований</span>';
        }

        function formatStatusTag(status) {
            if (!status) return '';
            const normalized = String(status).toUpperCase();
            let color = '#555';
            let bg = '#e0e0e0';
            if (normalized.includes('ACTIVE')) {
                bg = '#e8f5e9';
                color = '#2e7d32';
            } else if (normalized.includes('PAUSED')) {
                bg = '#fff3e0';
                color = '#e65100';
            } else if (normalized.includes('REJECT')) {
                bg = '#ffebee';
                color = '#c62828';
            }
            return `<span class="hierarchy-tag" style="background:${bg}; color:${color};">${normalized}</span>`;
        }

        document.addEventListener('click', function(event) {
            const toggle = event.target.closest('[data-toggle-id]');
            if (!toggle) return;
            const targetId = toggle.getAttribute('data-toggle-id');
            const type = toggle.getAttribute('data-toggle-type');
            const target = document.getElementById(targetId);
            if (!target) return;
            const isOpen = target.classList.toggle('open');
            toggle.textContent = isOpen ? '▼' : '▶';
            const store = type === 'cabinet' ? openCabinetIds : openCampaignIds;
            if (isOpen) {
                store.add(targetId);
            } else {
                store.delete(targetId);
            }
        });

        function handleAdsetToggle(event) {
            event.preventDefault();
            const button = event.currentTarget;
            const adsetId = button.getAttribute('data-adset-id');
            const accountId = button.getAttribute('data-account-id');
            const fbtoolAccountId = button.getAttribute('data-fbtool-id');
            const status = button.getAttribute('data-target-status');

            changeAdsetStatus(adsetId, accountId, fbtoolAccountId, status, button);
        }

        async function changeAdsetStatus(adsetId, accountId, fbtoolAccountId, status, sourceButton) {
            if (!adsetId || !accountId || !status) {
                showError('Неможливо змінити статус адсету: відсутні дані');
                return;
            }

            const container = sourceButton ? sourceButton.closest('.adset-actions') : null;
            if (container) setAdsetButtonsState(container, true);

            try {
                // Гарантуємо наявність префіксу act_
                const normalizedAccountId = normalizeCabinetId(accountId);

                console.log(`🔄 Зміна статусу AdSet: ${adsetId} → ${status}`);
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

                updateAdsetStatusLocally(String(adsetId), String(accountId), status);
                showNotification(data.message || `✅ Адсет ${adsetId} → ${status}`);
            } catch (error) {
                console.error(error);
                showError(error.message || 'Помилка зміни статусу адсету');
            } finally {
                if (container) setAdsetButtonsState(container, false);
            }
        }

        function setAdsetButtonsState(container, disabled) {
            const buttons = container.querySelectorAll('.adset-action-btn');
            buttons.forEach(btn => {
                btn.disabled = disabled;
                if (disabled) {
                    btn.classList.add('loading');
                } else {
                    btn.classList.remove('loading');
                }
            });
        }

        function updateAdsetStatusLocally(adsetId, accountId, status) {
            if (!adsetId || !Array.isArray(window.currentMatchedRows)) return;
            let updated = false;
            const normalizedAccountId = normalizeCabinetId(accountId || '');

            const collections = [window.currentMatchedRows, window.lastResults];
            collections.forEach(list => {
                if (!Array.isArray(list)) return;
                list.forEach(row => {
                    const rowAccount = String(row.account_id || row.adaccount_id || '');
                    if (rowAccount !== normalizedAccountId) return;
                    if (!Array.isArray(row.adsets)) return;
                    row.adsets.forEach(adset => {
                        const localId = String(adset.id || adset.adset_id || '');
                        if (localId === String(adsetId)) {
                            adset.status = status;
                            adset.ad_status = status;
                            updated = true;
                        }
                    });
                });
            });

            if (updated) {
                renderAllCabinetsSection();
                rerenderActiveView();
            }
        }

        function updateResultsMeta(settings = null) {
            const metaDiv = document.getElementById('resultsMeta');
            if (!metaDiv) return;

            lastRunSettings = settings || null;

            if (!settings) {
                metaDiv.style.display = 'none';
                metaDiv.innerHTML = '';
                return;
            }

            const {date, max_cpl, only_spend, adaccount_ids} = settings;
            let accountsText = '—';

            const uniqueIds = Array.isArray(adaccount_ids) ? Array.from(new Set(adaccount_ids)) : [];

            if (uniqueIds.length > 0) {
                const preview = uniqueIds.slice(0, 3).join(', ');
                const extras = uniqueIds.length > 3 ? ` +${uniqueIds.length - 3}` : '';
                accountsText = `${preview}${extras} (${uniqueIds.length})`;
            }

            const numericMaxCpl = Number(max_cpl);
            const onlySpendText = typeof only_spend === 'boolean'
                ? (only_spend ? 'Так' : 'Ні')
                : (only_spend ? 'Так' : 'Ні');
            const maxCplText = Number.isFinite(numericMaxCpl) ? `$${numericMaxCpl.toFixed(2)}` : (max_cpl ?? '—');

            metaDiv.innerHTML = `
                <strong>Параметри запуску:</strong>
                <ul style="margin-top: 10px; margin-left: 20px;">
                    <li><strong>Дата:</strong> ${date || '—'}</li>
                    <li><strong>Max CPL:</strong> ${maxCplText}</li>
                    <li><strong>Тільки кампанії з витратами:</strong> ${onlySpendText}</li>
                    <li><strong>Кабінети:</strong> ${accountsText}</li>
                </ul>
            `;
            metaDiv.style.display = 'block';
        }

        // Ініціалізація
        document.addEventListener('DOMContentLoaded', function() {
            // 🎨 Завантажуємо збережену тему ПЕРШОЮ (щоб не було мигтіння)
            loadSavedTheme();

            // Використовуємо локальний час замість UTC
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            const localDate = `${year}-${month}-${day}`;
            document.getElementById('dateInput').value = localDate;

            loadSavedState(); // Завантажуємо збережений стан (спочатку)
            loadAccounts();
            loadCabinetsPausedState(); // Завантажуємо стан пауз для АФК режиму

            // 🔍 Ініціалізація пошуку кабінетів (real-time фільтрація)
            const searchInput = document.getElementById('cabinetSearch');
            if (searchInput) {
                searchInput.addEventListener('input', filterCabinets);
                console.log('✅ Пошук кабінетів ініціалізовано');
            }
        });

        // 💾 ЗБЕРЕЖЕННЯ ТА ЗАВАНТАЖЕННЯ СТАНУ
        function saveState() {
            const state = {
                selectedAccounts: selectedAccounts,
                selectedAdaccounts: selectedAdaccounts,
                // ❌ НЕ зберігаємо дату - завжди використовуємо поточну
                // dateInput: document.getElementById('dateInput')?.value,
                maxCplInput: document.getElementById('maxCplInput')?.value,
                onlySpendCheckbox: document.getElementById('onlySpendCheckbox')?.checked,
                timestamp: Date.now()
            };
            localStorage.setItem('appState', JSON.stringify(state));
            console.log('💾 Стан збережено:', state);

            // Дублюємо стан на бекенд, щоб переживав рестарт
            fetch('/api/selection-state', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    selected_accounts: selectedAccounts,
                    selected_adaccounts: selectedAdaccounts
                })
            }).catch(() => {});
        }

        function loadSavedState() {
            try {
                const saved = localStorage.getItem('appState');
                let state = saved ? JSON.parse(saved) : null;

                const loadFromBackend = async () => {
                    try {
                        const resp = await fetch('/api/selection-state');
                        const data = await resp.json();
                        if (data.success && data.state) {
                            applyLoadedState(data.state);
                        }
                    } catch (e) {
                        console.warn('Не вдалося завантажити selection-state з бекенду:', e);
                    }
                };

                if (!state) {
                    loadFromBackend();
                    return;
                }

                applyLoadedState(state);
                loadFromBackend();
            } catch (e) {
                console.warn('Помилка завантаження стану:', e);
            }
        }

        function applyLoadedState(state) {
            console.log('📋 Завантажено збережений стан:', state);

            if (Array.isArray(state.selectedAccounts)) {
                selectedAccounts = state.selectedAccounts;
            }
            if (Array.isArray(state.selectedAdaccounts)) {
                selectedAdaccounts = state.selectedAdaccounts;
            }
            if (state.maxCplInput) {
                const maxCplInput = document.getElementById('maxCplInput');
                if (maxCplInput) maxCplInput.value = state.maxCplInput;
            }
            if (typeof state.onlySpendCheckbox === 'boolean') {
                const checkbox = document.getElementById('onlySpendCheckbox');
                if (checkbox) checkbox.checked = state.onlySpendCheckbox;
            }
        }

        // Функції для роботи з унікальними аккаунтами
        function dedupeSelectedAccounts() {
            selectedAccounts = [...new Set(selectedAccounts)];
        }

        function getUniqueSelectedAccounts() {
            return [...new Set(selectedAccounts)];
        }

        // Завантаження списку аккаунтів FBtool
        async function loadAccounts() {
            try {
                const response = await fetch('/api/accounts');
                const data = await response.json();

                if (data.success) {
                    accounts = data.accounts || [];
                    renderAccounts();
                } else {
                    console.error('Помилка завантаження аккаунтів:', data.error);
                    document.getElementById('accountsList').innerHTML =
                        '<div class="alert alert-error">❌ Помилка завантаження аккаунтів: ' + (data.error || 'Невідома помилка') + '</div>';
                }
            } catch (error) {
                console.error('Помилка при завантаженні аккаунтів:', error);
                document.getElementById('accountsList').innerHTML =
                    '<div class="alert alert-error">❌ Помилка підключення до сервера</div>';
            }
        }

        // Відображення списку аккаунтів
        function renderAccounts() {
            const list = document.getElementById('accountsList');

            if (!accounts || accounts.length === 0) {
                list.innerHTML = '<div class="alert alert-warning">⚠️ Аккаунти не знайдено</div>';
                return;
            }

            list.innerHTML = '';

            accounts.forEach(acc => {
                const accId = acc.id;
                const accName = acc.name || 'Невідомий';
                const isActive = acc.status == 1;
                const isChecked = selectedAccounts.includes(accId);

                const item = document.createElement('div');
                item.className = 'checkbox-item';

                item.innerHTML = `
                    <label>
                        <input type="checkbox"
                               value="${accId}"
                               ${isChecked ? 'checked' : ''}
                               onchange="toggleAccount('${accId}')">
                        <span class="checkbox-label">
                            <strong>${accName}</strong>
                            <small style="color: ${isActive ? '#4CAF50' : '#f44336'}">
                                ${isActive ? '✅ Активний' : '❌ Забанений'}
                            </small>
                        </span>
                    </label>
                `;

                list.appendChild(item);
            });
        }

        function toggleAccount(id) {
            const index = selectedAccounts.indexOf(id);
            if (index > -1) {
                selectedAccounts.splice(index, 1);
            } else {
                selectedAccounts.push(id);
            }
            dedupeSelectedAccounts();
            saveState();
        }

        function selectAllAccounts() {
            selectedAccounts = accounts.map(a => a.id);
            dedupeSelectedAccounts();
            document.querySelectorAll('#accountsList input[type="checkbox"]').forEach(cb => cb.checked = true);
            saveState();
        }

        function selectActiveAccounts() {
            selectedAccounts = accounts.filter(a => a.status == 1).map(a => a.id);
            dedupeSelectedAccounts();
            document.querySelectorAll('#accountsList input[type="checkbox"]').forEach(cb => {
                const acc = accounts.find(a => a.id == cb.value);
                cb.checked = acc && acc.status == 1;
            });
            saveState();
        }

        function deselectAllAccounts() {
            selectedAccounts = [];
            document.querySelectorAll('#accountsList input[type="checkbox"]').forEach(cb => cb.checked = false);
            saveState();
        }

        // Перехід на крок 2
        async function goToStep2() {
            if (selectedAccounts.length === 0) {
                alert('Виберіть хоча б один аккаунт!');
                return;
            }

            showLoading('Завантаження кабінетів...');

            try {
                const response = await fetch('/api/adaccounts', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({account_ids: selectedAccounts})
                });

                const data = await response.json();

                if (data.success) {
                    adaccounts = data.adaccounts;
                    renderAdaccounts();
                    showStep(2);
                } else {
                    showError('Помилка: ' + data.error);
                }
            } catch (error) {
                showError('Помилка: ' + error.message);
            }

            hideLoading();
        }

        // Функції для роботи з унікальними кабінетами
        function dedupeSelectedAdaccounts() {
            selectedAdaccounts = [...new Set(selectedAdaccounts)];
        }

        function getUniqueSelectedAdaccounts() {
            return [...new Set(selectedAdaccounts)];
        }

        // Відображення кабінетів з групуванням по профілям
        function renderAdaccounts() {
            const list = document.getElementById('adaccountsList');
            list.innerHTML = '';
            const preservedSelection = new Set(selectedAdaccounts);
            const isInitialLoad = preservedSelection.size === 0;
            selectedAdaccounts = [];

            // Групуємо кабінети по fbtool_account_id (профіль/аккаунт)
            const groupedByAccount = {};
            adaccounts.forEach(ad => {
                const accountId = ad.fbtool_account_id || 'unknown';
                if (!groupedByAccount[accountId]) {
                    groupedByAccount[accountId] = {
                        account_name: ad.account_name || accounts.find(a => a.id == accountId)?.name || 'Невідомий профіль',
                        account_id: accountId,
                        adaccounts: []
                    };
                }
                groupedByAccount[accountId].adaccounts.push(ad);
            });

            // Відображаємо по групам
            Object.values(groupedByAccount).forEach(group => {
                // Заголовок групи (профіль)
                const groupHeader = document.createElement('div');
                groupHeader.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 20px; margin: 20px 0 10px 0; border-radius: 8px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;';

                const activeCount = group.adaccounts.filter(a => a.account_status == 1).length;
                const totalCount = group.adaccounts.length;

                groupHeader.innerHTML = `
                    <div>
                        <span style="font-size: 16px;">📁 ${group.account_name}</span>
                        <span style="font-size: 12px; opacity: 0.9; margin-left: 10px;">ID: ${group.account_id}</span>
                    </div>
                    <div style="font-size: 14px; opacity: 0.95;">
                        <span>✓ ${activeCount} активних</span>
                        <span style="margin-left: 15px;">📊 ${totalCount} всього</span>
                        <button onclick="selectGroupAdaccounts('${group.account_id}')"
                                style="margin-left: 15px; background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); color: white; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                            Вибрати всі
                        </button>
                        <button onclick="deselectGroupAdaccounts('${group.account_id}')"
                                style="margin-left: 5px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3); color: white; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                            Зняти всі
                        </button>
                    </div>
                `;
                list.appendChild(groupHeader);

                // Кабінети цієї групи
                group.adaccounts.forEach(ad => {
                    const isActive = ad.account_status == 1;
                    const item = document.createElement('div');
                    item.className = `checkbox-item ${isActive ? 'active' : 'banned'}`;
                    item.style.marginLeft = '20px'; // Відступ для кабінетів групи
                    item.setAttribute('data-group', group.account_id);
                    item.innerHTML = `
                        <input type="checkbox" id="ad_${ad.id}" value="${ad.id}" ${isActive ? 'checked' : ''}
                               onchange="toggleAdaccount('${ad.id}')">
                        <label for="ad_${ad.id}" style="cursor: pointer; flex: 1;">
                            <strong style="color: var(--text-primary);">${ad.name}</strong><br>
                            <small style="color: var(--text-secondary);">ID: ${ad.id}</small>
                            ${(ad.source_accounts && ad.source_accounts.length > 1)
                                ? `<br><small style="color: var(--text-secondary);">🔁 Доступний у ${ad.source_accounts.length} профілях</small>`
                                : ''}
                        </label>
                        <span class="status-badge ${isActive ? 'status-active' : 'status-disabled'}">
                            ${isActive ? '✓ Активний' : '✗ Заблокований'}
                        </span>
                    `;
                    list.appendChild(item);

                    const shouldSelect = preservedSelection.size > 0
                        ? preservedSelection.has(ad.id)
                        : isActive;

                    if (shouldSelect) {
                        selectedAdaccounts.push(ad.id);
                        item.querySelector('input[type="checkbox"]').checked = true;
                    } else {
                        item.querySelector('input[type="checkbox"]').checked = false;
                    }
                });
            });

            dedupeSelectedAdaccounts();
        }

        function toggleAdaccount(id) {
            const index = selectedAdaccounts.indexOf(id);
            if (index > -1) {
                selectedAdaccounts.splice(index, 1);
            } else {
                selectedAdaccounts.push(id);
            }
            dedupeSelectedAdaccounts();
            saveState();
        }

        function selectAllAdaccounts() {
            selectedAdaccounts = adaccounts.map(a => a.id);
            dedupeSelectedAdaccounts();
            document.querySelectorAll('#adaccountsList input[type="checkbox"]').forEach(cb => cb.checked = true);
            saveState();
        }

        function selectActiveAdaccounts() {
            selectedAdaccounts = adaccounts.filter(a => a.account_status == 1).map(a => a.id);
            dedupeSelectedAdaccounts();
            document.querySelectorAll('#adaccountsList input[type="checkbox"]').forEach(cb => {
                const ad = adaccounts.find(a => a.id == cb.value);
                cb.checked = ad && ad.account_status == 1;
            });
            saveState();
        }

        function deselectAllAdaccounts() {
            selectedAdaccounts = [];
            document.querySelectorAll('#adaccountsList input[type="checkbox"]').forEach(cb => cb.checked = false);
            saveState();
        }

        // Вибір/зняття всіх кабінетів в групі
        function selectGroupAdaccounts(groupId) {
            const groupItems = document.querySelectorAll(`#adaccountsList [data-group="${groupId}"] input[type="checkbox"]`);
            groupItems.forEach(cb => {
                cb.checked = true;
                const id = cb.value;
                if (!selectedAdaccounts.includes(id)) {
                    selectedAdaccounts.push(id);
                }
            });
            dedupeSelectedAdaccounts();
        }

        function deselectGroupAdaccounts(groupId) {
            const groupItems = document.querySelectorAll(`#adaccountsList [data-group="${groupId}"] input[type="checkbox"]`);
            groupItems.forEach(cb => {
                cb.checked = false;
                const id = cb.value;
                const index = selectedAdaccounts.indexOf(id);
                if (index > -1) {
                    selectedAdaccounts.splice(index, 1);
                }
            });
        }

        // 🔍 Пошук кабінетів з групуванням (точні + часткові співпадіння)
        function filterCabinets() {
            const searchTerm = document.getElementById('cabinetSearch').value.trim();
            const checkboxItems = document.querySelectorAll('#adaccountsList .checkbox-item');
            const groupHeaders = document.querySelectorAll('#adaccountsList > div[style*="linear-gradient"]');

            // Масиви для 2 груп
            let exactMatches = [];
            let partialMatches = [];
            let visibleGroups = new Set();

            checkboxItems.forEach(item => {
                const checkbox = item.querySelector('input[type="checkbox"]');
                if (!checkbox) return;

                const adId = checkbox.value; // act_1393394295752999
                const groupId = item.getAttribute('data-group');

                if (!searchTerm) {
                    // Пусте поле - показати все в оригінальному порядку
                    item.style.display = '';
                    item.style.order = '';
                    item.classList.remove('search-exact', 'search-partial');
                    resetHighlight(item);
                    if (groupId) visibleGroups.add(groupId);
                } else {
                    const isSuffixMatch = adId.endsWith(searchTerm);
                    const containsMatch = adId.includes(searchTerm);

                    if (isSuffixMatch) {
                        // Група 1: Точні співпадіння (суфікс) - показуються ПЕРШИМИ
                        item.style.display = '';
                        item.style.order = '-1000'; // Від'ємне значення - зверху
                        item.classList.remove('search-partial');
                        item.classList.add('search-exact');
                        exactMatches.push(adId);
                        highlightMatch(item, searchTerm, '#86efac'); // Зелене підсвічування
                        if (groupId) visibleGroups.add(groupId);
                    } else if (containsMatch) {
                        // Група 2: Часткові співпадіння (містить) - показуються ДРУГИМИ
                        item.style.display = '';
                        item.style.order = '-500'; // Менше від'ємне значення - нижче точних
                        item.classList.remove('search-exact');
                        item.classList.add('search-partial');
                        partialMatches.push(adId);
                        highlightMatch(item, searchTerm, '#fef08a'); // Жовте підсвічування
                        if (groupId) visibleGroups.add(groupId);
                    } else {
                        // Не співпадає - приховати
                        item.style.display = 'none';
                        item.classList.remove('search-exact', 'search-partial');
                        resetHighlight(item);
                    }
                }
            });

            // Показуємо/ховаємо заголовки груп
            groupHeaders.forEach(header => {
                if (!searchTerm) {
                    // Без пошуку - показуємо групи
                    header.style.display = '';
                    header.style.order = '';
                } else {
                    // При пошуку - ховаємо ВСІ групи, показуємо тільки результати
                    header.style.display = 'none';
                }
            });

            // Показати статистику
            const totalFound = exactMatches.length + partialMatches.length;
            const resultsEl = document.getElementById('searchResults');
            if (searchTerm) {
                resultsEl.textContent =
                    `Знайдено: ${totalFound} кабінетів (${exactMatches.length} точних, ${partialMatches.length} часткових)`;
            } else {
                resultsEl.textContent = '';
            }
        }

        // Підсвічування знайденого тексту
        function highlightMatch(item, searchTerm, highlightColor) {
            const small = item.querySelector('small');
            if (small && small.textContent.includes('ID:')) {
                const originalText = small.textContent;
                const idMatch = originalText.match(/ID:\s*(.+)/);
                if (idMatch) {
                    const adId = idMatch[1].trim();
                    const index = adId.indexOf(searchTerm);

                    if (index !== -1) {
                        const before = adId.substring(0, index);
                        const match = adId.substring(index, index + searchTerm.length);
                        const after = adId.substring(index + searchTerm.length);

                        small.innerHTML =
                            `ID: ${before}<mark style="background: ${highlightColor}; padding: 2px 4px; border-radius: 3px; font-weight: bold;">${match}</mark>${after}`;
                    }
                }
            }
        }

        // Скидання підсвічування
        function resetHighlight(item) {
            const small = item.querySelector('small');
            if (small && small.innerHTML.includes('<mark')) {
                const idMatch = small.textContent.match(/ID:\s*(.+)/);
                if (idMatch) {
                    small.textContent = `ID: ${idMatch[1].trim()}`;
                }
            }
        }

        // 🌙 Темна тема з localStorage
        function toggleTheme() {
            const body = document.body;
            const currentTheme = body.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

            body.setAttribute('data-theme', newTheme);

            // Оновлюємо іконку кнопки
            const btn = document.getElementById('themeToggle');
            btn.textContent = newTheme === 'dark' ? '☀️' : '🌙';

            // Зберігаємо в localStorage
            localStorage.setItem('theme', newTheme);

            console.log(`🎨 Тема змінена на: ${newTheme}`);
        }

        function loadSavedTheme() {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme) {
                document.body.setAttribute('data-theme', savedTheme);
                const btn = document.getElementById('themeToggle');
                if (btn) {
                    btn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
                }
                console.log(`🎨 Завантажено збережену тему: ${savedTheme}`);
            }
        }

        // Оновлення CRM даних
        async function refreshCRM() {
            // 🔒 Перевірка глобального lock
            if (!acquireLock('Оновлення CRM даних')) {
                return;
            }

            const confirmed = confirm('🔄 Оновити CRM дані (ліди)?\n\nСторінка CRM буде оновлена і дані будуть зібрані заново.\nЦе займе 30-60 секунд.');

            if (!confirmed) {
                releaseLock();
                return;
            }

            showLoading('🔄 Оновлення CRM (ліди)...<br><small>Оновлюю сторінку та збираю свіжі дані...</small>');

            try {
                const response = await fetch('/api/refresh-crm', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'}
                });

                const data = await response.json();

                if (data.success) {
                    // Після оновлення CRM - перезбираємо дані для відображення
                    const uniqueSelected = getUniqueSelectedAdaccounts();
                    const activeCabinets = uniqueSelected;
                    const date = document.getElementById('dateInput').value;
                    const maxCpl = parseFloat(document.getElementById('maxCplInput').value);
                    const onlySpend = document.getElementById('onlySpendCheckbox').checked;

                    document.getElementById('loadingText').innerHTML = '🔄 Перерахунок CPL...<br><small>Зіставлення оновлених даних...</small>';

                    setLastRequestedCabinets(activeCabinets);
                    renderAllCabinetsSection();

                    const collectResponse = await fetch('/api/collect', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            adaccount_ids: activeCabinets,
                            date: date,
                            max_cpl: maxCpl,
                            only_spend: onlySpend,
                            refresh_crm: false
                        })
                    });

                    const collectData = await collectResponse.json();

                    if (collectData.success) {
                        // Оновлюємо UI з новими даними
                        renderResults(collectData.data, collectData.stats, collectData.settings);
                        updateLastRefreshTime(collectData.timestamp || data.timestamp);
                        alert(`✅ CRM дані (ліди) оновлено та перераховано!\n\n📊 Кампаній: ${data.campaigns}\n📈 Лідів: ${data.leads}\n\n🎯 Результат:\n   З лідами: ${collectData.stats.with_leads}\n   Без лідів: ${collectData.stats.no_leads}\n\n🕐 Час: ${new Date(data.timestamp).toLocaleTimeString()}`);
                    } else {
                        throw new Error('Помилка перерахунку: ' + collectData.error);
                    }
                } else {
                    showError('Помилка оновлення CRM: ' + data.error);
                }
            } catch (error) {
                showError('Помилка оновлення CRM: ' + error.message);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
                hideLoading();
            }
        }

        // Авто-оновлення CRM кожну хвилину
        let autoCrmEnabled = false;

        async function toggleAutoCRM() {
            const btn = document.getElementById('autoCrmBtn');

            if (!autoCrmEnabled) {
                // Запускаємо авто-CRM
                const confirmed = confirm('🚀 Запустити автооновлення CRM?\n\nCRM буде оновлюватись автоматично кожну хвилину в фоні.\nПерше оновлення через 5 секунд.');

                if (!confirmed) return;

                try {
                    const response = await fetch('/api/auto-crm/start', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'}
                    });

                    const data = await response.json();

                    if (data.success) {
                        autoCrmEnabled = true;
                        btn.textContent = '⏰ Авто-CRM: ON';
                        btn.style.background = '#4CAF50';
                        console.log('✅ Автооновлення CRM запущено');

                        // Синхронізуємо кнопку на Кроці 4
                        syncStep4Buttons();
                    } else {
                        alert('Помилка запуску: ' + data.message);
                    }
                } catch (error) {
                    alert('Помилка запуску авто-CRM: ' + error.message);
                }
            } else {
                // Зупиняємо авто-CRM
                try {
                    const response = await fetch('/api/auto-crm/stop', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'}
                    });

                    const data = await response.json();

                    if (data.success) {
                        autoCrmEnabled = false;
                        btn.textContent = '⏰ Авто-CRM: OFF';
                        btn.style.background = '#9c27b0';
                        console.log('⏹️ Автооновлення CRM зупинено');

                        // Синхронізуємо кнопку на Кроці 4
                        syncStep4Buttons();
                    } else {
                        alert('Помилка зупинки: ' + data.message);
                    }
                } catch (error) {
                    alert('Помилка зупинки авто-CRM: ' + error.message);
                }
            }
        }

        // Перевіряємо статус авто-CRM при завантаженні
        async function checkAutoCrmStatus() {
            try {
                const response = await fetch('/api/auto-crm/status');
                const data = await response.json();

                if (data.success && data.enabled) {
                    autoCrmEnabled = true;
                    const btn = document.getElementById('autoCrmBtn');
                    if (btn) {
                        btn.textContent = '⏰ Авто-CRM: ON';
                        btn.style.background = '#4CAF50';
                    }
                }
            } catch (error) {
                console.warn('Не вдалось перевірити статус авто-CRM:', error);
            }
        }

        // Викликаємо перевірку при завантаженні сторінки
        document.addEventListener('DOMContentLoaded', checkAutoCrmStatus);

        async function refreshFB() {
            // 🔒 Перевірка глобального lock
            if (!acquireLock('Оновлення FB Ads даних')) {
                return;
            }

            const uniqueSelected = getUniqueSelectedAdaccounts();

            // 🔍 ДЕБАГ: Логуємо стан
            console.log('🔍 ДЕБАГ refreshFB():');
            console.log('  uniqueSelected:', uniqueSelected);
            console.log('  cabinetsToUpdate:', Array.from(cabinetsToUpdate));

            // Фільтруємо тільки вибрані кабінети (якщо cabinetsToUpdate порожній - беремо всі)
            const activeCabinets = cabinetsToUpdate.size === 0
                ? uniqueSelected
                : uniqueSelected.filter(id => cabinetsToUpdate.has(id));

            console.log('  activeCabinets:', activeCabinets);

            if (activeCabinets.length === 0) {
                releaseLock();
                alert('⚠️ Виберіть хоча б один кабінет для оновлення!\n\nВикористовуйте чекбокси біля кабінетів.');
                return;
            }

            const confirmMsg = `💰 Оновити FB Ads дані (спенд)?\n\nБуде завантажено свіжі дані витрат з ${activeCabinets.length} кабінетів.\n\nЦе займе ~${Math.ceil(activeCabinets.length / 20)} хв.\n⚠️ Rate limit: 20 кабінетів/хв.`;

            const confirmed = confirm(confirmMsg);

            if (!confirmed) {
                releaseLock();
                return;
            }

            const date = document.getElementById('dateInput').value;
            showLoading(`💰 Оновлення FB Ads (спенд)...<br><small>Завантаження даних з ${activeCabinets.length} кабінетів...<br>Це може зайняти 1-3 хвилини...</small>`);

            try {
                const response = await fetch('/api/refresh-fb', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        adaccount_ids: activeCabinets,
                        date: date
                    })
                });

                const data = await response.json();

                if (data.success) {
                    alert(`✅ FB Ads дані (спенд) оновлено!\n\n📊 Кампаній: ${data.campaigns}\n💰 Spend: $${data.spend.toFixed(2)}\n🕐 Час: ${new Date(data.timestamp).toLocaleTimeString()}`);
                } else {
                    showError('Помилка оновлення FB Ads: ' + data.error);
                }
            } catch (error) {
                showError('Помилка оновлення FB Ads: ' + error.message);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
                hideLoading();
            }
        }

        // Збір даних ТІЛЬКИ для активних кабінетів (не на паузі АФК)
        async function collectActiveData() {
            // 🔒 Перевірка глобального lock
            if (!acquireLock('Збір активних даних')) {
                return;
            }

            const runButton = document.querySelector('button[onclick="collectActiveData()"]');
            const originalButtonText = runButton ? runButton.textContent : '';
            const uniqueSelected = getUniqueSelectedAdaccounts();

            // Фільтруємо тільки НЕ на паузі
            const activeCabinets = uniqueSelected.filter(id => !cabinetsPaused.has(id));
            const pausedCount = uniqueSelected.length - activeCabinets.length;

            console.log(`🔄 collectActiveData: ${activeCabinets.length} активних, ${pausedCount} на паузі`);

            if (activeCabinets.length === 0) {
                releaseLock();
                alert(`⚠️ Всі кабінети на паузі АФК!\n\nНа паузі: ${pausedCount} кабінетів\n\nВикористайте "Оновити всі" або зніміть паузу з потрібних кабінетів.`);
                return;
            }

            if (runButton) {
                runButton.disabled = true;
                runButton.textContent = 'Оновлюю...';
            }

            setLastRequestedCabinets(activeCabinets);
            renderAllCabinetsSection();

            const date = document.getElementById('dateInput').value;
            const maxCpl = parseFloat(document.getElementById('maxCplInput').value);
            const onlySpend = document.getElementById('onlySpendCheckbox').checked;

            showStep(4);
            showLoadingProgress(`Оновлення ${activeCabinets.length} активних кабінетів...`, 0, activeCabinets.length);

            try {
                const response = await fetch('/api/collect', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        adaccount_ids: activeCabinets,
                        date: date,
                        max_cpl: maxCpl,
                        only_spend: onlySpend,
                        refresh_crm: true
                    })
                });

                const data = await response.json();

                if (data.success) {
                    renderActiveCampaignsTree(data.data);
                    updateLastRefreshTime(data.timestamp);
                    hideLoading();

                    window.lastResults = dedupeCampaignRows(data.data);
                    window.currentMatchedRows = Array.isArray(data.data) ? [...data.data] : [];
                    renderAllCabinetsSection();
                    detectInactiveCabinets();

                    const stats = recomputeStatsFromRows(window.lastResults);
                    updateStats(stats);

                    if (pausedCount > 0) {
                        showNotification(`✅ Оновлено ${activeCabinets.length} активних кабінетів\n⏸️ Пропущено ${pausedCount} на паузі`);
                    }
                } else {
                    throw new Error(data.error || 'Помилка збору даних');
                }
            } catch (error) {
                hideLoading();
                showError('Помилка: ' + error.message);
            } finally {
                releaseLock();
                if (runButton) {
                    runButton.disabled = false;
                    runButton.textContent = originalButtonText || '🔄 Оновити активні';
                }
            }
        }

        // Збір даних з real-time оновленнями (ВСІ кабінети)
        async function collectData() {
            // 🔒 Перевірка глобального lock
            if (!acquireLock('Збір даних')) {
                return;
            }

            // ✅ НЕ скидаємо паузи - кабінети на паузі АФК залишаються на паузі

            const runButton = document.querySelector('button[onclick="collectData()"]');
            const originalButtonText = runButton ? runButton.textContent : '';
            const uniqueSelected = getUniqueSelectedAdaccounts();

            // 🔍 ДЕБАГ: Логуємо стан перед фільтрацією
            console.log('🔍 ДЕБАГ collectData():');
            console.log('  uniqueSelected (всі кабінети з кроку 2):', uniqueSelected);
            console.log('  cabinetsToUpdate.size:', cabinetsToUpdate.size);
            console.log('  cabinetsToUpdate (обрані чекбоксами):', Array.from(cabinetsToUpdate));

            // Фільтруємо тільки вибрані кабінети (якщо cabinetsToUpdate порожній - беремо всі)
            const activeCabinets = cabinetsToUpdate.size === 0
                ? uniqueSelected
                : uniqueSelected.filter(id => cabinetsToUpdate.has(id));

            console.log('  activeCabinets (що будуть відправлені на сервер):', activeCabinets);
            console.log('  activeCabinets.length:', activeCabinets.length);

            if (activeCabinets.length === 0) {
                releaseLock();
                alert('⚠️ Виберіть хоча б один кабінет для збору даних!\n\nВикористовуйте чекбокси біля кабінетів.');
                return;
            }

            setLastRequestedCabinets(activeCabinets);
            renderAllCabinetsSection();

            if (runButton) {
                runButton.disabled = true;
                runButton.textContent = 'Збираю дані...';
            }

            const date = document.getElementById('dateInput').value;
            const maxCpl = parseFloat(document.getElementById('maxCplInput').value);
            const onlySpend = document.getElementById('onlySpendCheckbox').checked;

            // Формуємо request body
            const requestBody = {
                adaccount_ids: activeCabinets,
                date: date,
                max_cpl: maxCpl,
                only_spend: onlySpend,
                refresh_crm: true
            };

            // Показуємо request в консолі
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📤 API Request: POST /api/collect (з історичним spend та leads)');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📅 Дата:', date);
            console.log('📊 Кабінетів:', activeCabinets.length);
            console.log('💰 Max CPL:', maxCpl);
            console.log('🎯 Only Spend:', onlySpend);
            console.log('');
            console.log('📝 Request Body:');
            console.log(JSON.stringify(requestBody, null, 2));
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            // Переходимо на крок 4
            showStep(4);

            // Показуємо завантаження з прогрес-баром
            showLoadingProgress('Початок збору даних...', 0, activeCabinets.length);

            try {
                // Відправляємо POST запит до /api/collect (з історичним spend та leads)
                const initResponse = await fetch('/api/collect', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(requestBody)
                });

                if (!initResponse.ok) {
                    const errorData = await initResponse.json();
                    throw new Error(errorData.error || 'Помилка підключення до сервера');
                }

                // Отримуємо JSON відповідь (не stream)
                showLoadingProgress('Обробка даних...', activeCabinets.length, activeCabinets.length);
                const data = await initResponse.json();

                if (data.success) {
                    // ✅ Автоматично вимикаємо забанені адсети
                    const disabledAdsets = await autoDisableRejectedAdsets(data.data);
                    if (disabledAdsets.length > 0) {
                        console.log(`🚫 Автоматично вимкнено ${disabledAdsets.length} забанених адсетів:`, disabledAdsets);
                        addLogMessage(`🚫 Вимкнено ${disabledAdsets.length} забанених адсетів`, 'warning');
                    }

                    // ✅ НОВА ВЕРСІЯ: Відображаємо тільки активні кампанії
                    renderActiveCampaignsTree(data.data);
                    updateLastRefreshTime(data.timestamp);
                    hideLoading();
                    addLogMessage('✅ Дані зібрано успішно!', 'success');

                    // Зберігаємо дані глобально для подальшого використання
                    window.lastResults = dedupeCampaignRows(data.data);
                    window.currentMatchedRows = Array.isArray(data.data) ? [...data.data] : [];
                    window.currentCrmOnlyRows = window.currentMatchedRows.filter(row => row.status === 'crm_only');
                    renderAllCabinetsSection();
                    detectInactiveCabinets();

                    // ✅ Оновлюємо міні-статистику
                    const collectedStats = recomputeStatsFromRows(window.lastResults);
                    updateStats(collectedStats);
                } else {
                    throw new Error(data.error || 'Невідома помилка');
                }

                // Старий код обробки stream більше не потрібен
                // Використовуємо простий JSON response замість SSE stream

            } catch (error) {
                hideLoading();
                showError('Помилка: ' + error.message);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
                if (runButton) {
                    runButton.disabled = false;
                    runButton.textContent = originalButtonText || 'Завантажити дані →';
                }
            }
        }

        // Відображення результатів
        // Відображення результатів
        function renderResults(data, stats, settings = null) {
            showStep(4);
            isRealtimeViewActive = false;
            openCabinetIds = new Set();
            openCampaignIds = new Set();
            knownCabinetBodyIds = new Set();
            updateResultsMeta(settings || lastRunSettings);

            const safeData = Array.isArray(data) ? data : [];
            const safeStats = stats || {};

            // 🔍 DEBUG: Показуємо структуру даних
            console.log('📊 renderResults - отримані дані:', safeData);
            if (safeData.length > 0) {
                console.log('📝 Перший запис:', safeData[0]);
                console.log('📦 Adsets у першому записі:', safeData[0].adsets);
                if (safeData[0].adsets && safeData[0].adsets.length > 0) {
                    console.log('📄 Перший adset:', safeData[0].adsets[0]);
                    console.log('🎯 Ads у першому adset:', safeData[0].adsets[0].ads);
                }
            }

            safeData.forEach(ensureRowHasNormalizedId);
            window.lastResults = dedupeCampaignRows(safeData);
            window.currentMatchedRows = [...safeData];
            window.currentCrmOnlyRows = [];
            syncResultsSortSelect();

            const statsDiv = document.getElementById('resultsStats');
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

            if ((safeStats.crm_only_count || 0) > 0) {
                statsDiv.innerHTML += `
                    <div class="stat-card" style="background: linear-gradient(135deg, #fff3cd 0%, #fff9e6 100%); border-left: 4px solid #ffc107;">
                        <h3>${safeStats.crm_only_count}</h3>
                        <p>📊 Тільки в CRM</p>
                    </div>
                `;
            }

            // ✅ Оновлюємо міні-статистику на Кроці 4
            const miniSpend = document.getElementById('miniStatSpend');
            const miniLeads = document.getElementById('miniStatLeads');
            const miniCPL = document.getElementById('miniStatCPL');
            if (miniSpend) miniSpend.textContent = formatCurrency(safeStats.total_spend || 0);
            if (miniLeads) miniLeads.textContent = safeStats.total_leads ?? 0;
            if (miniCPL) miniCPL.textContent = formatCurrency(safeStats.avg_cpl || 0);

            renderAllCabinetsSection();
            detectInactiveCabinets();
        }

        // 🆕 Real-time функції для поступового додавання даних
        // 🆕 Real-time функції для поступового додавання даних
        function initializeResultsTable() {
            window.lastResults = [];
            window.currentMatchedRows = [];
            window.currentCrmOnlyRows = [];
            openCabinetIds = new Set();
            openCampaignIds = new Set();
            knownCabinetBodyIds = new Set();
            isRealtimeViewActive = true;
            updateResultsMeta(null);
            syncResultsSortSelect();

            const statsDiv = document.getElementById('resultsStats');
            statsDiv.innerHTML = `
                <div class="stat-card"><h3>0</h3><p>Всього кампаній</p></div>
                <div class="stat-card"><h3>0</h3><p>З лідами</p></div>
                <div class="stat-card"><h3>0</h3><p>Без лідів</p></div>
                <div class="stat-card"><h3>0</h3><p>Високий CPL</p></div>
                <div class="stat-card"><h3>$0.00</h3><p>Витрати</p></div>
                <div class="stat-card"><h3>0</h3><p>Ліди</p></div>
                <div class="stat-card"><h3>$0.00</h3><p>Середній CPL</p></div>
            `;

            // Скидаємо міні-статистику на Кроці 4
            const miniSpend = document.getElementById('miniStatSpend');
            const miniLeads = document.getElementById('miniStatLeads');
            const miniCPL = document.getElementById('miniStatCPL');
            if (miniSpend) miniSpend.textContent = '$0.00';
            if (miniLeads) miniLeads.textContent = '0';
            if (miniCPL) miniCPL.textContent = '$0.00';

            const tableDiv = document.getElementById('resultsTable');
            if (tableDiv) {
                tableDiv.innerHTML = `<div class="hierarchy-placeholder">Очікуємо перші результати...</div>`;
            }
        }

        function addCabinetRows(cabinetData) {
            const rows = Array.isArray(cabinetData)
                ? cabinetData
                : (cabinetData ? [cabinetData] : []);
            if (!rows.length) {
                return;
            }
            const prepared = rows.map(row => ensureRowHasNormalizedId({...row}));
            window.currentMatchedRows.push(...prepared);
            renderAllCabinetsSection();
        }

        function updateStats(stats) {
            // Оновлюємо статистику в real-time
            const statsDiv = document.getElementById('resultsStats');
            const safeStats = stats || {};

            // ✅ Перевірка на null - елемент може не існувати якщо Крок 4 ще не відображається
            if (!statsDiv) {
                console.log('⚠️ updateStats: resultsStats елемент не знайдено, пропускаю');
                // Але все одно оновлюємо міні-статистику якщо вона є
                const miniSpend = document.getElementById('miniStatSpend');
                const miniLeads = document.getElementById('miniStatLeads');
                const miniCPL = document.getElementById('miniStatCPL');
                if (miniSpend) miniSpend.textContent = formatCurrency(safeStats.total_spend || 0);
                if (miniLeads) miniLeads.textContent = safeStats.total_leads ?? 0;
                if (miniCPL) miniCPL.textContent = formatCurrency(safeStats.avg_cpl || 0);
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
                        <p>📊 Тільки в CRM</p>
                    </div>
                `;
            }

            // Оновлюємо міні-статистику на Кроці 4
            const miniSpend = document.getElementById('miniStatSpend');
            const miniLeads = document.getElementById('miniStatLeads');
            const miniCPL = document.getElementById('miniStatCPL');

            if (miniSpend) miniSpend.textContent = formatCurrency(safeStats.total_spend || 0);
            if (miniLeads) miniLeads.textContent = safeStats.total_leads ?? 0;
            if (miniCPL) miniCPL.textContent = formatCurrency(safeStats.avg_cpl || 0);
        }

        function finalizeResults(allData, stats, settings = null) {
            const normalizedData = (allData || []).map(row => ensureRowHasNormalizedId({...row}));
            window.lastResults = dedupeCampaignRows(normalizedData);
            window.currentMatchedRows = [...normalizedData];
            window.currentCrmOnlyRows = allData.filter(row => row.status === 'crm_only');
            updateResultsMeta(settings || lastRunSettings);
            renderAllCabinetsSection();
            detectInactiveCabinets();
            isRealtimeViewActive = false;
        }

        // Оновлення всіх даних (FB Ads + CRM)
        async function refreshAllData() {
            // 🔒 Перевірка глобального lock
            if (!acquireLock('Оновлення всіх даних')) {
                return;
            }

            const uniqueSelected = getUniqueSelectedAdaccounts();
            // Фільтруємо тільки вибрані кабінети (якщо cabinetsToUpdate порожній - беремо всі)
            const activeCabinets = cabinetsToUpdate.size === 0
                ? uniqueSelected
                : uniqueSelected.filter(id => cabinetsToUpdate.has(id));

            if (activeCabinets.length === 0) {
                releaseLock();
                alert('⚠️ Виберіть хоча б один кабінет для оновлення!\n\nВикористовуйте чекбокси біля кабінетів.');
                return;
            }

            const confirmMsg = `🔄 Оновити ВСІ дані?\n\n1. CRM ліди (refresh сторінки + парсинг)\n2. FB Ads спенди (${activeCabinets.length} кабінетів)\n3. Перерахунок CPL\n\nЦе займе ~${Math.ceil(activeCabinets.length / 10) + 1} хв.\n⚠️ Rate limit: 10 кабінетів/хв (2 запити/кабінет).`;

            const confirmed = confirm(confirmMsg);

            if (!confirmed) {
                releaseLock();
                return;
            }

            const date = document.getElementById('dateInput').value;
            showLoading(`🔄 Оновлення ВСІХ даних...<br><small>CRM + FB Ads (${activeCabinets.length} кабінетів) + перерахунок CPL...<br>Це може зайняти 2-5 хвилин...</small>`);

            try {
                // Викликаємо новий об'єднаний endpoint
                const response = await fetch('/api/refresh-all', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        adaccount_ids: activeCabinets,
                        date: date
                    })
                });

                const data = await response.json();

                if (data.success) {
                    // Після оновлення, перезбираємо дані для відображення з CPL
                    const maxCpl = parseFloat(document.getElementById('maxCplInput').value);
                    const onlySpend = document.getElementById('onlySpendCheckbox').checked;

                    document.getElementById('loadingText').innerHTML = '🔄 Перерахунок CPL...<br><small>Зіставлення даних та обчислення метрик...</small>';

                    setLastRequestedCabinets(activeCabinets);
                    renderAllCabinetsSection();

                    const collectResponse = await fetch('/api/collect', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            adaccount_ids: activeCabinets,
                            date: date,
                            max_cpl: maxCpl,
                            only_spend: onlySpend,
                            refresh_crm: false
                        })
                    });

                    const collectData = await collectResponse.json();

                    if (collectData.success) {
                        // ✅ Повна перемальовка результатів (як у старій версії)
                        // Це оновлення ВСІХ даних (CRM + FB), тому показуємо всі нові дані
                        renderResults(collectData.data, collectData.stats, collectData.settings);
                        updateLastRefreshTime(collectData.timestamp || data.timestamp);
                        alert(`✅ ВСІ ДАНІ ОНОВЛЕНО!\n\n📊 CRM:\n   Кампаній: ${data.crm_campaigns}\n   Лідів: ${data.crm_leads}\n\n💰 FB Ads:\n   Кампаній: ${data.fb_campaigns}\n   Spend: $${data.fb_spend.toFixed(2)}\n\n🎯 Результат:\n   З лідами: ${collectData.stats.with_leads}\n   Без лідів: ${collectData.stats.no_leads}\n\n🕐 Час: ${new Date(data.timestamp).toLocaleTimeString()}`);
                    } else {
                        throw new Error('Помилка перерахунку CPL: ' + collectData.error);
                    }
                } else {
                    showError('Помилка оновлення: ' + data.error);
                }
            } catch (error) {
                showError('Помилка оновлення: ' + error.message);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
                hideLoading();
            }
        }

        // Експорт в Excel
        async function exportExcel() {
            showLoading('Експорт в Excel...');
            try {
                window.location.href = '/api/export';
            } catch (error) {
                showError('Помилка експорту: ' + error.message);
            }
            hideLoading();
        }

        // Auto-Refresh Functions

        /**
         * Зберігає стан АФК режиму у файл для telegram_bot
         */
        function saveAfkStateToFile() {
            const afkState = {
                enabled: isAutoRefreshActive,
                cabinets: getUniqueSelectedAdaccounts(),
                last_update: new Date().toISOString(),
                interval_minutes: parseInt(document.getElementById('autoRefreshInterval')?.value || 5)
            };

            fetch('/api/afk-state', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(afkState)
            }).then(response => response.json())
              .then(data => {
                  if (data.success) {
                      console.log('✅ АФК стан збережено для Telegram bot');
                  }
              })
              .catch(err => {
                  console.warn('⚠️ Не вдалося зберегти стан АФК:', err);
              });
        }

        function toggleAutoRefresh() {
            console.log('🎬 toggleAutoRefresh викликано');

            const toggle = document.getElementById('autoRefreshToggle');
            const statusDiv = document.getElementById('autoRefreshStatus');
            const intervalInput = document.getElementById('autoRefreshInterval');

            if (!toggle || !intervalInput) {
                console.error('❌ Auto-refresh elements not found!');
                console.error(`   toggle: ${toggle}`);
                console.error(`   intervalInput: ${intervalInput}`);
                return;
            }

            const interval = parseInt(intervalInput.value);
            console.log(`   toggle.checked: ${toggle.checked}`);
            console.log(`   interval: ${interval}`);

            if (toggle.checked) {
                // Запускаємо auto-refresh
                const uniqueSelected = getUniqueSelectedAdaccounts();
                console.log(`🔍 [AFK] Перевірка кабінетів: selectedAdaccounts=${selectedAdaccounts.length}, uniqueSelected=${uniqueSelected.length}`);

                if (uniqueSelected.length === 0) {
                    alert('⚠️ Спочатку виберіть кабінети на Кроці 2!');
                    toggle.checked = false;
                    return;
                }

                if (interval < 1 || interval > 60) {
                    alert('⚠️ Інтервал має бути від 1 до 60 хвилин!');
                    toggle.checked = false;
                    return;
                }

                console.log(`✅ [AFK] Перевірки пройдено, запускаю АФК режим...`);
                isAutoRefreshActive = true;
                // FIX: clear paused on AFK enable
                clearCabinetsPausedState();
                if (statusDiv) statusDiv.style.display = 'block';
                startAutoRefresh(interval);
                console.log(`🔄 [AFK] Auto-refresh запущено з інтервалом ${interval} хв, кабінетів: ${uniqueSelected.length}`);

                // Синхронізуємо кнопку на Кроці 4
                syncStep4Buttons();
            } else {
                // Зупиняємо auto-refresh
                isAutoRefreshActive = false;
                if (statusDiv) statusDiv.style.display = 'none';
                stopAutoRefresh();
                console.log('⏹️ Auto-refresh зупинено');

                // Синхронізуємо кнопку на Кроці 4
                syncStep4Buttons();
            }

            // Зберігаємо стан АФК для Telegram bot
            saveAfkStateToFile();
        }

        function startAutoRefresh(intervalMinutes) {
            stopAutoRefresh();

            console.log(`🚀 [AFK] Запуск АФК режиму з інтервалом ${intervalMinutes} хв`);

            // Оновлюємо статус
            updateAutoRefreshStatus(intervalMinutes);

            // Встановлюємо інтервал для наступних оновлень (spend + leads)
            autoRefreshInterval = setInterval(() => {
                if (isAutoRefreshActive) {
                    console.log(`🔄 [AFK] Виконую планове оновлення (spend)`);
                    performAutoRefresh();
                } else {
                    console.warn('⚠️ [AFK] isAutoRefreshActive = false, пропускаю оновлення');
                }
            }, intervalMinutes * 60 * 1000);

            // Оновлюємо таймер "наступне оновлення" кожну секунду
            autoRefreshNextUpdate = setInterval(() => {
                updateNextRefreshTime(intervalMinutes);
            }, 1000);

            console.log('✅ [AFK] Таймери встановлено: Spend кожні', intervalMinutes, 'хв');

            // ✅ Окремий таймер для CRM (кожну хвилину)
            crmRefreshInterval = setInterval(() => {
                if (isAutoRefreshActive) {
                    console.log('🔄 [AFK] Автоматичне оновлення CRM (кожну хвилину)');
                    refreshCrmCacheSilently();
                }
            }, 60 * 1000); // 1 хвилина = 60000 мс

            console.log('✅ [AFK] CRM таймер встановлено: оновлення кожну хвилину');

            // Запускаємо перше оновлення через 5 секунд (щоб lock точно був вільний)
            console.log('⏳ [AFK] Перше оновлення через 5 секунд...');
            setTimeout(() => {
                if (isAutoRefreshActive) {
                    console.log('🚀 [AFK] Запускаю перше оновлення (spend)');
                    performAutoRefresh();
                }
            }, 5000);

            // Перше оновлення CRM через 10 секунд
            setTimeout(() => {
                if (isAutoRefreshActive) {
                    console.log('🚀 [AFK] Перше оновлення CRM');
                    refreshCrmCacheSilently();
                }
            }, 10000);
        }

        function stopAutoRefresh() {
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
            if (autoRefreshNextUpdate) {
                clearInterval(autoRefreshNextUpdate);
                autoRefreshNextUpdate = null;
            }
            if (crmRefreshInterval) {
                clearInterval(crmRefreshInterval);
                crmRefreshInterval = null;
            }
            console.log('⏹️ AFK режим зупинено');
        }

       async function performAutoRefresh() {
           console.log('🎬 [AFK] performAutoRefresh викликано');

           const toggle = document.getElementById('autoRefreshToggle');
           if (!isAutoRefreshActive) {
               console.warn('⚠️ [AFK] isAutoRefreshActive = false, вихід');
               return;
           }
           if (!toggle) {
               console.warn('⚠️ [AFK] toggle не знайдено, вихід');
               return;
           }
           if (!toggle.checked) {
               console.warn('⚠️ [AFK] toggle.checked = false, вихід');
               return;
           }

           console.log('✅ [AFK] Всі перевірки пройдено, намагаюсь отримати lock...');


           // 🌍 Skip if geo toggle operation is running (prevents server overload)
           if (window._geoRunning) {
               console.warn('⚠️ [AFK] Auto-refresh пропущено: geo toggle операція активна, спробую наступного разу');
               return;
           }
           // 🔒 Перевірка глобального lock (silent mode для АФК)
           if (!acquireLock('AFK режим: автооновлення', true)) {
               console.warn('⚠️ [AFK] Auto-refresh пропущено: зайнята інша операція (lock), спробую наступного разу');
               return;
           }

           console.log('✅ [AFK] Lock отримано, починаю оновлення...');

           const uniqueSelected = getUniqueSelectedAdaccounts();
           console.log(`📊 [AFK] uniqueSelected: ${uniqueSelected.length} кабінетів:`, uniqueSelected);

            const activeCabinets = cabinetsToUpdate.size === 0
                ? uniqueSelected
                : uniqueSelected.filter(id => cabinetsToUpdate.has(id));
            console.log(`📊 [AFK] activeCabinets після фільтру cabinetsToUpdate: ${activeCabinets.length} кабінетів`);

            // Фільтруємо кабінети які на паузі (не оновлюємо їх в АФК режимі)
            const notPaused = activeCabinets.filter(id => !cabinetsPaused.has(id));

            // ⚡ ОПТИМІЗАЦІЯ: пропускаємо кабінети без активних КАМПАНІЙ
            // Адсети можуть вмикатись/вимикатись авторулами — це нормально.
            // Але якщо ВСІ кампанії кабінету PAUSED — оновлювати нема чого.
            const cabinetsToRefresh = notPaused.filter(id => {
                if (!window.lastResults || !window.lastResults.length) return true;
                const normalizedId = normalizeCabinetId(id);
                const cabinetRows = window.lastResults.filter(r => getRowCabinetId(r) === normalizedId);
                if (!cabinetRows.length) return true;
                const hasActiveCampaign = cabinetRows.some(r => {
                    var cs = (r.campaign_status || r.campaign_effective_status || '').toUpperCase();
                    return cs === 'ACTIVE';
                });
                if (!hasActiveCampaign) {
                    console.log(`⏭️ [AFK] Пропущено кабінет ${id} — всі кампанії PAUSED`);
                }
                return hasActiveCampaign;
            });

            const pausedCount = activeCabinets.length - notPaused.length;
            const skippedNoActive = notPaused.length - cabinetsToRefresh.length;

            console.log(`📊 [AFK] cabinetsToRefresh: ${cabinetsToRefresh.length} кабінетів (з активними кампаніями)`);
            console.log(`⏸️ [AFK] paused: ${pausedCount}, без активних кампаній: ${skippedNoActive}`);

            if (pausedCount > 0) {
                console.log(`⏸️ Пропущено ${pausedCount} кабінетів на паузі`);
            }

            if (cabinetsToRefresh.length === 0) {
                releaseLock();
                console.error('❌ [AFK] Auto-refresh зупинено: cabinetsToRefresh.length === 0');
                console.error(`   uniqueSelected: ${uniqueSelected.length}`);
                console.error(`   activeCabinets: ${activeCabinets.length}`);
                console.error(`   pausedCount: ${pausedCount}`);
                showNotification('⚠️ Всі кабінети на паузі для АФК режиму або не вибрано жодного');
                return;
            }

            setLastRequestedCabinets(activeCabinets);
            renderAllCabinetsSection();

            console.log(`🔄 [AFK] Виконую автоматичне оновлення (${cabinetsToRefresh.length} кабінетів, ${pausedCount} на паузі)...`);

            const dateInput = document.getElementById('dateInput');
            if (!dateInput) {
                releaseLock();
                console.error('❌ [AFK] dateInput не знайдено!');
                return;
            }
            const date = dateInput.value;
            console.log(`📅 [AFK] Дата для оновлення: ${date}`);

            try {
                // 🔄 Переходимо на Step 4 щоб бачити оновлення в real-time
                showStep(4);

                // 🚀 SMART BATCH PROCESSING: розумне батчування з пріоритетами
                console.log(`🚀 [AFK] Батчування ${cabinetsToRefresh.length} кабінетів (19 запитів/хв)...`);

                // Додаємо всі кабінети до черги
                cabinetsToRefresh.forEach(adId => {
                    queueManager.addRequest(adId, date, {quiet: true, skipCrm: true});
                });

                console.log(`📦 [AFK] Додано ${cabinetsToRefresh.length} кабінетів до черги`);

                // Обробляємо батчами по 19
                const allResults = [];
                while (queueManager.hasRequests()) {
                    const batchResults = await queueManager.processBatch();
                    allResults.push(...batchResults);

                    // Оновлюємо прогрес в UI
                    const processed = allResults.length;
                    busyOperation = `🚀 AFK: ${processed}/${cabinetsToRefresh.length} оброблено`;
                    updateGlobalStatusIndicator();
                }

                // Підраховуємо успішні оновлення
                const successCount = allResults.filter(r => r.status === 'fulfilled').length;

                console.log(`✅ [AFK] Батчування завершено: ${successCount}/${cabinetsToRefresh.length} успішно`);

                // ✅ Всі кабінети оновлено
                updateLastRefreshTime(new Date().toISOString());

                // Отримуємо фінальну статистику з вже оновлених даних
                const finalStats = window.lastResults ? recomputeStatsFromRows(window.lastResults) : {};

                // ✅ Оновлюємо міні-статистику на Кроці 4
                updateStats(finalStats);

                const statusMsg = pausedCount > 0
                    ? `✅ AFK оновлення завершено!\n📊 Оновлено: ${successCount}/${cabinetsToRefresh.length}\n⏸️ Пропущено (на паузі): ${pausedCount}\n💰 Кампаній з лідами: ${finalStats.with_leads || 0}\n⚠️ Без лідів: ${finalStats.no_leads || 0}`
                    : `✅ AFK оновлення завершено!\n📊 Оброблено: ${successCount}/${cabinetsToRefresh.length} кабінетів\n💰 Кампаній з лідами: ${finalStats.with_leads || 0}\n⚠️ Без лідів: ${finalStats.no_leads || 0}`;

                showNotification(statusMsg);
                console.log(`✅ Auto-refresh завершено: ${successCount}/${cabinetsToRefresh.length} кабінетів оновлено${pausedCount > 0 ? `, ${pausedCount} пропущено (на паузі)` : ''}`);

                // 🤖 Запускаємо автоправила після оновлення даних
                if (autoRulesV2Settings.global_enabled) {
                    console.log('🤖 Запуск автоправил після AFK оновлення...');
                    try {
                        await evaluateAutoRulesV2({notifyStart: true, source: 'auto-refresh'});
                    } catch (error) {
                        console.error('❌ Помилка виконання автоправил:', error);
                    }
                }
            } catch (error) {
                console.error('❌ Помилка auto-refresh:', error);
            } finally {
                // 🔓 Звільнюємо lock
                releaseLock();
            }
        }

        function stopAutoRefreshFromStep4() {
            // Зупиняємо auto-refresh
            isAutoRefreshActive = false;
            stopAutoRefresh();

            // Оновлюємо Step 3 toggle
            const toggle = document.getElementById('autoRefreshToggle');
            if (toggle) {
                toggle.checked = false;
            }

            // Ховаємо Step 3 status
            const statusDiv = document.getElementById('autoRefreshStatus');
            if (statusDiv) {
                statusDiv.style.display = 'none';
            }

            // Ховаємо Step 4 control
            const step4Control = document.getElementById('step4AutoRefreshControl');
            if (step4Control) {
                step4Control.style.display = 'none';
            }

            showNotification('⏹️ Auto-refresh зупинено');
            console.log('⏹️ Auto-refresh зупинено з Кроку 4');
        }

        function updateAutoRefreshStatus(intervalMinutes) {
            document.getElementById('autoRefreshStatusText').textContent =
                `🟢 Auto-refresh активний (кожні ${intervalMinutes} хв)`;

            // Показуємо Step 4 control якщо на Step 4
            updateStep4AutoRefreshControl(intervalMinutes);
        }

        function updateStep4AutoRefreshControl(intervalMinutes) {
            const step4Control = document.getElementById('step4AutoRefreshControl');
            const step4Info = document.getElementById('step4AutoRefreshInfo');
            const currentStep = document.querySelector('.step.active');

            if (step4Control && step4Info) {
                if (isAutoRefreshActive && currentStep && currentStep.id === 'step4') {
                    step4Control.style.display = 'block';
                    step4Info.textContent = `Оновлення кожні ${intervalMinutes} хв`;
                } else {
                    step4Control.style.display = 'none';
                }
            }
        }

        function updateNextRefreshTime(intervalMinutes) {
            // Це можна покращити, додавши реальний таймер до наступного оновлення
            const nextUpdate = document.getElementById('autoRefreshNextUpdate');
            nextUpdate.textContent = `Наступне оновлення через ${intervalMinutes} хв`;
        }

        function updateLastRefreshTime(timestamp = null) {
            const badge = document.getElementById('lastUpdateBadge');
            const timeEl = document.getElementById('lastUpdateTime');

            const sourceDate = timestamp ? new Date(timestamp) : new Date();
            const timeStr = Number.isNaN(sourceDate.getTime())
                ? new Date().toLocaleTimeString('uk-UA')
                : sourceDate.toLocaleTimeString('uk-UA');

            if (timeEl) {
                timeEl.textContent = timeStr;
            }
            if (badge) {
                badge.style.display = 'inline-block';
            }
        }

        // Inactive Cabinets Management
        function detectInactiveCabinets() {
            // Визначаємо які кабінети не дали результатів або заблоковані
            inactiveCabinetsData = [];
            // Якщо секція не присутня в макеті, просто виходимо
            if (!document.getElementById('inactiveCabinetsSection')) {
                return;
            }

            getUniqueSelectedAdaccounts().forEach(adId => {
                const adInfo = adaccounts.find(a => a.id === adId);
                if (!adInfo) return;

                // Перевіряємо чи є цей кабінет в результатах
                const hasResults = window.lastResults && window.lastResults.some(r => r.account_id === adId);

                // Кабінет вважається неактивним якщо:
                // 1. Заблокований (account_status != 1)
                // 2. Або не дав результатів (немає витрат/кампаній)
                const isDisabled = adInfo.account_status != 1;
                const noResults = !hasResults;

                if (isDisabled || noResults) {
                    let reason = '';
                    if (isDisabled) reason = '🚫 Заблокований';
                    else if (noResults) reason = '⚠️ Немає витрат';

                    inactiveCabinetsData.push({
                        id: adId,
                        name: adInfo.name,
                        account_name: adInfo.account_name || 'N/A',
                        reason: reason,
                        isDisabled: isDisabled
                    });
                }
            });

            renderInactiveCabinets();
        }

        function renderInactiveCabinets() {
            const section = document.getElementById('inactiveCabinetsSection');
            const list = document.getElementById('inactiveCabinetsList');
            if (!section || !list) return;

            if (inactiveCabinetsData.length === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = 'block';
            list.innerHTML = '';

            inactiveCabinetsData.forEach(cabinet => {
                const item = document.createElement('div');
                const borderColor = cabinet.isDisabled ? '#f44336' : '#ff9800'; // Червоний для заблокованих, помаранчевий для без витрат
                item.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 12px; margin: 8px 0; background: var(--bg-primary); border-radius: 8px; border-left: 4px solid ${borderColor};`;

                const isChecked = cabinetsToUpdate.size === 0 || cabinetsToUpdate.has(cabinet.id);

                item.innerHTML = `
                    <div style="display: flex; align-items: center; flex: 1;">
                        <input type="checkbox"
                               class="cabinet-checkbox"
                               data-cabinet-id="${cabinet.id}"
                               data-status="inactive"
                               ${isChecked ? 'checked' : ''}
                               onchange="toggleCabinetForUpdate('${cabinet.id}')"
                               style="margin-right: 12px; width: 18px; height: 18px; cursor: pointer;">
                        <div>
                            <strong style="color: var(--text-primary);">${cabinet.name}</strong>
                            <span style="margin-left: 10px; padding: 4px 8px; background: ${cabinet.isDisabled ? '#ffebee' : '#fff3e0'}; color: ${cabinet.isDisabled ? '#c62828' : '#e65100'}; border-radius: 4px; font-size: 12px;">
                                ${cabinet.reason}
                            </span>
                            <br>
                            <small style="color: var(--text-secondary);">ID: ${cabinet.id} | Профіль: ${cabinet.account_name}</small>
                        </div>
                    </div>
                `;

                list.appendChild(item);
            });
        }

        // Функції toggleCabinet, disableAllInactive, getActiveCabinets ВИДАЛЕНІ
        // disabledCabinets логіка більше не використовується

        // Навігація
        function showStep(stepNumber) {
            document.querySelectorAll('.step').forEach(step => step.classList.remove('active'));
            document.getElementById('step' + stepNumber).classList.add('active');

            // Оновлюємо Step 4 auto-refresh control при переході на кроки
            if (stepNumber === 4) {
                // Синхронізуємо кнопки на Кроці 4
                syncStep4Buttons();

                if (isAutoRefreshActive) {
                    const intervalInput = document.getElementById('autoRefreshInterval');
                    if (intervalInput) {
                        updateStep4AutoRefreshControl(parseInt(intervalInput.value));
                    }
                }
            } else {
                // Ховаємо control якщо не на Step 4
                const step4Control = document.getElementById('step4AutoRefreshControl');
                if (step4Control) {
                    step4Control.style.display = 'none';
                }
            }
        }

        function goToStep1() {
            showStep(1);
        }

        function goToStep2Direct() {
            // Прямий перехід на Крок 2 без перевірок (для навігації назад)
            showStep(2);
        }

        function goToStep3() {
            if (selectedAdaccounts.length === 0) {
                alert('⚠️ Спочатку виберіть хоча б один рекламний кабінет на Кроці 2!');
                return;
            }

            // FIX: clear paused on step3 re-pass
            clearCabinetsPausedState();
            // ✅ ВИПРАВЛЕННЯ: Синхронізуємо cabinetsToUpdate з поточним selectedAdaccounts
            // Видаляємо кабінети які більше не вибрані на Кроці 2
            const uniqueSelected = getUniqueSelectedAdaccounts();
            const currentSet = new Set(uniqueSelected);

            // Видаляємо старі кабінети які більше не в списку
            Array.from(cabinetsToUpdate).forEach(id => {
                if (!currentSet.has(id)) {
                    cabinetsToUpdate.delete(id);
                    console.log('🔍 goToStep3: видалено застарілий', id);
                }
            });

            // Додаємо нові кабінети
            uniqueSelected.forEach(id => {
                if (!cabinetsToUpdate.has(id)) {
                    cabinetsToUpdate.add(id);
                    console.log('🔍 goToStep3: додано новий', id);
                }
            });

            saveCabinetsToUpdateState();
            console.log('🔍 goToStep3: синхронізовано', cabinetsToUpdate.size, 'кабінетів');
            console.log('🔍   uniqueSelected:', uniqueSelected);
            console.log('🔍   cabinetsToUpdate:', Array.from(cabinetsToUpdate));

            showStep(3);
        }

        function goToStep4() {
            showStep(4);
        }

        // Управління вибором кабінетів для оновлення
        function toggleCabinetForUpdate(cabinetId) {
            if (cabinetsToUpdate.has(cabinetId)) {
                cabinetsToUpdate.delete(cabinetId);
                console.log(`🔍 Чекбокс: видалено ${cabinetId} з cabinetsToUpdate`);
            } else {
                cabinetsToUpdate.add(cabinetId);
                console.log(`🔍 Чекбокс: додано ${cabinetId} до cabinetsToUpdate`);
            }
            console.log(`🔍 Поточний стан cabinetsToUpdate (${cabinetsToUpdate.size}):`, Array.from(cabinetsToUpdate));
            saveCabinetsToUpdateState();
        }

        function toggleAllActiveCabinets(checked) {
            const activeCabinets = Array.from(document.querySelectorAll('.cabinet-checkbox[data-status="active"]'));
            activeCabinets.forEach(cb => {
                const cabinetId = cb.dataset.cabinetId;
                if (checked) {
                    cabinetsToUpdate.add(cabinetId);
                    cb.checked = true;
                } else {
                    cabinetsToUpdate.delete(cabinetId);
                    cb.checked = false;
                }
            });
            saveCabinetsToUpdateState();
        }

        function toggleAllInactiveCabinets(checked) {
            const inactiveCabinets = Array.from(document.querySelectorAll('.cabinet-checkbox[data-status="inactive"]'));
            inactiveCabinets.forEach(cb => {
                const cabinetId = cb.dataset.cabinetId;
                if (checked) {
                    cabinetsToUpdate.add(cabinetId);
                    cb.checked = true;
                } else {
                    cabinetsToUpdate.delete(cabinetId);
                    cb.checked = false;
                }
            });
            saveCabinetsToUpdateState();
        }

        function saveCabinetsToUpdateState() {
            const state = {
                cabinetsToUpdate: Array.from(cabinetsToUpdate),
                timestamp: Date.now()
            };
            localStorage.setItem('cabinetsToUpdate', JSON.stringify(state));
        }

        function loadCabinetsToUpdateState() {
            const saved = localStorage.getItem('cabinetsToUpdate');
            if (!saved) {
                console.log('🔍 loadCabinetsToUpdateState: немає збережених даних');
                return;
            }

            try {
                const state = JSON.parse(saved);
                if (Array.isArray(state.cabinetsToUpdate)) {
                    cabinetsToUpdate = new Set(state.cabinetsToUpdate);
                    console.log('🔍 loadCabinetsToUpdateState: завантажено', state.cabinetsToUpdate.length, 'кабінетів');
                    console.log('🔍   Список:', state.cabinetsToUpdate);
                }
            } catch (e) {
                console.error('Failed to load cabinetsToUpdate state:', e);
            }
        }

        function saveCabinetsPausedState() {
            const state = {
                cabinetsPaused: Array.from(cabinetsPaused),
                timestamp: Date.now()
            };
            localStorage.setItem('cabinetsPaused', JSON.stringify(state));
            console.log('⏸️ Збережено стан пауз:', cabinetsPaused.size, 'кабінетів');
        }

        function loadCabinetsPausedState() {
            const saved = localStorage.getItem('cabinetsPaused');
            if (!saved) {
                console.log('⏸️ loadCabinetsPausedState: немає збережених даних');
                return;
            }

            try {
                const state = JSON.parse(saved);
                if (Array.isArray(state.cabinetsPaused)) {
                    cabinetsPaused = new Set(state.cabinetsPaused);
                    console.log('⏸️ loadCabinetsPausedState: завантажено', state.cabinetsPaused.length, 'кабінетів на паузі');
                    console.log('⏸️   Список:', state.cabinetsPaused);
                }
            } catch (e) {
                console.error('Failed to load cabinetsPaused state:', e);
            }
        }

        function clearCabinetsPausedState() {
            cabinetsPaused.clear();
            localStorage.removeItem('cabinetsPaused');
            console.log('⏸️ Скинуто всі паузи');
        }

        window.unpauseCabinetForAfk = function(cabinetId) {
            if (cabinetsPaused.has(cabinetId)) {
                cabinetsPaused.delete(cabinetId);
                saveCabinetsPausedState();
                console.log('Un-paused cabinet ' + cabinetId + ' from AFK');
            }
        };

        function toggleCabinetPause(cabinetId) {
            if (cabinetsPaused.has(cabinetId)) {
                cabinetsPaused.delete(cabinetId);
                console.log('▶️ Кабінет знято з паузи:', cabinetId);
            } else {
                cabinetsPaused.add(cabinetId);
                console.log('⏸️ Кабінет поставлено на паузу:', cabinetId);
            }
            saveCabinetsPausedState();

            // Оновлюємо UI toggle
            updateCabinetPauseToggle(cabinetId);

            // 🔄 Перемальовуємо список щоб кабінет перемістився вверх/вниз
            rerenderActiveView();
        }

        function updateCabinetPauseToggle(cabinetId) {
            const toggle = document.getElementById(`pauseToggle_${cabinetId}`);
            if (toggle) {
                toggle.checked = !cabinetsPaused.has(cabinetId);
            }
        }

        // Утиліти
        function showLoading(text) {
            document.getElementById('loadingText').innerHTML = text;
            document.getElementById('loadingProgress').style.display = 'none';
            document.getElementById('loadingLog').style.display = 'none';
            document.getElementById('loadingLog').innerHTML = '';
            document.getElementById('loadingOverlay').style.display = 'block';
        }

        function showLoadingProgress(text, progress, total) {
            document.getElementById('loadingText').innerHTML = text;
            document.getElementById('loadingOverlay').style.display = 'block';

            const progressDiv = document.getElementById('loadingProgress');
            progressDiv.style.display = 'block';

            const progressBar = document.getElementById('progressBar');
            const progressText = document.getElementById('progressText');

            const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
            progressBar.style.width = percentage + '%';
            progressText.innerHTML = `${progress} / ${total} кабінетів (${percentage}%)`;

            // Показуємо лог
            document.getElementById('loadingLog').style.display = 'block';
        }

        function addLogMessage(message, type = 'info') {
            const logDiv = document.getElementById('loadingLog');
            const timestamp = new Date().toLocaleTimeString('uk-UA');

            let color = '#ffffff';
            let icon = '•';
            if (type === 'success') {
                color = '#4CAF50';
                icon = '✓';
            } else if (type === 'error') {
                color = '#f44336';
                icon = '✗';
            } else if (type === 'warning') {
                color = '#ff9800';
                icon = '⚠';
            } else if (type === 'info') {
                color = '#2196F3';
                icon = '○';
            }

            const logEntry = document.createElement('div');
            logEntry.style.marginBottom = '5px';
            logEntry.style.color = color;
            logEntry.innerHTML = `<span style="opacity: 0.6;">${timestamp}</span> ${icon} ${message}`;

            logDiv.appendChild(logEntry);
            logDiv.scrollTop = logDiv.scrollHeight; // Auto-scroll вниз
        }

        function hideLoading() {
            document.getElementById('loadingOverlay').style.display = 'none';
            document.getElementById('loadingProgress').style.display = 'none';
            document.getElementById('loadingLog').style.display = 'none';
            document.getElementById('loadingLog').innerHTML = '';
        }

        function showError(message) {
            alert('❌ ' + message);
        }

        function showNotification(message) {
            // Створюємо toast notification елемент
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
                        from {
                            transform: translateX(400px);
                            opacity: 0;
                        }
                        to {
                            transform: translateX(0);
                            opacity: 1;
                        }
                    }
                    @keyframes slideOutRight {
                        from {
                            transform: translateX(0);
                            opacity: 1;
                        }
                        to {
                            transform: translateX(400px);
                            opacity: 0;
                        }
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
            }, 5000);
        }

        // ============================================================================
        // АВТОПРАВИЛА - ФУНКЦІЇ
        // ============================================================================

        /**
         * Завантажити налаштування автоправил з сервера
         */
        async function loadAutoRulesV2Settings() {
            try {
                console.log('🔄 Завантаження налаштувань автоправил...');

                const response = await fetch('/api/auto-rules/settings');
                const data = await response.json();

                if (data.success && data.settings) {
                    const settings = data.settings;

                    // 🔄 ЗВОРОТНА СУМІСНІСТЬ: якщо немає default_rules, створюємо зі старої структури
                    if (!settings.default_rules) {
                        console.log('🔄 Міграція старих налаштувань на нову структуру...');
                        settings.default_rules = {
                            threshold_0_leads: settings.threshold_0_leads || 5.00,
                            threshold_1_lead: settings.threshold_1_lead || 7.00,
                            threshold_2_leads: settings.threshold_2_leads || 13.60,
                            threshold_3_leads: settings.threshold_3_leads || 18.00,
                            target_cpl_after_3: settings.target_cpl_after_3 || 5.00
                        };
                    }

                    // Якщо немає groups, створюємо порожній масив
                    if (!settings.groups) {
                        settings.groups = [];
                    }

                    autoRulesV2Settings = settings;

                    // Оновлюємо UI
                    updateAutoRulesV2UI();

                    console.log('✅ Налаштування автоправил завантажені:', autoRulesV2Settings);
                    showNotification('✅ Налаштування завантажені');
                } else {
                    console.error('❌ Помилка завантаження налаштувань');
                    showNotification('❌ Помилка завантаження налаштувань');
                }
            } catch (error) {
                console.error('❌ Помилка loadAutoRulesV2Settings:', error);
                showNotification('❌ Помилка завантаження');
            }
        }

        /**
         * Зберігає стан автоправил у файл для telegram_bot
         */
        function saveAutoRulesStateToFile() {
            const autoRulesState = {
                enabled_globally: autoRulesV2Settings.global_enabled || false,
                cabinets: {},
                last_update: new Date().toISOString()
            };

            // Збираємо стан для кожного кабінету
            const enabledCabinets = autoRulesV2Settings.cabinet_enabled || {};
            for (const cabinetId in enabledCabinets) {
                autoRulesState.cabinets[cabinetId] = {
                    enabled: enabledCabinets[cabinetId] || false
                };
            }

            fetch('/api/auto-rules-state', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(autoRulesState)
            }).then(response => response.json())
              .then(data => {
                  if (data.success) {
                      console.log('✅ Стан автоправил збережено для Telegram bot');
                  }
              })
              .catch(err => {
                  console.warn('⚠️ Не вдалося зберегти стан автоправил:', err);
              });
        }

        /**
         * Зберегти налаштування автоправил на сервер
         */
        async function saveAutoRulesV2Settings() {
            try {
                // Зчитуємо значення з UI для загальних правил
                autoRulesV2Settings.default_rules.threshold_0_leads = parseFloat(document.getElementById('threshold0Leads').value) || 5.00;
                autoRulesV2Settings.default_rules.threshold_1_lead = parseFloat(document.getElementById('threshold1Lead').value) || 7.00;
                autoRulesV2Settings.default_rules.threshold_2_leads = parseFloat(document.getElementById('threshold2Leads').value) || 13.60;
                autoRulesV2Settings.default_rules.threshold_3_leads = parseFloat(document.getElementById('threshold3Leads').value) || 18.00;
                autoRulesV2Settings.default_rules.target_cpl_after_3 = parseFloat(document.getElementById('targetCplAfter3').value) || 5.00;
                autoRulesV2Settings.cooldown_minutes = parseInt(document.getElementById('cooldownMinutes').value) || 15;

                console.log('💾 Збереження налаштувань автоправил...', autoRulesV2Settings);

                const response = await fetch('/api/auto-rules/settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({settings: autoRulesV2Settings})
                });

                const data = await response.json();

                if (data.success) {
                    console.log('✅ Налаштування збережені');
                    showNotification('✅ Налаштування збережені');

                    // Зберігаємо стан автоправил для Telegram bot
                    saveAutoRulesStateToFile();
                } else {
                    console.error('❌ Помилка збереження');
                    showNotification('❌ Помилка збереження');
                }
            } catch (error) {
                console.error('❌ Помилка saveAutoRulesV2Settings:', error);
                showNotification('❌ Помилка збереження');
            }
        }

        /**
         * Оновити UI з поточними налаштуваннями
         */
        function updateAutoRulesV2UI() {
            // Оновлюємо поля загальних правил
            const defaultRules = autoRulesV2Settings.default_rules || autoRulesV2Settings;
            document.getElementById('threshold0Leads').value = defaultRules.threshold_0_leads || 5.00;
            document.getElementById('threshold1Lead').value = defaultRules.threshold_1_lead || 7.00;
            document.getElementById('threshold2Leads').value = defaultRules.threshold_2_leads || 13.60;
            document.getElementById('threshold3Leads').value = defaultRules.threshold_3_leads || 18.00;
            document.getElementById('targetCplAfter3').value = defaultRules.target_cpl_after_3 || 5.00;
            document.getElementById('cooldownMinutes').value = autoRulesV2Settings.cooldown_minutes || 15;

            // Оновлюємо глобальний toggle
            const globalToggle = document.getElementById('autoRulesGlobalToggle');
            if (globalToggle) {
                globalToggle.checked = autoRulesV2Settings.global_enabled || false;
            }

            // Оновлюємо список кабінетів
            renderAutoRulesCabinetsList();

            // Показуємо/ховаємо статус-карту
            const statusCard = document.getElementById('autoRulesStatusCard');
            if (statusCard) {
                statusCard.style.display = autoRulesV2Settings.global_enabled ? 'block' : 'none';
            }

            updateAutoRulesInfoPanel();
        }

        /**
         * Додати запис до логів автоправил (у блоці статусу)
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
         * Оновити інформаційну панель (інфо по автоправилам)
         */
        function updateAutoRulesInfoPanel() {
            const panel = document.getElementById('autoRulesInfoContent');
            if (!panel) return;

            const totalCabinets = new Set(
                (window.lastResults || [])
                    .map(row => normalizeCabinetId(row.adaccount_id || row.account_id))
                    .filter(Boolean)
            ).size;

            const enabledCabinets = new Set(
                (window.lastResults || [])
                    .map(row => normalizeCabinetId(row.adaccount_id || row.account_id))
                    .filter(id => id && autoRulesV2Settings.cabinet_enabled[id] !== false)
            ).size;

            panel.innerHTML = `
                <div>Глобально: <strong>${autoRulesV2Settings.global_enabled ? 'Увімкнено' : 'Вимкнено'}</strong></div>
                <div>Кабінетів у даних: ${totalCabinets || 0}</div>
                <div>Кабінетів під автоправилами: ${enabledCabinets || 0}</div>
                <div>Cooldown (хв): ${autoRulesV2Settings.cooldown_minutes || 0}</div>
            `;
        }

        function toggleAutoRulesInfo() {
            const panel = document.getElementById('autoRulesInfoPanel');
            if (!panel) return;
            const willShow = panel.style.display === 'none' || panel.style.display === '';
            panel.style.display = willShow ? 'block' : 'none';
            if (willShow) {
                updateAutoRulesInfoPanel();
            }
        }

        /**
         * Відобразити список кабінетів з toggles
         */
        function renderAutoRulesCabinetsList() {
            const container = document.getElementById('autoRulesCabinetsList');
            if (!container) return;

            // Отримуємо унікальні кабінети з window.lastResults
            if (!window.lastResults || !Array.isArray(window.lastResults) || window.lastResults.length === 0) {
                container.innerHTML = `
                    <div style="color: var(--text-secondary); text-align: center; padding: 20px;">
                        Немає активних кабінетів. Спочатку зберіть дані (Крок 1-3).
                    </div>
                `;
                return;
            }

            // Збираємо унікальні кабінети
            const cabinets = new Map();
            for (const row of window.lastResults) {
                const cabinetId = row.adaccount_id || row.account_id;
                if (cabinetId && !cabinets.has(cabinetId)) {
                    cabinets.set(cabinetId, {
                        id: cabinetId,
                        // Використовуємо назву профілю FBtool замість назви БМ
                        name: row.profile_name || row.profile || row.fbtool_account_name || row.adaccount_name || cabinetId,
                        account_name: row.adaccount_name || row.account_name || cabinetId, // Для підказки
                        fbtool_account_id: row.fbtool_account_id
                    });
                }
            }

            if (cabinets.size === 0) {
                container.innerHTML = `
                    <div style="color: var(--text-secondary); text-align: center; padding: 20px;">
                        Немає активних кабінетів. Спочатку зберіть дані.
                    </div>
                `;
                return;
            }

            let html = '';

            // 🔒 cabinet enable consent state (memory-only, default OFF)
            window.cabinetEnableConsent = window.cabinetEnableConsent || {};

            for (const [cabinetId, cabinet] of cabinets) {
                const isEnabled = autoRulesV2Settings.cabinet_enabled[cabinetId] !== false; // За замовчуванням true
                const enableConsent = window.cabinetEnableConsent[cabinetId] === true;

                html += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 10px; background: var(--bg-secondary);">
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: var(--text-primary); font-size: 14px;">${cabinet.name}</div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
                                <span style="opacity: 0.7;">БМ:</span> ${cabinet.account_name || cabinetId}
                            </div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${cabinetId}</div>
                        </div>
                        <label title="Дозволити автоправилам ВКЛЮЧАТИ адсети цього кабінету. Без галки — лише вимкнення (по лімітам). Скидається на 00:00 за Києвом і при перезавантаженні." style="display:flex; align-items:center; gap:6px; margin-right:14px; padding:6px 10px; border:1px solid var(--border-color); border-radius:6px; background: var(--bg-primary); cursor:pointer; font-size:12px; font-weight:600; color: var(--text-primary); user-select:none;">
                            <input type="checkbox"
                                   id="cabinetEnableConsent_${cabinetId}"
                                   ${enableConsent ? 'checked' : ''}
                                   onchange="handleCabinetEnableConsentToggle('${cabinetId}', this.checked)"
                                   style="width:16px; height:16px; accent-color:#e94560; cursor:pointer; margin:0;">
                            <span>Довключення</span>
                        </label>
                        <label class="auto-rules-cabinet-toggle">
                            <input type="checkbox"
                                   id="cabinetToggle_${cabinetId}"
                                   ${isEnabled ? 'checked' : ''}
                                   onchange="handleCabinetToggle('${cabinetId}', this.checked)">
                            <span class="auto-rules-cabinet-toggle-slider"></span>
                        </label>
                    </div>
                `;
            }

            container.innerHTML = html;
        }

        // ============================================================================
        // ФУНКЦІЇ ДЛЯ РОБОТИ З ГРУПАМИ АВТОПРАВИЛ
        // ============================================================================

        /**
         * Перемикання вкладок між загальними правилами і групами
         */
        function switchRulesTab(tab) {
            const defaultPanel = document.getElementById('defaultRulesPanel');
            const groupsPanel = document.getElementById('groupsPanel');
            const defaultTab = document.getElementById('tabDefaultRules');
            const groupsTab = document.getElementById('tabGroups');

            if (tab === 'default') {
                defaultPanel.style.display = 'block';
                groupsPanel.style.display = 'none';
                defaultTab.style.borderBottom = '3px solid #667eea';
                defaultTab.style.color = '#667eea';
                defaultTab.style.fontWeight = '600';
                groupsTab.style.borderBottom = '3px solid transparent';
                groupsTab.style.color = '#6b7280';
                groupsTab.style.fontWeight = '500';
            } else {
                defaultPanel.style.display = 'none';
                groupsPanel.style.display = 'block';
                defaultTab.style.borderBottom = '3px solid transparent';
                defaultTab.style.color = '#6b7280';
                defaultTab.style.fontWeight = '500';
                groupsTab.style.borderBottom = '3px solid #667eea';
                groupsTab.style.color = '#667eea';
                groupsTab.style.fontWeight = '600';
            }

            if (tab === 'groups') {
                renderGroupsList();
            }
        }

        /**
         * Отримання правил для конкретного кабінету
         */
        function getRulesForCabinet(cabinetId) {
            // Шукаємо чи кабінет в якійсь групі
            for (const group of autoRulesV2Settings.groups || []) {
                if (group.cabinets && group.cabinets.includes(cabinetId)) {
                    console.log(`📁 Кабінет ${cabinetId} використовує правила групи "${group.name}"`);
                    return group.rules;
                }
            }
            console.log(`⚙️ Кабінет ${cabinetId} використовує загальні правила`);
            // Зворотна сумісність: якщо немає default_rules, використовуємо старі поля
            return autoRulesV2Settings.default_rules || autoRulesV2Settings;
        }

        /**
         * Відображення списку груп
         */
        function renderGroupsList() {
            const container = document.getElementById('groupsList');
            if (!container) return;

            if (!autoRulesV2Settings.groups || autoRulesV2Settings.groups.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
                        <div style="font-size: 48px; margin-bottom: 16px;">📂</div>
                        <div style="font-size: 16px; margin-bottom: 8px;">Немає створених груп</div>
                        <div style="font-size: 14px;">Створіть групу щоб застосувати окремі правила до певних кабінетів</div>
                    </div>
                `;
                return;
            }

            let html = '';
            autoRulesV2Settings.groups.forEach((group, index) => {
                const cabinetsCount = group.cabinets ? group.cabinets.length : 0;
                html += `
                    <div style="border: 2px solid var(--border-color); border-radius: 12px; padding: 16px; margin-bottom: 16px; background: var(--bg-secondary);">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                            <div>
                                <h4 style="margin: 0 0 8px 0; color: var(--text-primary); font-size: 16px;">📁 ${group.name}</h4>
                                <div style="font-size: 13px; color: var(--text-secondary);">
                                    Кабінетів: ${cabinetsCount}
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button onclick="editGroup(${index})" class="btn btn-secondary" style="padding: 6px 12px; font-size: 13px;">
                                    ✏️ Редагувати
                                </button>
                                <button onclick="deleteGroup(${index})" class="btn btn-secondary" style="padding: 6px 12px; font-size: 13px; background: #dc2626; color: white;">
                                    🗑️ Видалити
                                </button>
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; font-size: 12px; color: var(--text-primary); background: var(--bg-primary); padding: 12px; border-radius: 8px;">
                            <div><strong>0 лідів:</strong> $${group.rules.threshold_0_leads}</div>
                            <div><strong>1 лід:</strong> $${group.rules.threshold_1_lead}</div>
                            <div><strong>2 ліди:</strong> $${group.rules.threshold_2_leads}</div>
                            <div><strong>3 ліди:</strong> $${group.rules.threshold_3_leads}</div>
                            <div><strong>CPL (4+):</strong> $${group.rules.target_cpl_after_3}</div>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        /**
         * Відкриття модального вікна для створення групи
         */
        function openCreateGroupModal() {
            const modal = document.getElementById('groupModal');
            const modalTitle = document.getElementById('groupModalTitle');
            const groupNameInput = document.getElementById('groupNameInput');

            modalTitle.textContent = '➕ Створити нову групу';
            groupNameInput.value = '';

            // Очищаємо правила (заповнимо загальними)
            document.getElementById('groupThreshold0').value = autoRulesV2Settings.default_rules.threshold_0_leads;
            document.getElementById('groupThreshold1').value = autoRulesV2Settings.default_rules.threshold_1_lead;
            document.getElementById('groupThreshold2').value = autoRulesV2Settings.default_rules.threshold_2_leads;
            document.getElementById('groupThreshold3').value = autoRulesV2Settings.default_rules.threshold_3_leads;
            document.getElementById('groupTargetCpl').value = autoRulesV2Settings.default_rules.target_cpl_after_3;

            // Відображаємо список кабінетів для вибору
            renderCabinetsSelector();

            modal.dataset.editIndex = '';
            modal.style.display = 'flex';
        }

        /**
         * Редагування існуючої групи
         */
        function editGroup(index) {
            const group = autoRulesV2Settings.groups[index];
            const modal = document.getElementById('groupModal');
            const modalTitle = document.getElementById('groupModalTitle');

            modalTitle.textContent = '✏️ Редагувати групу';
            document.getElementById('groupNameInput').value = group.name;
            document.getElementById('groupThreshold0').value = group.rules.threshold_0_leads;
            document.getElementById('groupThreshold1').value = group.rules.threshold_1_lead;
            document.getElementById('groupThreshold2').value = group.rules.threshold_2_leads;
            document.getElementById('groupThreshold3').value = group.rules.threshold_3_leads;
            document.getElementById('groupTargetCpl').value = group.rules.target_cpl_after_3;

            renderCabinetsSelector(group.cabinets);

            modal.dataset.editIndex = index;
            modal.style.display = 'flex';
        }

        /**
         * Видалення групи
         */
        function deleteGroup(index) {
            const group = autoRulesV2Settings.groups[index];
            if (!confirm(`Видалити групу "${group.name}"?\n\nКабінети з цієї групи почнуть використовувати загальні правила.`)) {
                return;
            }

            autoRulesV2Settings.groups.splice(index, 1);
            saveAutoRulesV2Settings();
            renderGroupsList();
            showNotification('✅ Групу видалено');
        }

        /**
         * Збереження групи (створення або оновлення)
         */
        function saveGroup() {
            const modal = document.getElementById('groupModal');
            const name = document.getElementById('groupNameInput').value.trim();

            if (!name) {
                alert('Введіть назву групи!');
                return;
            }

            // Збираємо вибрані кабінети
            const selectedCabinets = [];
            document.querySelectorAll('#cabinetsSelectorList input[type="checkbox"]:checked').forEach(checkbox => {
                selectedCabinets.push(checkbox.value);
            });

            if (selectedCabinets.length === 0) {
                alert('Виберіть хоча б один кабінет для групи!');
                return;
            }

            // Збираємо правила
            const rules = {
                threshold_0_leads: parseFloat(document.getElementById('groupThreshold0').value),
                threshold_1_lead: parseFloat(document.getElementById('groupThreshold1').value),
                threshold_2_leads: parseFloat(document.getElementById('groupThreshold2').value),
                threshold_3_leads: parseFloat(document.getElementById('groupThreshold3').value),
                target_cpl_after_3: parseFloat(document.getElementById('groupTargetCpl').value)
            };

            const editIndex = modal.dataset.editIndex;

            if (editIndex !== '') {
                // Редагування існуючої групи
                autoRulesV2Settings.groups[editIndex] = {
                    id: autoRulesV2Settings.groups[editIndex].id,
                    name: name,
                    cabinets: selectedCabinets,
                    rules: rules
                };
                showNotification('✅ Групу оновлено');
            } else {
                // Створення нової групи
                const newGroup = {
                    id: 'group_' + Date.now(),
                    name: name,
                    cabinets: selectedCabinets,
                    rules: rules
                };
                autoRulesV2Settings.groups.push(newGroup);
                showNotification('✅ Групу створено');
            }

            saveAutoRulesV2Settings();
            renderGroupsList();
            closeGroupModal();
        }

        /**
         * Закриття модального вікна
         */
        function closeGroupModal() {
            document.getElementById('groupModal').style.display = 'none';
        }

        /**
         * Відображення селектора кабінетів в модальному вікні
         */
        function renderCabinetsSelector(selectedCabinets = []) {
            const container = document.getElementById('cabinetsSelectorList');
            if (!container) return;

            if (!window.lastResults || window.lastResults.length === 0) {
                container.innerHTML = '<div style="color: var(--text-secondary); padding: 20px;">Спочатку зберіть дані (Крок 1-3)</div>';
                return;
            }

            // Збираємо унікальні кабінети
            const cabinets = new Map();
            for (const row of window.lastResults) {
                const cabinetId = row.adaccount_id || row.account_id;
                if (cabinetId && !cabinets.has(cabinetId)) {
                    cabinets.set(cabinetId, {
                        id: cabinetId,
                        name: row.profile_name || row.profile || row.adaccount_name || cabinetId
                    });
                }
            }

            let html = '';
            for (const [cabinetId, cabinet] of cabinets) {
                const isChecked = selectedCabinets.includes(cabinetId);
                html += `
                    <label style="display: flex; align-items: center; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px; cursor: pointer; background: ${isChecked ? '#f0f9ff' : 'white'};">
                        <input type="checkbox" value="${cabinetId}" ${isChecked ? 'checked' : ''} style="margin-right: 10px;">
                        <div>
                            <div style="font-weight: 500; font-size: 14px;">${cabinet.name}</div>
                            <div style="font-size: 11px; color: var(--text-secondary);">${cabinetId}</div>
                        </div>
                    </label>
                `;
            }

            container.innerHTML = html;
        }

        /**
         * Обробник глобального toggle
         */
        function handleAutoRulesGlobalToggle(enabled) {
            autoRulesV2Settings.global_enabled = enabled;
            saveAutoRulesV2Settings();

            console.log(`🔄 Глобальні автоправила: ${enabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}`);
            showNotification(enabled ? '✅ Автоправила увімкнено' : '⏸️ Автоправила вимкнено');

            // Показати/сховати статус
            const statusCard = document.getElementById('autoRulesStatusCard');
            if (statusCard) {
                statusCard.style.display = enabled ? 'block' : 'none';
            }

            // Якщо вимикаємо – повідомляємо бекенд (Telegram)
            if (!enabled) {
                fetch('/api/auto-rules/notify', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({type: 'stop', meta: {timestamp: Date.now()}})
                }).catch(() => {});
            }
        }

        /**
         * Обробник toggle кабінету
         */
        function handleCabinetToggle(cabinetId, enabled) {
            autoRulesV2Settings.cabinet_enabled[cabinetId] = enabled;
            saveAutoRulesV2Settings();

            console.log(`🔄 Кабінет ${cabinetId}: ${enabled ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}`);
            showNotification(enabled ? `✅ Кабінет увімкнено` : `⏸️ Кабінет вимкнено`);
        }

        /**
         * Перевірити чи треба вимкнути adset (disable rule)
         */
        function checkAdsetDisableRule(adset, cabinetId) {
            const leads = parseInt(adset.leads) || 0;
            const spend = parseFloat(adset.spend) || 0;

            // Отримуємо правила для конкретного кабінету (або загальні)
            const rules = getRulesForCabinet(cabinetId);

            // Правила для 0-3 лідів
            if (leads === 0) {
                const threshold = rules.threshold_0_leads;
                if (spend >= threshold) {
                    return {
                        shouldDisable: true,
                        reason: `0 лідів при spend $${spend.toFixed(2)}`,
                        threshold: threshold
                    };
                }
            } else if (leads === 1) {
                const threshold = rules.threshold_1_lead;
                if (spend >= threshold) {
                    return {
                        shouldDisable: true,
                        reason: `1 лід при spend $${spend.toFixed(2)}`,
                        threshold: threshold
                    };
                }
            } else if (leads === 2) {
                const threshold = rules.threshold_2_leads;
                if (spend >= threshold) {
                    return {
                        shouldDisable: true,
                        reason: `2 ліди при spend $${spend.toFixed(2)}`,
                        threshold: threshold
                    };
                }
            } else if (leads === 3) {
                const threshold = rules.threshold_3_leads;
                if (spend >= threshold) {
                    return {
                        shouldDisable: true,
                        reason: `3 ліди при spend $${spend.toFixed(2)}`,
                        threshold: threshold
                    };
                }
            } else if (leads >= 4) {
                // Правило для 4+ лідів (CPL з 5% запасом)
                const cpl = spend / leads;
                const targetCpl = rules.target_cpl_after_3;
                const maxCpl = targetCpl * 1.05; // 5% запас

                if (cpl > maxCpl) {
                    return {
                        shouldDisable: true,
                        reason: `${leads} лідів, CPL $${cpl.toFixed(2)} > $${maxCpl.toFixed(2)}`,
                        threshold: maxCpl
                    };
                }
            }

            return {shouldDisable: false, reason: 'В межах норми', threshold: 0};
        }

        /**
         * Перевірити чи треба ввімкнути adset (enable rule)
         */
        function checkAdsetEnableRule(adset, cabinetId) {
            const leads = parseInt(adset.leads) || 0;
            const spend = parseFloat(adset.spend) || 0;

            if (leads < 1) {
                return {shouldEnable: false, reason: 'Немає лідів'};
            }

            if (spend <= 0) {
                return {shouldEnable: false, reason: 'Немає спенду'};
            }

            // Отримуємо правила для конкретного кабінету (або загальні)
            const rules = getRulesForCabinet(cabinetId);

            const cpl = spend / leads;
            const targetCpl = rules.target_cpl_after_3;

            if (cpl < targetCpl) {
                return {
                    shouldEnable: true,
                    reason: `CPL $${cpl.toFixed(2)} < $${targetCpl.toFixed(2)}`
                };
            }

            return {
                shouldEnable: false,
                reason: `CPL $${cpl.toFixed(2)} >= $${targetCpl.toFixed(2)}`
            };
        }

        /**
         * Перевірити cooldown для adset
         */
        function checkAdsetCooldown(adsetId) {
            const lastDisabledAt = autoRulesV2Settings.adset_disabled_at[adsetId];

            if (!lastDisabledAt) {
                return {inCooldown: false, remainingMinutes: 0};
            }

            const now = Date.now();
            const elapsed = (now - lastDisabledAt) / 1000 / 60; // хвилини
            const cooldownMinutes = autoRulesV2Settings.cooldown_minutes || 15;

            if (elapsed < cooldownMinutes) {
                return {
                    inCooldown: true,
                    remainingMinutes: Math.ceil(cooldownMinutes - elapsed)
                };
            }

            return {inCooldown: false, remainingMinutes: 0};
        }

        /**
         * Встановити cooldown для adset
         */
        function setAdsetCooldown(adsetId) {
            autoRulesV2Settings.adset_disabled_at[adsetId] = Date.now();
            saveAutoRulesV2Settings();
        }

        /**
         * Надіслати Telegram notification через backend
         */
        async function sendTelegramNotification(type, adset, cabinet, reason, threshold = 0) {
            try {
                const cpl = adset.leads > 0 ? adset.spend / adset.leads : 0;

                const notificationData = {
                    type: type, // 'disable' or 'enable'
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
                        target_cpl: autoRulesV2Settings.target_cpl_after_3,
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
                    console.log(`📱 Telegram notification надіслано (${type})`);
                } else {
                    console.warn(`⚠️ Telegram notification не надіслано: ${data.error || 'Unknown'}`);
                }
            } catch (error) {
                console.error(`❌ Помилка sendTelegramNotification:`, error);
            }
        }

        /**
         * Вимкнути adset
         */
        async function disableAdset(adset, cabinet, reason, threshold) {
            try {
                console.log(`⏸️ Вимикаю adset ${adset.id}... Причина: ${reason}`);

                // Отримуємо fbtool_account_id з кабінету
                const fbtoolAccountId = cabinet.fbtool_account_id;
                const cabinetId = cabinet.id;
                const normalizedAccountId = cabinetId.replace('act_', '');

                if (!fbtoolAccountId) {
                    console.error(`❌ Не знайдено fbtool_account_id для кабінету ${cabinetId}`);
                    return false;
                }

                // Викликаємо API для вимкнення adset
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
                    // Встановлюємо cooldown
                    setAdsetCooldown(adset.id);

                    // Додаємо до списку вимкнених
                    autoRulesV2DisabledAdsets.add(adset.id);

                    // Оновлюємо статус локально
                    updateAdsetStatusLocally(String(adset.id), String(cabinetId), 'PAUSED');

                    console.log(`✅ Adset ${adset.id} вимкнено (${reason})`);
                    showNotification(`⏸️ Adset вимкнено: ${adset.name || adset.id}`);

                    // Надсилаємо Telegram notification (не блокуємо виконання)
                    sendTelegramNotification('disable', adset, cabinet, reason, threshold).catch(err => {
                        console.warn('Telegram notification failed:', err);
                    });

                    return true;
                } else {
                    console.error(`❌ Помилка API: ${data.error || 'Unknown'}`);
                    return false;
                }
            } catch (error) {
                console.error(`❌ Помилка disableAdset:`, error);
                return false;
            }
        }

        /**
         * Увімкнути adset
         */
        async function enableAdset(adset, cabinet, reason) {
            try {
                console.log(`▶️ Вмикаю adset ${adset.id}... Причина: ${reason}`);

                // Отримуємо fbtool_account_id з кабінету
                const fbtoolAccountId = cabinet.fbtool_account_id;
                const cabinetId = cabinet.id;
                const normalizedAccountId = cabinetId.replace('act_', '');

                if (!fbtoolAccountId) {
                    console.error(`❌ Не знайдено fbtool_account_id для кабінету ${cabinetId}`);
                    return false;
                }

                // Викликаємо API для ввімкнення adset
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
                    // Встановлюємо cooldown
                    setAdsetCooldown(adset.id);

                    // Видаляємо зі списку вимкнених
                    autoRulesV2DisabledAdsets.delete(adset.id);

                    // Оновлюємо статус локально
                    updateAdsetStatusLocally(String(adset.id), String(cabinetId), 'ACTIVE');

                    console.log(`✅ Adset ${adset.id} увімкнено (${reason})`);
                    showNotification(`▶️ Adset увімкнено: ${adset.name || adset.id}`);

                    // Надсилаємо Telegram notification (не блокуємо виконання)
                    sendTelegramNotification('enable', adset, cabinet, reason).catch(err => {
                        console.warn('Telegram notification failed:', err);
                    });

                    return true;
                } else {
                    console.error(`❌ Помилка API: ${data.error || 'Unknown'}`);
                    return false;
                }
            } catch (error) {
                console.error(`❌ Помилка enableAdset:`, error);
                return false;
            }
        }

        /**
         * Перевіряє чи CRM кеш свіжий (не застарілий)
         * Повертає: {fresh: true/false, age_minutes: number, ttl_minutes: number}
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

        /**
         * Основна функція перевірки автоправил для всіх adsets
         * Викликається періодично з АФК режиму
         */
        async function evaluateAutoRulesV2(options = {}) {
            const {notifyStart = false, source = 'manual'} = options;

            // Захист від паралельних запусків
            if (autoRulesV2Running) {
                appendAutoRulesLog('Пропуск запуску: попередня перевірка ще триває', 'warn');
                return;
            }

            // Перевірка чи увімкнено глобально
            if (!autoRulesV2Settings.global_enabled) {
                console.log('⏸️ Автоправила вимкнено глобально');
                appendAutoRulesLog('Спроба запуску, але автоправила вимкнені глобально', 'warn');
                return;
            }

            // Використовуємо window.lastResults (масив рядків з даними)
            if (!window.lastResults || !Array.isArray(window.lastResults) || window.lastResults.length === 0) {
                console.log('⚠️ Немає даних для перевірки (window.lastResults пусті)');
                appendAutoRulesLog('Немає даних для перевірки. Спочатку оновіть статистику.', 'warn');
                return;
            }

            // ✅ Перевірка свіжості CRM кешу перед виконанням автоправил
            const crmFreshness = await checkCrmCacheFreshness();
            if (!crmFreshness.fresh) {
                const errorMsg = crmFreshness.error ||
                    `CRM кеш застарілий (${crmFreshness.age_minutes?.toFixed(1)} хв > ${crmFreshness.ttl_minutes} хв TTL)`;

                console.warn(`⚠️ Автоправила ПРОПУЩЕНО: ${errorMsg}`);
                appendAutoRulesLog(`⚠️ Автоправила пропущено — ${errorMsg}`, 'error');

                // Відправляємо Telegram сповіщення
                try {
                    const timestamp = new Date().toLocaleTimeString('uk-UA');
                    await fetch('/api/send-telegram-alert', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            message: `⏰ <b>${timestamp}</b>\n\n` +
                                     `⚠️ <b>Автоправила ПРОПУЩЕНО</b>\n\n` +
                                     `CRM кеш застарілий:\n` +
                                     `• Вік кешу: <b>${crmFreshness.age_minutes?.toFixed(1)} хв</b>\n` +
                                     `• TTL: <b>${crmFreshness.ttl_minutes} хв</b>\n` +
                                     `• Статус: <b>${crmFreshness.error || 'Застарілий'}</b>\n\n` +
                                     `Немає свіжих даних про ліди для прийняття рішень.`,
                            alert_key: 'autorules_crm_stale',
                            silent: false
                        })
                    });
                } catch (telegramError) {
                    console.error('Помилка відправки Telegram сповіщення:', telegramError);
                }

                return; // Зупиняємо виконання автоправил
            }

            console.log(`✅ CRM кеш свіжий (${crmFreshness.age_minutes?.toFixed(1)} хв, TTL: ${crmFreshness.ttl_minutes} хв)`);

            autoRulesV2Running = true;

            try {
                console.log(`🤖 Запуск автоправил (source: ${source})...`);
                appendAutoRulesLog(`Старт перевірки (${source}) — готую дані...`, 'info');

                let skippedCount = 0;

                // Групуємо дані по кабінетах
                const cabinetGroups = new Map();
                for (const row of window.lastResults) {
                    const cabinetId = row.adaccount_id || row.account_id;
                    if (!cabinetId) continue;

                    if (!cabinetGroups.has(cabinetId)) {
                        cabinetGroups.set(cabinetId, {
                            id: cabinetId,
                            name: row.adaccount_name || row.account_name || cabinetId,
                            fbtool_account_id: row.fbtool_account_id,
                            rows: []
                        });
                    }
                    cabinetGroups.get(cabinetId).rows.push(row);
                }

                // 🚀 ПАРАЛЕЛЬНА ОБРОБКА: збираємо всі операції в масив Promise
                const operations = [];

                // Проходимо по всіх кабінетах
                for (const [cabinetId, cabinet] of cabinetGroups) {
                    // Перевіряємо чи увімкнено для цього кабінету
                    if (autoRulesV2Settings.cabinet_enabled[cabinetId] === false) {
                        console.log(`⏭️ Пропущено кабінет ${cabinetId} (вимкнено в автоправилах)`);
                        skippedCount++;
                        continue;
                    }

                    // ✅ Перевіряємо чи кабінет на паузі АФК - тоді автоправила теж не працюють
                    if (cabinetsPaused.has(cabinetId)) {
                        console.log(`⏸️ Пропущено кабінет ${cabinetId} (на паузі АФК)`);
                        skippedCount++;
                        continue;
                    }

                    // Проходимо по всіх рядках і їх adsets
                    for (const row of cabinet.rows) {
                        const campaignName = row.campaign_name || row.campaign || '';
                        const adsets = Array.isArray(row.adsets) ? row.adsets : (row.adset_id ? [row] : []);

                        for (const adsetEntry of adsets) {
                            const adsetId = adsetEntry.id || adsetEntry.adset_id || adsetEntry.adsetId;
                            if (!adsetId) continue; // Пропускаємо рядки без adset_id

                            // Створюємо об'єкт adset з даних adsetEntry
                            const adset = {
                                id: adsetId,
                                name: adsetEntry.name || adsetEntry.adset_name || adsetId,
                                status: adsetEntry.status || adsetEntry.ad_status,
                                effective_status: adsetEntry.effective_status || adsetEntry.ad_effective_status,
                                spend: parseFloat(adsetEntry.spend || 0) || 0,
                                leads: parseInt(adsetEntry.leads || 0) || 0,
                                campaign_name: campaignName
                            };

                            // Перевіряємо cooldown
                            const cooldown = checkAdsetCooldown(adset.id);
                            if (cooldown.inCooldown) {
                                console.log(`⏳ Adset ${adset.id} в cooldown (${cooldown.remainingMinutes} хв)`);
                                skippedCount++;
                                continue;
                            }

                            // Перевіряємо статус adset
                            const isActive = adset.status === 'ACTIVE' || adset.effective_status === 'ACTIVE';

                            if (isActive) {
                                // Перевіряємо чи треба вимкнути
                                const disableCheck = checkAdsetDisableRule(adset, cabinetId);
                                if (disableCheck.shouldDisable) {
                                    console.log(`🔴 Adset ${adset.id}: ${disableCheck.reason}`);
                                    // Додаємо Promise в масив замість await
                                    operations.push({
                                        type: 'disable',
                                        promise: disableAdset(adset, cabinet, disableCheck.reason, disableCheck.threshold),
                                        adsetId: adset.id
                                    });
                                }
                            } else {
                                // 🔒 ENABLE-CONSENT GATE: enable працює лише якщо юзер поставив "Довключення" на кабінет
                                const consentMap = window.cabinetEnableConsent || {};
                                if (consentMap[cabinetId] !== true) {
                                    // Без галки — enable НІКОЛИ не виконується для цього кабінету
                                    skippedCount++;
                                    continue;
                                }
                                // Перевіряємо чи треба ввімкнути
                                const enableCheck = checkAdsetEnableRule(adset, cabinetId);
                                if (enableCheck.shouldEnable) {
                                    console.log(`🟢 Adset ${adset.id}: ${enableCheck.reason}`);
                                    // Додаємо Promise в масив замість await
                                    operations.push({
                                        type: 'enable',
                                        promise: enableAdset(adset, cabinet, enableCheck.reason),
                                        adsetId: adset.id
                                    });
                                }
                            }
                        }
                    }
                }

                // 🚀 Виконуємо всі операції ПАРАЛЕЛЬНО
                let disabledCount = 0;
                let enabledCount = 0;

                if (operations.length > 0) {
                    console.log(`🚀 Запускаю ${operations.length} операцій паралельно...`);

                    // Виконуємо всі Promise паралельно
                    const promises = operations.map(op => op.promise);
                    const results = await Promise.allSettled(promises);

                    // Підраховуємо результати
                    let successCount = 0;
                    let failedCount = 0;

                    results.forEach((result, index) => {
                        const operation = operations[index];

                        if (result.status === 'fulfilled' && result.value === true) {
                            successCount++;
                            // Рахуємо disable/enable окремо
                            if (operation.type === 'disable') {
                                disabledCount++;
                            } else if (operation.type === 'enable') {
                                enabledCount++;
                            }
                        } else {
                            failedCount++;
                            if (result.status === 'rejected') {
                                console.error(`❌ Операція failed (${operation.type} ${operation.adsetId}):`, result.reason);
                            }
                        }
                    });

                    console.log(`✅ Паралельні операції завершені: ${successCount} успішно, ${failedCount} з помилками`);
                    appendAutoRulesLog(`Виконано ${operations.length} операцій: успішно ${disabledCount + enabledCount}, з помилками ${operations.length - (disabledCount + enabledCount)}`, 'info');
                } else {
                    appendAutoRulesLog('Операцій немає: всі adsets пропущено або в cooldown', 'warn');
                }

                console.log(`✅ Автоправила завершено: ${disabledCount} вимкнено, ${enabledCount} увімкнено, ${skippedCount} пропущено`);
                appendAutoRulesLog(`Фініш: вимкнено ${disabledCount}, увімкнено ${enabledCount}, пропущено ${skippedCount} (source: ${source})`, 'success');

                // Оновлюємо статус
                const statusText = document.getElementById('autoRulesStatusText');
                if (statusText) {
                    const now = new Date().toLocaleTimeString('uk-UA');
                    statusText.textContent = `Остання перевірка: ${now} | ${disabledCount} вимкнено, ${enabledCount} увімкнено, ${skippedCount} пропущено`;
                }

                if (disabledCount > 0 || enabledCount > 0) {
                    showNotification(`✅ Автоправила: ${disabledCount} вимкнено, ${enabledCount} увімкнено`);
                }
            } finally {
                autoRulesV2Running = false;
            }
        }

        // ============================================================================
        // RATE LIMIT MONITORING
        // ============================================================================

        async function updateRateLimitIndicator() {
            try {
                const response = await fetch('/api/rate-limit-stats');
                const data = await response.json();

                if (!data.success) return;

                const stats = data.stats;
                const indicator = document.getElementById('rateLimitIndicator');

                if (!indicator) return;

                const usagePercent = data.usage_percent;
                const emoji = data.status_emoji;

                // Колір в залежності від навантаження
                let bgColor = 'rgba(76, 175, 80, 0.2)'; // зелений
                let textColor = '#4CAF50';

                if (usagePercent >= 75) {
                    bgColor = 'rgba(244, 67, 54, 0.2)'; // червоний
                    textColor = '#f44336';
                } else if (usagePercent >= 50) {
                    bgColor = 'rgba(255, 152, 0, 0.2)'; // помаранчевий
                    textColor = '#ff9800';
                }

                indicator.style.background = bgColor;
                indicator.style.color = textColor;
                indicator.innerHTML = `
                    ${emoji} API Rate Limit: ${stats.requests_last_minute}/${stats.max_per_minute} за хвилину
                    (${usagePercent.toFixed(0)}% використано, ${stats.available_slots} вільно)
                `;
            } catch (error) {
                console.warn('Не вдалося оновити rate limit indicator:', error);
            }
        }

        // ============================================================================
        // КНОПКИ АВТООНОВЛЕННЯ НА КРОЦІ 4
        // ============================================================================

        /**
         * Toggle АФК режиму з Кроку 4
         */
        function toggleAFKFromStep4() {
            const btn = document.getElementById('afkToggleBtn');
            const intervalInput = document.getElementById('afkIntervalInput');
            const toggle = document.getElementById('autoRefreshToggle');

            if (!toggle || !intervalInput) {
                alert('Помилка: не знайдено елементи автооновлення');
                return;
            }

            if (!isAutoRefreshActive) {
                // Запускаємо АФК режим
                const interval = parseInt(intervalInput.value);

                if (interval < 1 || interval > 60) {
                    alert('⚠️ Інтервал має бути від 1 до 60 хвилин!');
                    return;
                }

                const uniqueSelected = getUniqueSelectedAdaccounts();
                if (uniqueSelected.length === 0) {
                    alert('⚠️ Спочатку виберіть кабінети на Кроці 2!');
                    return;
                }

                // Синхронізуємо інтервал
                document.getElementById('autoRefreshInterval').value = interval;

                // Активуємо toggle на Кроці 3
                toggle.checked = true;
                toggleAutoRefresh();

                // Оновлюємо кнопку на Кроці 4
                btn.textContent = 'ON';
                btn.style.background = '#10b981';
                btn.style.color = 'white';

            } else {
                // Зупиняємо АФК режим
                toggle.checked = false;
                toggleAutoRefresh();

                // Оновлюємо кнопку на Кроці 4
                btn.textContent = 'OFF';
                btn.style.background = '#cbd5e1';
                btn.style.color = '#475569';
            }
        }

        /**
         * Toggle Auto-CRM з Кроку 4
         */
        async function toggleAutoCRMFromStep4() {
            const btn = document.getElementById('autoCrmStep4Btn');
            const mainBtn = document.getElementById('autoCrmBtn');

            if (!autoCrmEnabled) {
                // Запускаємо авто-CRM
                try {
                    const response = await fetch('/api/auto-crm/start', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'}
                    });

                    const data = await response.json();

                    if (data.success) {
                        autoCrmEnabled = true;

                        // Оновлюємо обидві кнопки
                        btn.textContent = 'ON';
                        btn.style.background = '#10b981';
                        btn.style.color = 'white';

                        if (mainBtn) {
                            mainBtn.textContent = '⏰ Авто-CRM: ON';
                            mainBtn.style.background = '#4CAF50';
                        }

                        console.log('✅ Автооновлення CRM запущено з Кроку 4');
                        showNotification('✅ Auto-CRM запущено (кожну хвилину)');
                    } else {
                        alert('Помилка запуску: ' + data.message);
                    }
                } catch (error) {
                    alert('Помилка запуску авто-CRM: ' + error.message);
                }
            } else {
                // Зупиняємо авто-CRM
                try {
                    const response = await fetch('/api/auto-crm/stop', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'}
                    });

                    const data = await response.json();

                    if (data.success) {
                        autoCrmEnabled = false;

                        // Оновлюємо обидві кнопки
                        btn.textContent = 'OFF';
                        btn.style.background = '#cbd5e1';
                        btn.style.color = '#475569';

                        if (mainBtn) {
                            mainBtn.textContent = '⏰ Авто-CRM: OFF';
                            mainBtn.style.background = '#9c27b0';
                        }

                        console.log('⏹️ Автооновлення CRM зупинено з Кроку 4');
                        showNotification('⏹️ Auto-CRM зупинено');
                    } else {
                        alert('Помилка зупинки: ' + data.message);
                    }
                } catch (error) {
                    alert('Помилка зупинки авто-CRM: ' + error.message);
                }
            }
        }

        /**
         * Синхронізує стан кнопок на Кроці 4 зі станом системи
         */
        function syncStep4Buttons() {
            // Синхронізуємо АФК кнопку
            const afkBtn = document.getElementById('afkToggleBtn');
            if (afkBtn) {
                if (isAutoRefreshActive) {
                    afkBtn.textContent = 'ON';
                    afkBtn.style.background = '#10b981';
                    afkBtn.style.color = 'white';
                } else {
                    afkBtn.textContent = 'OFF';
                    afkBtn.style.background = '#cbd5e1';
                    afkBtn.style.color = '#475569';
                }
            }

            // Синхронізуємо Auto-CRM кнопку
            const crmBtn = document.getElementById('autoCrmStep4Btn');
            if (crmBtn) {
                if (autoCrmEnabled) {
                    crmBtn.textContent = 'ON';
                    crmBtn.style.background = '#10b981';
                    crmBtn.style.color = 'white';
                } else {
                    crmBtn.textContent = 'OFF';
                    crmBtn.style.background = '#cbd5e1';
                    crmBtn.style.color = '#475569';
                }
            }

            // Синхронізуємо інтервал
            const intervalInput = document.getElementById('afkIntervalInput');
            const mainIntervalInput = document.getElementById('autoRefreshInterval');
            if (intervalInput && mainIntervalInput) {
                intervalInput.value = mainIntervalInput.value;
            }
        }

        // Оновлюємо індикатор кожні 5 секунд
        setInterval(updateRateLimitIndicator, 5000);

        // При завантаженні сторінки - завантажуємо налаштування та оновлюємо індикатор
        window.addEventListener('load', () => {
            loadAutoRulesV2Settings();
            updateRateLimitIndicator();
        });
