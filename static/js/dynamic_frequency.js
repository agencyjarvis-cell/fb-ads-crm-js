/**
 * dynamic_frequency.js — Динамическая частота обновления spend
 * Loaded via crm_fix.js loadScript chain.
 *
 * Логика: если CPL адсетов в кабинете значительно ниже целевого (на 40%+),
 * то этот кабинет "хорошо работает" и его можно обновлять реже (1.5x интервал).
 * Это снижает нагрузку на API и rate limit consumption.
 *
 * Как работает:
 * 1. Патчит startAutoRefresh — оригинальный интервал сохраняется как baseInterval
 * 2. После каждого collect/refresh вычисляет "здоровье" кабинетов
 * 3. Если >60% кабинетов имеют CPL < 60% от target → интервал * 1.5
 * 4. Если появляются проблемные кабинеты → возврат к базовому интервалу
 */
(function(){
    'use strict';

    var THRESHOLD_PERCENT = 0.40; // CPL ниже target на 40%+ = "хорошо"
    var SLOWDOWN_FACTOR = 1.5;    // множитель замедления
    var GOOD_CABINET_RATIO = 0.60; // 60%+ кабинетов "хорошие" → замедляем

    var _baseIntervalMinutes = null; // оригинальный интервал пользователя
    var _currentMultiplier = 1.0;
    var _lastAnalysis = null;

    /**
     * Получить target CPL для кабинета (из авторулов)
     * Переиспользует getTargetCpl из crm_fix.js если есть
     */
    function getTargetCplForCabinet(cabinetId){
        // Используем функцию из crm_fix.js если доступна
        if(typeof window._crmFixGetTargetCpl === 'function'){
            return window._crmFixGetTargetCpl(cabinetId);
        }
        var settings = window.autoRulesV2Settings;
        if(!settings) return 4;
        if(settings.groups && settings.groups.length){
            for(var g=0; g<settings.groups.length; g++){
                var group = settings.groups[g];
                if(group.cabinets && group.cabinets.indexOf(cabinetId) !== -1){
                    if(group.rules && group.rules.target_cpl_after_3) return parseFloat(group.rules.target_cpl_after_3);
                    if(group.rules && group.rules.target_cpl_4plus) return parseFloat(group.rules.target_cpl_4plus);
                }
            }
        }
        var dr = settings.default_rules || settings;
        return parseFloat(dr.target_cpl_after_3 || dr.target_cpl_4plus || dr.max_cpl) || 4;
    }

    /**
     * Анализ "здоровья" кабинетов по CPL
     * Returns: { total, good, bad, ratio, details[] }
     */
    function analyzeCabinets(){
        if(!window.lastResults || !Array.isArray(window.lastResults)) return null;

        // Группируем по кабинету
        var cabinets = {};
        for(var ci=0; ci<window.lastResults.length; ci++){
            var campaign = window.lastResults[ci];
            var cabId = campaign.account_id || campaign.adaccount_id || '';
            if(!cabId) continue;
            if(!cabinets[cabId]){
                cabinets[cabId] = { leads: 0, spend: 0, activeAdsets: 0 };
            }
            if(campaign.adsets){
                for(var si=0; si<campaign.adsets.length; si++){
                    var adset = campaign.adsets[si];
                    if((adset.status || adset.effective_status) === 'ACTIVE'){
                        cabinets[cabId].activeAdsets++;
                        cabinets[cabId].leads += (parseInt(adset.leads) || 0);
                        cabinets[cabId].spend += (parseFloat(adset.spend) || 0);
                    }
                }
            }
        }

        var total = 0, good = 0, bad = 0;
        var details = [];
        for(var cabId in cabinets){
            var cab = cabinets[cabId];
            if(cab.activeAdsets === 0 || cab.spend <= 0) continue; // skip inactive
            total++;
            var targetCpl = getTargetCplForCabinet(cabId);
            var actualCpl = cab.leads > 0 ? cab.spend / cab.leads : Infinity;
            var belowBy = cab.leads > 0 ? 1 - (actualCpl / targetCpl) : -1;

            if(belowBy >= THRESHOLD_PERCENT){
                good++;
                details.push({cabinet: cabId, cpl: actualCpl, target: targetCpl, belowBy: belowBy, status: 'good'});
            } else {
                bad++;
                details.push({cabinet: cabId, cpl: actualCpl, target: targetCpl, belowBy: belowBy, status: 'bad'});
            }
        }

        return {
            total: total,
            good: good,
            bad: bad,
            ratio: total > 0 ? good / total : 0,
            details: details
        };
    }

    /**
     * Определить нужный множитель интервала
     */
    function calculateMultiplier(){
        var analysis = analyzeCabinets();
        if(!analysis || analysis.total === 0) return 1.0;
        _lastAnalysis = analysis;

        if(analysis.ratio >= GOOD_CABINET_RATIO){
            // 60%+ кабинетов имеют CPL ниже target на 40%+ → можно замедлить
            return SLOWDOWN_FACTOR;
        }
        return 1.0; // базовый интервал
    }

    /**
     * Применить динамический интервал
     */
    function applyDynamicInterval(){
        if(!_baseIntervalMinutes) return; // не патчили ещё

        var newMultiplier = calculateMultiplier();
        if(newMultiplier === _currentMultiplier) return; // без изменений

        _currentMultiplier = newMultiplier;
        var effectiveInterval = Math.round(_baseIntervalMinutes * _currentMultiplier * 10) / 10;

        console.log('[DYN FREQ] Multiplier changed: x' + _currentMultiplier.toFixed(1) +
            ' → interval ' + effectiveInterval + ' min (base: ' + _baseIntervalMinutes + ' min)');
        if(_lastAnalysis){
            console.log('[DYN FREQ] Cabinets: ' + _lastAnalysis.good + '/' + _lastAnalysis.total +
                ' good (' + Math.round(_lastAnalysis.ratio * 100) + '%)');
        }

        // Перезапускаем autoRefresh с новым интервалом
        if(typeof window.startAutoRefresh === 'function' && window.isAutoRefreshActive){
            // Temporarily remove our patch to avoid recursion
            var _patched = window._dynFreqPatched;
            window._dynFreqPatched = false;
            window.startAutoRefresh(effectiveInterval);
            window._dynFreqPatched = _patched;
        }
    }

    /**
     * Patch startAutoRefresh to capture base interval
     */
    function patchAutoRefresh(){
        if(typeof window.startAutoRefresh !== 'function' || window._dynFreqPatched) return;

        var origStart = window.startAutoRefresh;
        window.startAutoRefresh = function(intervalMinutes){
            // Only capture base interval from user actions, not our own restarts
            if(window._dynFreqPatched !== false){
                _baseIntervalMinutes = intervalMinutes;
                var effectiveInterval = intervalMinutes * _currentMultiplier;
                console.log('[DYN FREQ] Base interval set: ' + intervalMinutes + ' min, effective: ' +
                    effectiveInterval.toFixed(1) + ' min (x' + _currentMultiplier.toFixed(1) + ')');
                return origStart.call(this, effectiveInterval);
            }
            return origStart.call(this, intervalMinutes);
        };
        window._dynFreqPatched = true;
        console.log('[DYN FREQ] Patched startAutoRefresh');
    }

    /**
     * Hook into render to re-evaluate after data changes
     */
    function patchRender(){
        if(typeof window.renderActiveCampaignsTree === 'function' && !window._dynFreqRenderPatched){
            var origRender = window.renderActiveCampaignsTree;
            window.renderActiveCampaignsTree = function(){
                var result = origRender.apply(this, arguments);
                // Re-evaluate frequency after each render (data changed)
                setTimeout(applyDynamicInterval, 500);
                return result;
            };
            window._dynFreqRenderPatched = true;
            console.log('[DYN FREQ] Patched render for auto-evaluation');
        }
    }

    // Expose for debugging
    window.dynFreqAnalyze = function(){
        var a = analyzeCabinets();
        if(!a){ console.log('No data'); return; }
        console.log('[DYN FREQ] Analysis: ' + a.good + '/' + a.total + ' good (' +
            Math.round(a.ratio * 100) + '%), multiplier would be x' + calculateMultiplier().toFixed(1));
        for(var i=0; i<a.details.length; i++){
            var d = a.details[i];
            console.log('  ' + d.status.toUpperCase() + ' ' + d.cabinet +
                ': CPL $' + (d.cpl === Infinity ? '∞' : d.cpl.toFixed(2)) +
                ' / target $' + d.target.toFixed(2) +
                ' (below by ' + Math.round(d.belowBy * 100) + '%)');
        }
    };
    window.dynFreqStatus = function(){
        return {
            baseInterval: _baseIntervalMinutes,
            currentMultiplier: _currentMultiplier,
            effectiveInterval: _baseIntervalMinutes ? _baseIntervalMinutes * _currentMultiplier : null,
            lastAnalysis: _lastAnalysis
        };
    };

    // Init
    patchAutoRefresh();
    patchRender();
    var pTimer = setInterval(function(){
        patchAutoRefresh();
        patchRender();
        if(window._dynFreqPatched && window._dynFreqRenderPatched) clearInterval(pTimer);
    }, 500);
    setTimeout(function(){ clearInterval(pTimer); }, 20000);

    console.log('[DYN FREQ] Module loaded. Config: threshold=' + (THRESHOLD_PERCENT*100) +
        '%, slowdown=' + SLOWDOWN_FACTOR + 'x, ratio=' + (GOOD_CABINET_RATIO*100) + '%');
})();
