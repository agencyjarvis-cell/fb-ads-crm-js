(function(){
    const _originalFetch=window.fetch;
    let crmLookup={};let crmTotal=0;
    let crmCacheAge=-1;let crmSource='unknown';let crmFetchErrors=0;
    window.fetch=function(url,options){
        if(typeof url==="string"&&url.includes("/api/refresh-crm")&&!url.includes("5099")){
            return _originalFetch.call(this,"http://localhost:5099/api/refresh-crm",options||{method:"POST"});
        }
        if(typeof url==="string"&&url.includes("/api/collect")&&options&&options.body){
            try{var body=JSON.parse(options.body);
                // refresh_crm override removed - let Flask do fresh scrape
            }catch(e){}
        }
        if(typeof url==="string"&&url.includes("/api/auto-rules/settings")){
            return _originalFetch.call(this,url,options).then(function(resp){
                return resp.clone().json().then(function(data){
                    if(!data.success&&(data.settings||data.default_rules||data.cabinet_enabled)){
                        var wrapped={success:true,settings:data.settings||data};
                        console.log("[CRM FIX v3] Wrapped auto-rules/settings response (added success:true)");
                        return new Response(JSON.stringify(wrapped),{status:200,headers:{"Content-Type":"application/json"}});
                    }
                    return resp;
                }).catch(function(){return resp;});
            });
        }
        if(typeof url==="string"&&url.includes("/api/rate-limit-stats")){
            return _originalFetch.call(this,url,options).then(function(resp){
                return resp.json().then(function(data){
                    if(data.stats){data.stats.max_per_minute=30;data.stats.available_slots=30-data.stats.requests_last_minute;}
                    data.usage_percent=((data.stats?data.stats.requests_last_minute:0)/30)*100;
                    return new Response(JSON.stringify(data),{status:200,headers:{"Content-Type":"application/json"}});
                });
            });
        }
        return _originalFetch.call(this,url,options);
    };
    function updateCrmStatusIndicator(status, age){
        var el=document.getElementById('crm-status-indicator');
        if(!el){
            el=document.createElement('div');
            el.id='crm-status-indicator';
            el.style.cssText='position:fixed;top:8px;right:8px;z-index:99999;padding:4px 10px;border-radius:6px;font-size:12px;font-family:monospace;cursor:pointer;opacity:0.9;';
            el.title='CRM refresh status';
            document.body.appendChild(el);
        }
        if(status==='ok'){
            var ageMin=Math.round(age/60);
            el.style.background='#1a7f37';el.style.color='#fff';
            el.textContent='CRM: '+Object.keys(crmLookup).length+' | '+crmTotal+' leads | '+ageMin+'m';
        }else if(status==='stale'){
            var ageMin=Math.round(age/60);
            el.style.background='#d1242f';el.style.color='#fff';
            el.textContent='⚠ CRM STALE: '+ageMin+'m old! Scraper down?';
        }else if(status==='error'){
            el.style.background='#d1242f';el.style.color='#fff';
            el.textContent='❌ CRM: port 5099 not responding ('+crmFetchErrors+'x)';
        }
    }
    var _lastFetchTime=0;var _FETCH_THROTTLE_MS=10000;
    async function fetchCrmData(forcePost){
        try{
            var method="GET";
            var now=Date.now();if(!forcePost&&(now-_lastFetchTime)<_FETCH_THROTTLE_MS){console.log("[CRM FIX v3] fetchCrmData throttled ("+Math.round((now-_lastFetchTime)/1000)+"s since last)");return;}_lastFetchTime=now;
            if(forcePost||crmCacheAge>300||crmCacheAge<0)method="POST";
            var opts={method:method};
            if(method==="POST")opts.headers={"Content-Type":"application/json"};
            var r=await _originalFetch.call(window,"http://localhost:5099/api/refresh-crm",opts);
            if(r.status===429){crmCacheAge=30;crmFetchErrors=0;updateCrmStatusIndicator("ok",crmCacheAge);console.log("[CRM FIX v3] Scrape in progress, will GET cache next cycle");return;}
            var data=await r.json();
            if(data.success&&data.data){
                crmCacheAge=data.cache_age_sec||0;
                crmSource=data.source||'unknown';
                crmFetchErrors=0;
                var prevTotal=crmTotal;var prevCount=Object.keys(crmLookup).length;
                crmLookup={};crmTotal=0;
                for(var i=0;i<data.data.length;i++){var entry=data.data[i];
                    if(entry.campaign_name&&entry.leads>0){crmLookup[entry.campaign_name]=entry.leads;crmTotal+=entry.leads;}}
                window.lastCrmTimestamp=Date.now();window.lastCrmUpdate=Date.now();window._crmFixLookup=crmLookup;
                var count=Object.keys(crmLookup).length;
                var changed=(count!==prevCount||crmTotal!==prevTotal);
                var freshTag=crmCacheAge<120?'FRESH':crmCacheAge<300?'AGING':'STALE';
                console.log("[CRM FIX v3] CRM cache: "+count+" entries, "+crmTotal+" leads | age:"+Math.round(crmCacheAge)+"s ("+freshTag+") | src:"+crmSource+(changed?' [UPDATED]':''));
                if(crmCacheAge>300){
                    console.error("[CRM FIX v3] ⚠ CRM STALE ("+Math.round(crmCacheAge/60)+"min). Scraper may be down! Check Brave CDP / port 9223.");
                    updateCrmStatusIndicator('stale',crmCacheAge);
                }else{
                    updateCrmStatusIndicator('ok',crmCacheAge);
                }
            }
        }catch(e){
            crmFetchErrors++;
            console.warn("[CRM FIX v3] CRM fetch failed ("+crmFetchErrors+"x):",e.message);
            updateCrmStatusIndicator('error',-1);
            if(crmFetchErrors===3){
                console.error("[CRM FIX v3] ❌ Port 5099 unreachable 3 times! CRM server likely crashed. Restart start_all_jeez.command");
            }
        }
    }
    function applyCrmLeads(){
        if(!window.lastResults||!Array.isArray(window.lastResults))return 0;
        if(Object.keys(crmLookup).length===0)return 0;
        // Pass 1: collect total spend per ad name across ALL adsets (dedup)
        var spendByName={};
        for(var ci=0;ci<window.lastResults.length;ci++){
            var campaign=window.lastResults[ci];
            if(!campaign.adsets||!Array.isArray(campaign.adsets))continue;
            for(var si=0;si<campaign.adsets.length;si++){
                var adset=campaign.adsets[si];
                if(!adset.ads||!Array.isArray(adset.ads))continue;
                for(var ai=0;ai<adset.ads.length;ai++){
                    var ad=adset.ads[ai];
                    if(ad.name&&crmLookup[ad.name]!==undefined){
                        var adSpend=parseFloat(ad.spend)||0;
                        if(!spendByName[ad.name])spendByName[ad.name]={total:0,count:0};
                        spendByName[ad.name].total+=adSpend;
                        spendByName[ad.name].count++;
                    }
                }
            }
        }
        // Pass 2: distribute CRM leads proportionally by spend (no double-counting)
        // Track remainder per ad name to avoid rounding loss
        var distributed={};
        var totalMatched=0;var matched=[];
        for(var ci=0;ci<window.lastResults.length;ci++){
            var campaign=window.lastResults[ci];
            if(!campaign.adsets||!Array.isArray(campaign.adsets))continue;
            var campaignLeads=0;var campaignHasMatch=false;
            for(var si=0;si<campaign.adsets.length;si++){
                var adset=campaign.adsets[si];
                if(!adset.ads||!Array.isArray(adset.ads))continue;
                var adsetLeads=0;var adsetHasMatch=false;
                for(var ai=0;ai<adset.ads.length;ai++){
                    var ad=adset.ads[ai];
                    if(ad.name&&crmLookup[ad.name]!==undefined){
                        var crmLeads=crmLookup[ad.name];
                        var info=spendByName[ad.name];
                        if(info&&info.count>1){
                            if(!distributed[ad.name])distributed[ad.name]={given:0,idx:0};
                            var d=distributed[ad.name];
                            d.idx++;
                            if(d.idx>=info.count){
                                // Last occurrence gets remainder (prevents rounding loss)
                                ad.leads=crmLeads-d.given;
                            }else{
                                var adSpend=parseFloat(ad.spend)||0;
                                if(info.total>0){ad.leads=Math.round(crmLeads*(adSpend/info.total));}
                                else{ad.leads=Math.floor(crmLeads/info.count);}
                                d.given+=ad.leads;
                            }
                        }else{
                            ad.leads=crmLeads;
                        }
                        adsetLeads+=ad.leads;adsetHasMatch=true;
                        if(matched.indexOf(ad.name)===-1)matched.push(ad.name);
                    }
                }
                if(adsetHasMatch){adset.leads=adsetLeads;adset.cpl=adsetLeads>0?(parseFloat(adset.spend)||0)/adsetLeads:null;campaignHasMatch=true;}
                else{adset.leads=0;adset.cpl=null;}
                campaignLeads+=(adsetHasMatch?adsetLeads:0);
            }
            if(campaignHasMatch){campaign.leads=campaignLeads;campaign.cpl=campaignLeads>0?(parseFloat(campaign.spend)||0)/campaignLeads:null;totalMatched+=campaignLeads;}
            else{campaign.leads=0;campaign.cpl=null;}
        }
        if(totalMatched>0)console.log("[CRM FIX v3] Applied "+totalMatched+" leads (dedup): ["+matched.join(", ")+"]");
        return totalMatched;
    }
    window.checkCrmCacheFreshness=function(){
        if(window.lastCrmTimestamp&&Object.keys(crmLookup).length>0){
            var ageMin=(Date.now()-window.lastCrmTimestamp)/60000;
            return Promise.resolve({fresh:crmCacheAge<300,age_minutes:ageMin,server_cache_age_sec:crmCacheAge,source:crmSource,ttl_minutes:2,source:"crm_fix_v3"});}
        return Promise.resolve({fresh:false,error:"CRM not loaded yet",ttl_minutes:2});
    };
    function stripLeadsFromZeroSpend(){
        if(!window.lastResults||!Array.isArray(window.lastResults))return;
        for(var i=0;i<window.lastResults.length;i++){
            var c=window.lastResults[i];
            if(parseFloat(c.spend)<=0){c.leads=0;c.cpl=null;
                if(c.adsets&&Array.isArray(c.adsets)){
                    for(var j=0;j<c.adsets.length;j++){
                        if(parseFloat(c.adsets[j].spend)<=0){c.adsets[j].leads=0;c.adsets[j].cpl=null;}}}}}
    }
    function patchRender(){
        if(typeof window.renderActiveCampaignsTree==="function"&&!window._crmRenderPatched){
            var origRender=window.renderActiveCampaignsTree;
            window.renderActiveCampaignsTree=function(){applyCrmLeads();stripLeadsFromZeroSpend();return origRender.apply(this,arguments);};
            window._crmRenderPatched=true;console.log("[CRM FIX v3] Patched renderActiveCampaignsTree");}
    }
    patchRender();
    var patchTimer=setInterval(function(){patchRender();if(window._crmRenderPatched)clearInterval(patchTimer);},300);
    setTimeout(function(){clearInterval(patchTimer);},15000);
    function patchAutoRules(){
        if(typeof window.evaluateAutoRulesV2==="function"&&!window._crmAutoRulesPatched){
            var origEval=window.evaluateAutoRulesV2;
            window.evaluateAutoRulesV2=async function(){var applied=applyCrmLeads();
                if(applied>0)console.log("[CRM FIX v3] Injected "+applied+" CRM leads before autorules");
                return origEval.apply(this,arguments);};
            window._crmAutoRulesPatched=true;console.log("[CRM FIX v3] Patched evaluateAutoRulesV2");}
    }
    patchAutoRules();
    var arPatchTimer=setInterval(function(){patchAutoRules();if(window._crmAutoRulesPatched)clearInterval(arPatchTimer);},300);
    setTimeout(function(){clearInterval(arPatchTimer);},15000);
    function patchBatch(){
        if(typeof window.RequestQueueManager==="function"&&!window._batchPatched){
            var origProcess=RequestQueueManager.prototype.processBatch;
            try{var inst=window.requestQueueManager||window.queueManager;if(inst&&inst.maxPerMinute)inst.maxPerMinute=30;}catch(e){}
            RequestQueueManager.prototype.processBatch=async function(){
                this.maxPerMinute=30;
                var now=Date.now();
                if(!this.minuteStartTime||now-this.minuteStartTime>=60000){this.minuteStartTime=now;this.requestsThisMinute=0;}
                var available=this.maxPerMinute-this.requestsThisMinute;
                if(available<=0){var waitTime=60000-(now-this.minuteStartTime);
                    await this.sleep(waitTime+100);return this.processBatch();}
                var batch=[...this.priorityQueue.splice(0,available),...this.queue.splice(0,Math.max(0,available-this.priorityQueue.length))];
                if(batch.length===0)return[];
                console.log("[Batch] Processing "+batch.length+" requests sequentially...");
                var results=[];
                for(var i=0;i<batch.length;i++){var req=batch[i];
                    if(i>0){var delay=5000+Math.floor(Math.random()*5000);
                        await new Promise(function(resolve){setTimeout(resolve,delay);});}
                    try{var result=await this.executeRequest(req);
                        results.push({status:"fulfilled",value:{success:true,...result}});
                    }catch(error){results.push({status:"rejected",reason:error});}
                }
                this.requestsThisMinute+=batch.length;
                var sc=results.filter(function(r){return r.status==="fulfilled";}).length;
                console.log("[Batch] Done: "+sc+"/"+batch.length+" ok ("+this.requestsThisMinute+"/30 this min)");
                return results;
            };
            window._batchPatched=true;console.log("[CRM FIX v3] Patched batch — sequential 5-10s delay");
        }
    }
    patchBatch();
    var batchTimer=setInterval(function(){patchBatch();if(window._batchPatched)clearInterval(batchTimer);},300);
    setTimeout(function(){clearInterval(batchTimer);},15000);
    window.refreshCRM=async function(){
        if(typeof acquireLock==="function"&&!acquireLock("Оновлення CRM даних"))return;
        if(!confirm("Оновити CRM дані?")){if(typeof releaseLock==="function")releaseLock();return;}
        if(typeof showLoading==="function")showLoading("Оновлення CRM...");
        try{await fetchCrmData(true);applyCrmLeads();
            if(typeof window.renderActiveCampaignsTree==="function"&&window.lastResults)window.renderActiveCampaignsTree(window.lastResults);
            if(typeof hideLoading==="function")hideLoading();
            if(typeof releaseLock==="function")releaseLock("CRM оновлено");
            alert("CRM оновлено!");
        }catch(e){if(typeof hideLoading==="function")hideLoading();if(typeof releaseLock==="function")releaseLock();alert("Помилка: "+e.message);}
    };
    // Track adsets disabled by autorules (since app.js Set is not exported to window)
    if(!window._crmFixDisabledAdsets) window._crmFixDisabledAdsets={};
    // Hook: intercept disable/enable API calls to track disabled adsets
    (function(){
        var _prevFetch=window.fetch;
        window.fetch=function(url,options){
            if(typeof url==="string"&&url.includes("/api/adsets/status")&&options&&options.body){
                try{var b=JSON.parse(options.body);
                    if(b.status==="PAUSED"&&b.adset_id){window._crmFixDisabledAdsets[b.adset_id]={at:Date.now()};console.log("[CRM FIX] Tracked disable: "+b.adset_id);}
                    if(b.status==="ACTIVE"&&b.adset_id){delete window._crmFixDisabledAdsets[b.adset_id];console.log("[CRM FIX] Tracked enable: "+b.adset_id);}
                }catch(e){}
            }
            return _prevFetch.apply(this,arguments);
        };
    })();

    function getTargetCpl(cabinetId){
        var settings=window.autoRulesV2Settings;if(!settings)return 4;
        if(settings.groups&&settings.groups.length){
            for(var g=0;g<settings.groups.length;g++){
                var group=settings.groups[g];
                if(group.cabinets&&group.cabinets.indexOf(cabinetId)!==-1){
                    if(group.rules&&group.rules.target_cpl_after_3)return parseFloat(group.rules.target_cpl_after_3);
                    if(group.rules&&group.rules.target_cpl_4plus)return parseFloat(group.rules.target_cpl_4plus);
                }
            }
        }
        var dr=settings.default_rules||settings;
        return parseFloat(dr.target_cpl_after_3||dr.target_cpl_4plus||dr.max_cpl)||4;
    }

    async function checkReEnableAdsets(){
        if(!window.lastResults||!window.autoRulesV2Settings)return;
        var disabled=window._crmFixDisabledAdsets;
        if(!disabled||Object.keys(disabled).length===0)return;
        var reEnabled=0;
        for(var ci=0;ci<window.lastResults.length;ci++){
            var campaign=window.lastResults[ci];if(!campaign.adsets)continue;
            var cabinetId=campaign.account_id||campaign.adaccount_id||'';
            var fbtoolId=campaign.fbtool_account_id||'';
            for(var si=0;si<campaign.adsets.length;si++){
                var adset=campaign.adsets[si];var adsetId=adset.id||adset.adset_id;
                if(!adsetId||!disabled[adsetId])continue;
                var leads=parseInt(adset.leads)||0;var spend=parseFloat(adset.spend)||0;
                if(leads<1||spend<=0)continue;
                var cpl=spend/leads;
                var targetCpl=getTargetCpl(cabinetId);
                if(cpl<targetCpl){
                    console.log("[CRM FIX] Re-enable "+adsetId+": "+leads+" leads, CPL $"+cpl.toFixed(2)+" < target $"+targetCpl.toFixed(2));
                    try{
                        var normalizedAcct=(cabinetId||'').replace(/^act_/,'');
                        await _originalFetch.call(window,"/api/adsets/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adset_id:adsetId,adaccount_id:normalizedAcct,fbtool_account_id:fbtoolId,status:"ACTIVE"})});
                        delete disabled[adsetId];reEnabled++;
                        console.log("[CRM FIX] ✅ Re-enabled "+adsetId);
                    }catch(e){console.error("[CRM FIX] ❌ Re-enable failed "+adsetId+":",e.message);}
                }
            }
        }
        if(reEnabled>0)console.log("[CRM FIX] Re-enabled "+reEnabled+" adsets (burst leads)");
    }
    window.refreshCrmCacheSilently=async function(){
        try{await fetchCrmData();applyCrmLeads();
            if(typeof window.renderActiveCampaignsTree==="function"&&window.lastResults)window.renderActiveCampaignsTree(window.lastResults);
            await checkReEnableAdsets();
            if(typeof window.evaluateAutoRulesV2==="function"){
                console.log("[CRM FIX v3] Triggering autorules after CRM...");
                window.evaluateAutoRulesV2({source:"crm-update"}).catch(function(e){});
            }
        }catch(e){console.warn("[CRM FIX v3] silent refresh fail:",e.message);}
    };
    window.applyCrmLeadsToUI=window.refreshCrmCacheSilently;
    function forceEnableAutoRules(){
        if(typeof window.autoRulesV2Settings==="object"&&window.autoRulesV2Settings){
            var changed=false;
            if(!window.autoRulesV2Settings.global_enabled){window.autoRulesV2Settings.global_enabled=true;changed=true;}
            if(window.autoRulesV2Settings.disable_rules&&!window.autoRulesV2Settings.disable_rules.check_cpl){
                window.autoRulesV2Settings.disable_rules.check_cpl=true;changed=true;
            }
            if(changed&&typeof window.saveAutoRulesV2Settings==="function"){window.saveAutoRulesV2Settings();console.log("[CRM FIX v3] Force-enabled autorules");}
            if(typeof window.updateAutoRulesV2UI==="function")window.updateAutoRulesV2UI();
            return true;
        }
        return false;
    }
    var arTimer=setInterval(function(){if(forceEnableAutoRules())clearInterval(arTimer);},500);
    setTimeout(function(){clearInterval(arTimer);},20000);
    fetchCrmData();
    setInterval(fetchCrmData,30000);
    // Patch recomputeStatsFromRows to only count leads from active campaigns (fixes 205 vs 174 discrepancy)
    var _origRecompute=window.recomputeStatsFromRows;
    if(typeof _origRecompute==="function"){
        window.recomputeStatsFromRows=function(rows){
            var all=Array.isArray(rows)?rows:[];
            var active=all.filter(function(row){
                if(row.status==='crm_only')return false;
                return typeof window.isActiveCampaign==='function'?window.isActiveCampaign(row):true;
            });
            var result=_origRecompute.call(this,active);
            result.crm_only_count=all.filter(function(r){return r.status==='crm_only';}).length;
            return result;
        };
        console.log("[CRM FIX v3] Patched recomputeStatsFromRows (active-only leads)");
    }
    // Patch renderResults to recalculate stats using active-only filter (fixes 300 vs 227 in gradient bar)
    var _origRenderResults=window.renderResults;
    if(typeof _origRenderResults==="function"){
        window.renderResults=function(data,stats,settings){
            var recalc=typeof window.recomputeStatsFromRows==="function"?window.recomputeStatsFromRows(Array.isArray(data)?data:[]):stats;
            console.log("[CRM FIX v3] renderResults stats override: API="+((stats||{}).total_leads||0)+" → active="+recalc.total_leads);
            return _origRenderResults.call(this,data,recalc,settings);
        };
        console.log("[CRM FIX v3] Patched renderResults (active-only stats)");
    }
    console.log("[CRM FIX v3.10] Loaded: lead count fix + settings wrap + token health bar + all v3.7 features");
})();

// Auto-load modules
(function(){
    function loadScript(src, onload){
        var s=document.createElement('script');
        s.src=src;
        s.onload=onload||function(){};
        s.onerror=function(){console.warn('[CRM FIX] Failed to load: '+src+' - skipping'); if(onload)onload();};
        document.head.appendChild(s);
    }
    function loadAll(list, done){
        var i=0;
        function next(){
            if(i>=list.length){if(done)done();return;}
            var src=list[i++];
            loadScript(src, function(){console.log('[CRM FIX] ' + src+' loaded'); next();});
        }
        next();
    }
    loadAll([
        '/static/js/settings_state_restore.js',
        '/static/js/cabinet_enable_consent.js',
        '/static/js/scheduled_enable.js',
        '/static/js/scheduled_enable_ui.js',
        '/static/js/snapshot_collector.js',
        '/static/js/stop_all.js',
        '/static/js/dynamic_frequency.js',
        '/static/js/creo_tracker.js',
        '/static/js/retry_queue.js',
        '/static/js/token_monitor.js',
        '/static/js/reject_tracker.js',
        '/static/js/geo_toggle.js',
        '/static/js/afk_optimizer.js',
        '/static/js/crm_v2_patches.js',
        '/static/js/token_health_ui.js'
    ]);
})();
