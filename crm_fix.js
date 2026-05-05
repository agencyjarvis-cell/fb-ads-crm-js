(function(){
    const _originalFetch=window.fetch;
    let crmLookup={};let crmTotal=0;
    window.fetch=function(url,options){
        if(typeof url==="string"&&url.includes("/api/refresh-crm")&&!url.includes("5099")){
            return _originalFetch.call(this,"http://localhost:5099/api/refresh-crm",options||{method:"POST"});
        }
        if(typeof url==="string"&&url.includes("/api/collect")&&options&&options.body){
            try{var body=JSON.parse(options.body);
                if(body.refresh_crm===true){body.refresh_crm=false;options=Object.assign({},options,{body:JSON.stringify(body)});}
            }catch(e){}
        }
        return _originalFetch.call(this,url,options);
    };
    async function fetchCrmData(){
        try{var r=await _originalFetch.call(window,"http://localhost:5099/api/refresh-crm");
            var data=await r.json();
            if(data.success&&data.data){
                crmLookup={};crmTotal=0;
                for(var i=0;i<data.data.length;i++){var entry=data.data[i];
                    if(entry.campaign_name&&entry.leads>0){crmLookup[entry.campaign_name]=entry.leads;crmTotal+=entry.leads;}}
                window.lastCrmTimestamp=Date.now();window.lastCrmUpdate=Date.now();window._crmFixLookup=crmLookup;
                console.log("[CRM FIX v3] CRM cache: "+Object.keys(crmLookup).length+" entries, "+crmTotal+" leads");
            }
        }catch(e){console.warn("[CRM FIX v3] CRM fetch failed:",e.message);}
    }
    function applyCrmLeads(){
        if(!window.lastResults||!Array.isArray(window.lastResults))return 0;
        if(Object.keys(crmLookup).length===0)return 0;
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
                    if(ad.name&&crmLookup[ad.name]!==undefined){ad.leads=crmLookup[ad.name];adsetLeads+=ad.leads;adsetHasMatch=true;
                        if(matched.indexOf(ad.name)===-1)matched.push(ad.name);}}
                if(adsetHasMatch){adset.leads=adsetLeads;adset.cpl=adsetLeads>0?(parseFloat(adset.spend)||0)/adsetLeads:null;campaignHasMatch=true;}
                campaignLeads+=(adsetHasMatch?adsetLeads:(parseFloat(adset.leads)||0));
            }
            if(campaignHasMatch){campaign.leads=campaignLeads;campaign.cpl=campaignLeads>0?(parseFloat(campaign.spend)||0)/campaignLeads:null;totalMatched+=campaignLeads;}
        }
        if(totalMatched>0)console.log("[CRM FIX v3] Applied "+totalMatched+" leads: ["+matched.join(", ")+"]");
        return totalMatched;
    }
    window.checkCrmCacheFreshness=function(){
        if(window.lastCrmTimestamp&&Object.keys(crmLookup).length>0){
            var ageMin=(Date.now()-window.lastCrmTimestamp)/60000;
            return Promise.resolve({fresh:true,age_minutes:ageMin,ttl_minutes:2,source:"crm_fix_v3"});}
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
        try{await fetchCrmData();applyCrmLeads();
            if(typeof window.renderActiveCampaignsTree==="function"&&window.lastResults)window.renderActiveCampaignsTree(window.lastResults);
            if(typeof hideLoading==="function")hideLoading();
            if(typeof releaseLock==="function")releaseLock("CRM оновлено");
            alert("CRM оновлено!");
        }catch(e){if(typeof hideLoading==="function")hideLoading();if(typeof releaseLock==="function")releaseLock();alert("Помилка: "+e.message);}
    };
    async function checkReEnableAdsets(){
        if(!window.lastResults||!window.autoRulesV2Settings)return;
        if(!window.autoRulesV2DisabledAdsets||Object.keys(window.autoRulesV2DisabledAdsets).length===0)return;
        var settings=window.autoRulesV2Settings;
        for(var ci=0;ci<window.lastResults.length;ci++){
            var campaign=window.lastResults[ci];if(!campaign.adsets)continue;
            for(var si=0;si<campaign.adsets.length;si++){
                var adset=campaign.adsets[si];var adsetId=adset.id||adset.adset_id;
                if(!adsetId||!window.autoRulesV2DisabledAdsets[adsetId])continue;
                var leads=parseInt(adset.leads)||0;var spend=parseFloat(adset.spend)||0;
                if(leads===0||spend===0)continue;
                var cpl=spend/leads;var maxSpend=null;
                if(leads>=4){
                    var targetCpl=parseFloat(settings.disable_rules&&settings.disable_rules.max_cpl)||4;
                    if(typeof window.getRulesForCabinet==="function"){
                        try{var rules=window.getRulesForCabinet(campaign.account_id||campaign.adaccount_id);
                            if(rules&&rules.target_cpl_4plus)targetCpl=parseFloat(rules.target_cpl_4plus);}catch(e){}
                    }
                    maxSpend=leads*targetCpl;
                }
                if(maxSpend!==null&&spend<maxSpend){
                    console.log("[CRM FIX v3] Re-enable "+adsetId+": "+leads+" leads, CPL $"+cpl.toFixed(2));
                    if(typeof window.checkAdsetEnableRule==="function"){
                        try{await window.checkAdsetEnableRule(adsetId,adset);}catch(e){}
                    }else{
                        try{await _originalFetch.call(window,"/api/adset-status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({adset_id:adsetId,status:"ACTIVE"})});
                            delete window.autoRulesV2DisabledAdsets[adsetId];
                        }catch(e){}
                    }
                }
            }
        }
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
    console.log("[CRM FIX v3.5] Loaded: fetch interceptor + render-hook + autorules-inject + sequential batch (30/min, 5-10s delay) + auto-enable rules + no-spend dedup fix");
})();

// Auto-load: cabinet_enable_consent + scheduled_enable + scheduled_enable_ui
(function(){
    function loadScript(src, onload){
        var s=document.createElement('script');
        s.src=src;
        s.onload=onload||function(){};
        s.onerror=function(){console.warn('[CRM FIX] Failed to load: '+src);};
        document.head.appendChild(s);
    }
    var base='/static/js/';
    loadScript(base+'cabinet_enable_consent.js', function(){
        console.log('[CRM FIX] ✅ cabinet_enable_consent.js loaded');
        loadScript(base+'scheduled_enable.js', function(){
            console.log('[CRM FIX] ✅ scheduled_enable.js loaded');
            loadScript(base+'scheduled_enable_ui.js', function(){
                console.log('[CRM FIX] ✅ scheduled_enable_ui.js loaded');
            });
        });
    });
})();
