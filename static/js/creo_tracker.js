/**
 * creo_tracker.js — T-CRM-CREO: парсинг номера креоса из названия адсета
 * Loaded via crm_fix.js loadScript chain.
 *
 * Логика:
 * 1. Парсит creative ID из названия адсета (паттерны: "creo_123", "креос_456", "#789", etc.)
 * 2. Строит маппинг: cabinet → Set<creo_id> (какие креосы были на этом кабинете)
 * 3. Сохраняет историю в localStorage для персистенции между перезагрузками
 * 4. Предоставляет API для проверки: "был ли этот креос на этом кабинете?"
 */
(function(){
    'use strict';

    var STORAGE_KEY = 'creo_tracker_history';

    // Паттерны для парсинга creative ID из названия адсета
    // Примеры: "creo_123", "creo123", "креос_456", "креос456", "#789", "cr_012"
    var CREO_PATTERNS = [
        /creo[_\s-]?(\d+)/i,           // creo_123, creo 123, creo-123
        /креос[_\s-]?(\d+)/i,          // креос_456
        /cr[_\s-]?(\d+)/i,             // cr_012
        /#(\d{2,6})(?!\d)/,              // #789 (2-6 цифр, не больше)
        /creative[_\s-]?(\d+)/i,       // creative_123
        /\b[kк](\d{2,})\b/i             // k123 / к123 (Latin + Cyrillic)
    ];

    // История: { cabinet_id: { creo_id: { first_seen, last_seen, adset_names[] } } }
    var creoHistory = {};

    /**
     * Загрузить историю из localStorage
     */
    function loadHistory(){
        try{
            var stored = localStorage.getItem(STORAGE_KEY);
            if(stored){
                creoHistory = JSON.parse(stored);
                var totalCreos = 0;
                for(var cab in creoHistory){
                    totalCreos += Object.keys(creoHistory[cab]).length;
                }
                console.log('[CREO] Loaded history: ' + Object.keys(creoHistory).length +
                    ' cabinets, ' + totalCreos + ' creos');
            }
        } catch(e){
            console.warn('[CREO] Failed to load history:', e.message);
            creoHistory = {};
        }
    }

    /**
     * Сохранить историю в localStorage
     */
    function saveHistory(){
        try{
            localStorage.setItem(STORAGE_KEY, JSON.stringify(creoHistory));
        } catch(e){
            console.warn('[CREO] Failed to save history:', e.message);
        }
    }

    /**
     * Извлечь creative ID из названия адсета
     * Returns: string (creo ID) или null
     */
    function extractCreoId(adsetName){
        if(!adsetName || typeof adsetName !== 'string') return null;
        for(var i=0; i<CREO_PATTERNS.length; i++){
            var match = adsetName.match(CREO_PATTERNS[i]);
            if(match && match[1]){
                return match[1];
            }
        }
        return null;
    }

    /**
     * Обработать текущие данные — извлечь креосы и обновить историю
     */
    function processCurrentData(){
        if(!window.lastResults || !Array.isArray(window.lastResults)) return 0;

        var newEntries = 0;
        var now = new Date().toISOString();

        for(var ci=0; ci<window.lastResults.length; ci++){
            var campaign = window.lastResults[ci];
            var cabinetId = campaign.account_id || campaign.adaccount_id || '';
            if(!cabinetId) continue;

            if(!campaign.adsets || !Array.isArray(campaign.adsets)) continue;

            for(var si=0; si<campaign.adsets.length; si++){
                var adset = campaign.adsets[si];
                var adsetName = adset.name || '';
                var creoId = extractCreoId(adsetName);
                if(!creoId) continue;

                // Инициализируем кабинет если нужно
                if(!creoHistory[cabinetId]) creoHistory[cabinetId] = {};

                if(!creoHistory[cabinetId][creoId]){
                    // Новый креос на этом кабинете
                    creoHistory[cabinetId][creoId] = {
                        first_seen: now,
                        last_seen: now,
                        adset_names: [adsetName]
                    };
                    newEntries++;
                } else {
                    // Обновляем
                    creoHistory[cabinetId][creoId].last_seen = now;
                    if(creoHistory[cabinetId][creoId].adset_names.indexOf(adsetName) === -1){
                        creoHistory[cabinetId][creoId].adset_names.push(adsetName);
                    }
                }
            }
        }

        if(newEntries > 0){
            saveHistory();
            console.log('[CREO] Found ' + newEntries + ' new creo entries');
        }
        return newEntries;
    }

    /**
     * Проверить: был ли этот креос на этом кабинете?
     */
    function wasCreoUsed(cabinetId, creoId){
        if(!creoHistory[cabinetId]) return false;
        return !!creoHistory[cabinetId][String(creoId)];
    }

    /**
     * Получить все креосы кабинета
     */
    function getCabinetCreos(cabinetId){
        return creoHistory[cabinetId] || {};
    }

    /**
     * Получить неиспользованные креосы (из списка) для кабинета
     */
    function getUnusedCreos(cabinetId, creoList){
        var used = creoHistory[cabinetId] || {};
        var unused = [];
        for(var i=0; i<creoList.length; i++){
            if(!used[String(creoList[i])]){
                unused.push(creoList[i]);
            }
        }
        return unused;
    }

    /**
     * Полная статистика
     */
    function getStats(){
        var stats = { cabinets: 0, totalCreos: 0, details: {} };
        for(var cab in creoHistory){
            stats.cabinets++;
            var creos = Object.keys(creoHistory[cab]);
            stats.totalCreos += creos.length;
            stats.details[cab] = {
                count: creos.length,
                creos: creos
            };
        }
        return stats;
    }

    // Hook into render to process data after each update
    function patchRender(){
        if(typeof window.renderActiveCampaignsTree === 'function' && !window._creoRenderPatched){
            var origRender = window.renderActiveCampaignsTree;
            window.renderActiveCampaignsTree = function(){
                var result = origRender.apply(this, arguments);
                setTimeout(processCurrentData, 200);
                return result;
            };
            window._creoRenderPatched = true;
            console.log('[CREO] Patched render for auto-tracking');
        }
    }

    // Expose API
    window.creoTracker = {
        extract: extractCreoId,
        wasUsed: wasCreoUsed,
        getCabinet: getCabinetCreos,
        getUnused: getUnusedCreos,
        stats: getStats,
        process: processCurrentData,
        history: function(){ return creoHistory; }
    };

    // Init
    loadHistory();
    patchRender();
    var pTimer = setInterval(function(){
        patchRender();
        if(window._creoRenderPatched) clearInterval(pTimer);
    }, 500);
    setTimeout(function(){ clearInterval(pTimer); }, 15000);

    // Initial scan if data already loaded
    if(window.lastResults) setTimeout(processCurrentData, 500);

    console.log('[CREO] Module loaded. API: window.creoTracker.{extract, wasUsed, getCabinet, getUnused, stats}');
})();
