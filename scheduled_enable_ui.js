// === SCHEDULED ENABLE UI ===
// Timer panel integrated into Step 4 as a new results tab "Timer"
// Depends on: scheduled_enable.js, app.js (window.lastResults, groupCampaignsByCabinet)

(function(){
    'use strict';

    var TOP_CAMPAIGNS = 3;
    var KYIV_OFFSET = 3;
    var _selectedAdsets = {};  // {adsetId: {name, cabName}}
    var _subTab = 'setup';    // 'setup' | 'active'
    var _expandedCabs = {};
    var _expandedAds = {};
    var _timerRefreshId = null;

    // ========== HELPERS ==========
    function getKyivNow() {
        var now = new Date();
        return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (KYIV_OFFSET * 3600000));
    }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtKyiv(d) {
        return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function fmtDateInput(d) {
        return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
    }
    function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    function selectedCount() { return Object.keys(_selectedAdsets).length; }

    // ========== INJECT TAB BUTTON ==========
    function injectTabButton() {
        // Find existing tab buttons container
        var activeBtn = document.getElementById('resultsTabActive');
        if (!activeBtn) { setTimeout(injectTabButton, 1000); return; }
        if (document.getElementById('resultsTabTimer')) return; // already injected

        var btn = document.createElement('button');
        btn.id = 'resultsTabTimer';
        btn.className = activeBtn.className;
        btn.textContent = '⏰ Timer';
        btn.style.cssText = activeBtn.style.cssText;
        btn.onclick = function() { switchToTimerTab(); };
        // Insert after the last tab button
        var autoV2Btn = document.getElementById('resultsTabAutoV2');
        var refNode = autoV2Btn || activeBtn;
        refNode.parentNode.insertBefore(btn, refNode.nextSibling);

        // Create timer section (hidden by default)
        var section = document.createElement('div');
        section.id = 'timerSection';
        section.style.display = 'none';
        // Insert after autoRulesV2Section
        var autoV2Section = document.getElementById('autoRulesV2Section');
        var allSection = document.getElementById('allCabinetsSection');
        var statsSection = document.getElementById('statsTabSection');
        var refSection = autoV2Section || allSection || statsSection;
        if (refSection && refSection.parentNode) {
            refSection.parentNode.insertBefore(section, refSection.nextSibling);
        }
    }

    // ========== PATCH switchResultsTab ==========
    function patchSwitchTab() {
        if (window._timerTabPatched) return;
        var origSwitch = window.switchResultsTab;
        if (typeof origSwitch !== 'function') { setTimeout(patchSwitchTab, 500); return; }

        window.switchResultsTab = function(tab) {
            // Hide timer section when switching to other tabs
            var timerSection = document.getElementById('timerSection');
            var timerBtn = document.getElementById('resultsTabTimer');
            if (timerSection) timerSection.style.display = 'none';
            if (timerBtn) timerBtn.classList.remove('active');
            origSwitch(tab);
        };
        window._timerTabPatched = true;
    }

    function switchToTimerTab() {
        // Use existing switchResultsTab to deactivate all other tabs
        var statsSection = document.getElementById('statsTabSection');
        var allSection = document.getElementById('allCabinetsSection');
        var autoV2Section = document.getElementById('autoRulesV2Section');
        var sortBar = document.getElementById('resultsSortBar');

        if (statsSection) statsSection.style.display = 'none';
        if (allSection) allSection.style.display = 'none';
        if (autoV2Section) autoV2Section.style.display = 'none';
        if (sortBar) sortBar.style.display = 'none';

        // Deactivate all tab buttons
        ['resultsTabActive', 'resultsTabAll', 'resultsTabAutoV2'].forEach(function(id) {
            var b = document.getElementById(id);
            if (b) b.classList.remove('active');
        });

        // Activate timer
        var timerBtn = document.getElementById('resultsTabTimer');
        var timerSection = document.getElementById('timerSection');
        if (timerBtn) timerBtn.classList.add('active');
        if (timerSection) {
            timerSection.style.display = 'block';
            renderTimerPanel();
        }

        // Track for switchResultsTab compatibility
        window.currentResultsTab = 'timer';
    }

    // ========== DATA ==========
    function getTopCampaignsByCab() {
        if (!window.lastResults || !window.lastResults.length) return [];
        // Use app's groupCampaignsByCabinet with onlyActive:false to get ALL campaigns
        var cabs;
        if (typeof window.groupCampaignsByCabinet === 'function') {
            cabs = window.groupCampaignsByCabinet(window.lastResults, {onlyActive: false});
        } else {
            cabs = groupFallback(window.lastResults);
        }
        // Sort campaigns by spend DESC, take top N per cab
        cabs.forEach(function(cab) {
            cab.campaigns.sort(function(a, b) {
                return (parseFloat(b.spend) || 0) - (parseFloat(a.spend) || 0);
            });
            cab.campaigns = cab.campaigns.slice(0, TOP_CAMPAIGNS);
        });
        return cabs;
    }

    function groupFallback(data) {
        var byCab = {};
        data.forEach(function(row) {
            var cabId = row.account_id || row.adaccount_id || 'unknown';
            if (!byCab[cabId]) byCab[cabId] = { id: cabId, name: row.account_name || row.adaccount_name || cabId, campaigns: [] };
            byCab[cabId].campaigns.push(row);
        });
        return Object.values(byCab);
    }

    // ========== STYLES ==========
    function injectStyles() {
        if (document.getElementById('timerUIStyles')) return;
        var s = document.createElement('style');
        s.id = 'timerUIStyles';
        s.textContent = "\
#timerSection { padding: 16px 0; }\
.timer-sub-tabs { display: flex; gap: 8px; margin-bottom: 16px; }\
.timer-sub-tab { padding: 8px 20px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; background: var(--bg-card, #fff); color: var(--text-secondary, #666); border: 1px solid var(--border, #e0e0e0); transition: all 0.2s; }\
.timer-sub-tab.active { background: #e94560; color: #fff; border-color: #e94560; }\
.timer-sub-tab:hover:not(.active) { background: var(--bg-hover, #f5f5f5); }\
.timer-cab { margin-bottom: 12px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border, #e0e0e0); background: var(--bg-card, #fff); }\
.timer-cab-hdr { padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: var(--bg-card, #fff); border-bottom: 1px solid var(--border, #e0e0e0); }\
.timer-cab-hdr:hover { background: var(--bg-hover, #f8f8f8); }\
.timer-camp { padding: 10px 16px 10px 24px; border-bottom: 1px solid var(--border-light, #f0f0f0); }\
.timer-camp-name { font-weight: 600; font-size: 14px; color: var(--text-primary, #333); margin-bottom: 4px; }\
.timer-camp-meta { font-size: 12px; color: var(--text-secondary, #888); margin-bottom: 6px; }\
.timer-adset-row { display: flex; align-items: center; gap: 10px; padding: 5px 0 5px 16px; }\
.timer-adset-row label { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; font-size: 13px; }\
.timer-adset-row input[type=checkbox] { width: 18px; height: 18px; accent-color: #e94560; cursor: pointer; }\
.timer-status { font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; }\
.timer-status-active { background: #e8f5e9; color: #2e7d32; }\
.timer-status-paused { background: #fff3e0; color: #e65100; }\
.timer-status-other { background: #f5f5f5; color: #666; }\
.timer-ads-toggle { font-size: 11px; color: #e94560; cursor: pointer; padding: 2px 0 2px 40px; }\
.timer-ads-list { padding-left: 52px; font-size: 11px; color: var(--text-secondary, #888); }\
.timer-ad-item { padding: 1px 0; }\
.timer-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px; margin-top: 16px; border-radius: 12px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e0e0e0); }\
.timer-sel-count { font-size: 14px; font-weight: 700; color: #e94560; }\
.timer-input { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border, #ccc); font-size: 14px; background: var(--bg-input, #fff); color: var(--text-primary, #333); }\
.timer-input:focus { outline: none; border-color: #e94560; }\
.timer-btn { padding: 10px 24px; border-radius: 8px; border: none; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.2s; }\
.timer-btn-go { background: #e94560; color: #fff; }\
.timer-btn-go:hover { background: #c81d45; }\
.timer-btn-go:disabled { background: #ccc; color: #888; cursor: not-allowed; }\
.timer-btn-clear { background: var(--bg-hover, #eee); color: var(--text-primary, #333); }\
.timer-btn-clear:hover { background: #ddd; }\
.timer-btn-del { background: #c62828; color: #fff; font-size: 11px; padding: 4px 12px; }\
.timer-btn-del:hover { background: #b71c1c; }\
.timer-active-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; background: var(--bg-card, #fff); border: 1px solid var(--border, #e0e0e0); }\
.timer-active-name { font-size: 14px; font-weight: 600; color: var(--text-primary, #333); }\
.timer-active-time { font-size: 13px; color: #e94560; font-weight: 600; }\
.timer-active-remain { font-size: 12px; color: var(--text-secondary, #888); }\
.timer-empty { text-align: center; padding: 40px; color: var(--text-secondary, #888); font-size: 14px; }\
.timer-kyiv { font-size: 13px; color: #e94560; font-weight: 600; margin-left: 12px; }\
.timer-select-all { font-size: 11px; color: #e94560; cursor: pointer; text-decoration: underline; margin-left: 16px; }\
        ";
        document.head.appendChild(s);
    }

    // ========== RENDER ==========
    function renderTimerPanel() {
        var section = document.getElementById('timerSection');
        if (!section) return;

        var kyiv = getKyivNow();
        var schedCount = Object.keys(window._scheduledEnables || {}).length;
        var h = '';

        // Sub-tabs + clock
        h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
        h += '<div class="timer-sub-tabs">';
        h += '<div class="timer-sub-tab' + (_subTab === 'setup' ? ' active' : '') + '" data-subtab="setup">Setup</div>';
        h += '<div class="timer-sub-tab' + (_subTab === 'active' ? ' active' : '') + '" data-subtab="active">Active (' + schedCount + ')</div>';
        h += '</div>';
        h += '<span class="timer-kyiv" id="timerKyivClock">' + fmtKyiv(kyiv) + ' Kyiv</span>';
        h += '</div>';

        if (_subTab === 'setup') {
            h += renderSetup();
        } else {
            h += renderActive();
        }

        section.innerHTML = h;
        bindTimerEvents(section);

        // Clock ticker
        clearInterval(_timerRefreshId);
        _timerRefreshId = setInterval(function() {
            var clock = document.getElementById('timerKyivClock');
            if (clock) clock.textContent = fmtKyiv(getKyivNow()) + ' Kyiv';
            // Refresh active timers countdown
            if (_subTab === 'active') updateActiveCountdowns();
        }, 1000);
    }

    // ========== PROFILE GROUPING HELPERS ==========
    var _expandedProfiles = {};

    function getProfileForCab(cabId) {
        if (!window.lastResults || !window.lastResults.length) return 'Default';
        for (var i = 0; i < window.lastResults.length; i++) {
            var row = window.lastResults[i];
            if ((row.account_id || row.adaccount_id) === cabId && row.profile_name) {
                return row.profile_name;
            }
        }
        return 'Default';
    }

    function groupCabsByProfile(cabs) {
        var profiles = {};
        cabs.forEach(function(cab) {
            var pName = getProfileForCab(cab.id || 'unknown');
            if (!profiles[pName]) profiles[pName] = [];
            profiles[pName].push(cab);
        });
        return profiles;
    }

    function renderCabBlock(cab) {
        var cabId = cab.id || 'unknown';
        var isOpen = !!_expandedCabs[cabId];
        var cabSelCount = 0;
        var cabTotal = 0;
        cab.campaigns.forEach(function(c) {
            (c.adsets || []).forEach(function(a) {
                cabTotal++;
                if (_selectedAdsets[a.id || a.adset_id]) cabSelCount++;
            });
        });

        var h = '';
        h += '<div class="timer-cab">';
        h += '<div class="timer-cab-hdr" data-cab-id="' + cabId + '">';
        h += '<div>';
        h += '<span style="font-weight:700;font-size:15px;color:var(--text-primary,#333);">' + (isOpen ? '▼' : '▶') + ' ' + esc(cab.name || cabId) + '</span>';
        if (cabSelCount > 0) h += ' <span style="color:#e94560;font-size:12px;font-weight:600;">[' + cabSelCount + ' sel]</span>';
        h += '</div>';
        h += '<span style="font-size:12px;color:var(--text-secondary,#888);">' + cabId + ' | ' + cab.campaigns.length + ' camp, ' + cabTotal + ' adsets</span>';
        h += '</div>';

        if (isOpen) {
            cab.campaigns.forEach(function(camp) {
                var campId = camp.campaign_id || camp.id || '';
                var campSpend = (typeof calculateActualSpend === 'function') ? calculateActualSpend(camp) : (parseFloat(camp.spend) || 0);
                var campLeads = (typeof calculateTotalLeads === 'function') ? calculateTotalLeads(camp) : (parseInt(camp.leads) || 0);
                var campStatus = camp.campaign_status || camp.campaign_effective_status || '';

                h += '<div class="timer-camp">';
                h += '<div class="timer-camp-name">' + esc(camp.campaign_name || camp.name || 'Campaign') + '</div>';
                h += '<div class="timer-camp-meta">';
                h += '<span class="timer-status ' + statusClass(campStatus) + '">' + campStatus + '</span>';
                h += ' Spend: $' + campSpend.toFixed(2) + ' | Leads: ' + campLeads;
                h += ' <span class="timer-select-all" data-selcamp="' + campId + '">select all</span>';
                h += '</div>';

                (camp.adsets || []).forEach(function(adset) {
                    var aId = adset.id || adset.adset_id || '';
                    var aStatus = String(adset.status || adset.effective_status || '').toUpperCase();
                    var checked = _selectedAdsets[aId] ? ' checked' : '';
                    var adsKey = aId + '_ads';

                    h += '<div class="timer-adset-row">';
                    h += '<label><input type="checkbox" data-adset="' + aId + '"' + checked + '>';
                    h += '<span>' + esc(adset.name || adset.adset_name || 'Adset') + '</span>';
                    h += '<span class="timer-status ' + statusClass(aStatus) + '">' + aStatus + '</span>';
                    h += '</label>';
                    h += '</div>';

                    if (adset.ads && adset.ads.length) {
                        var adsOpen = !!_expandedAds[adsKey];
                        h += '<div class="timer-ads-toggle" data-adskey="' + adsKey + '">' + (adsOpen ? '▼' : '▶') + ' ' + adset.ads.length + ' ads</div>';
                        if (adsOpen) {
                            h += '<div class="timer-ads-list">';
                            adset.ads.forEach(function(ad) {
                                h += '<div class="timer-ad-item">• ' + esc(ad.name || ad.ad_name || 'Ad') + ' <span style="opacity:0.6;">(' + (ad.status || '') + ')</span></div>';
                            });
                            h += '</div>';
                        }
                    }
                });
                h += '</div>'; // timer-camp
            });
        }
        h += '</div>'; // timer-cab
        return h;
    }

    function renderSetup() {
        var cabs = getTopCampaignsByCab();
        if (!cabs.length) {
            return '<div class="timer-empty"><div style="font-size:48px;margin-bottom:12px;">📭</div>No campaign data. Load data on Step 3 first.</div>';
        }

        // Group cabs by profile
        var profileGroups = groupCabsByProfile(cabs);
        var profileNames = Object.keys(profileGroups).sort();

        var h = '';
        profileNames.forEach(function(pName) {
            var pCabs = profileGroups[pName];
            var pOpen = _expandedProfiles[pName] !== false; // open by default
            var pSelCount = 0;
            var pTotal = 0;
            pCabs.forEach(function(cab) {
                cab.campaigns.forEach(function(c) {
                    (c.adsets || []).forEach(function(a) {
                        pTotal++;
                        if (_selectedAdsets[a.id || a.adset_id]) pSelCount++;
                    });
                });
            });

            h += '<div style="margin-bottom:16px;">';
            h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border-radius:10px;cursor:pointer;margin-bottom:8px;" data-profile-toggle="' + esc(pName) + '">';
            h += '<div style="display:flex;align-items:center;gap:10px;">';
            h += '<span style="font-size:15px;font-weight:700;">' + (pOpen ? '▼' : '▶') + ' 👤 ' + esc(pName) + '</span>';
            h += '<span style="font-size:12px;opacity:0.85;">(' + pCabs.length + ' cabs, ' + pTotal + ' adsets)</span>';
            if (pSelCount > 0) h += ' <span style="background:rgba(255,255,255,0.3);padding:2px 8px;border-radius:4px;font-size:11px;">' + pSelCount + ' sel</span>';
            h += '</div>';
            h += '<div style="display:flex;gap:8px;">';
            h += '<span class="timer-select-all" data-selprofile="' + esc(pName) + '" style="color:#fff;font-size:12px;">Select All</span>';
            h += '<span class="timer-select-all" data-deselprofile="' + esc(pName) + '" style="color:rgba(255,255,255,0.7);font-size:12px;">Deselect</span>';
            h += '</div>';
            h += '</div>';

            if (pOpen) {
                pCabs.forEach(function(cab) {
                    h += renderCabBlock(cab);
                });
            }
            h += '</div>';
        });

        // Controls
        var sc = selectedCount();
        h += '<div class="timer-controls">';
        h += '<span class="timer-sel-count">' + sc + ' adsets selected</span>';
        h += '<input type="date" class="timer-input" id="timerDate" value="' + fmtDateInput(getKyivNow()) + '">';
        h += '<input type="time" class="timer-input" id="timerTime" value="05:00">';
        h += '<button class="timer-btn timer-btn-go" id="timerGoBtn"' + (sc === 0 ? ' disabled' : '') + '>⏰ Schedule Launch</button>';
        h += '<button class="timer-btn timer-btn-clear" id="timerClearBtn">Clear</button>';
        h += '</div>';

        return h;
    }

    function renderActive() {
        var timers = window._scheduledEnables || {};
        var keys = Object.keys(timers);
        if (!keys.length) {
            return '<div class="timer-empty"><div style="font-size:48px;margin-bottom:12px;">✅</div>No active timers.</div>';
        }

        var kyiv = getKyivNow();
        var h = '';
        keys.forEach(function(id) {
            var t = timers[id];
            var remainMs = t.time.getTime() - kyiv.getTime();
            var remainMin = Math.max(0, Math.round(remainMs / 60000));
            var remainStr = remainMin >= 60 ? Math.floor(remainMin/60) + 'h ' + (remainMin%60) + 'm' : remainMin + ' min';

            h += '<div class="timer-active-row" data-timer-id="' + id + '">';
            h += '<div>';
            h += '<div class="timer-active-name">' + esc(t.adsetName || id) + '</div>';
            h += '<div class="timer-active-time">Enable: ' + t.label + '</div>';
            h += '<div class="timer-active-remain" data-remain-id="' + id + '">In ' + remainStr + '</div>';
            h += '</div>';
            h += '<button class="timer-btn timer-btn-del" data-cancel="' + id + '">Cancel</button>';
            h += '</div>';
        });

        h += '<div style="margin-top:12px;text-align:right;">';
        h += '<button class="timer-btn timer-btn-del" id="timerCancelAll" style="font-size:12px;padding:8px 16px;">Cancel All (' + keys.length + ')</button>';
        h += '</div>';
        return h;
    }

    function updateActiveCountdowns() {
        var timers = window._scheduledEnables || {};
        var kyiv = getKyivNow();
        Object.keys(timers).forEach(function(id) {
            var el = document.querySelector('[data-remain-id="' + id + '"]');
            if (!el) return;
            var remainMs = timers[id].time.getTime() - kyiv.getTime();
            var remainMin = Math.max(0, Math.round(remainMs / 60000));
            el.textContent = 'In ' + (remainMin >= 60 ? Math.floor(remainMin/60) + 'h ' + (remainMin%60) + 'm' : remainMin + ' min');
        });
    }

    function statusClass(s) {
        s = (s || '').toUpperCase();
        if (s.includes('ACTIVE')) return 'timer-status-active';
        if (s.includes('PAUSED')) return 'timer-status-paused';
        return 'timer-status-other';
    }

    // ========== EVENTS ==========
    function bindTimerEvents(root) {
        // Sub-tab switching
        root.querySelectorAll('.timer-sub-tab').forEach(function(el) {
            el.addEventListener('click', function() {
                _subTab = this.getAttribute('data-subtab');
                renderTimerPanel();
            });
        });

        // Cabinet expand
        root.querySelectorAll('.timer-cab-hdr').forEach(function(el) {
            el.addEventListener('click', function() {
                var id = this.getAttribute('data-cab-id');
                _expandedCabs[id] = !_expandedCabs[id];
                renderTimerPanel();
            });
        });

        // Adset checkboxes
        root.querySelectorAll('input[data-adset]').forEach(function(cb) {
            cb.addEventListener('change', function(e) {
                e.stopPropagation();
                var id = this.getAttribute('data-adset');
                if (this.checked) {
                    var nameEl = this.parentElement.querySelector('span');
                    _selectedAdsets[id] = { name: nameEl ? nameEl.textContent : id };
                } else {
                    delete _selectedAdsets[id];
                }
                renderTimerPanel();
            });
        });

        // Select all for campaign
        root.querySelectorAll('[data-selcamp]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var campId = this.getAttribute('data-selcamp');
                var cabs = getTopCampaignsByCab();
                cabs.forEach(function(cab) {
                    cab.campaigns.forEach(function(c) {
                        if ((c.campaign_id || c.id) === campId) {
                            (c.adsets || []).forEach(function(a) {
                                var aId = a.id || a.adset_id;
                                _selectedAdsets[aId] = { name: a.name || a.adset_name || aId };
                            });
                        }
                    });
                });
                renderTimerPanel();
            });
        });

        // Profile toggle
        root.querySelectorAll('[data-profile-toggle]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                if (e.target.hasAttribute('data-selprofile') || e.target.hasAttribute('data-deselprofile')) return;
                var pName = this.getAttribute('data-profile-toggle');
                _expandedProfiles[pName] = _expandedProfiles[pName] === false ? true : false;
                renderTimerPanel();
            });
        });

        // Profile select all
        root.querySelectorAll('[data-selprofile]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var pName = this.getAttribute('data-selprofile');
                var cabs = getTopCampaignsByCab();
                cabs.forEach(function(cab) {
                    if (getProfileForCab(cab.id || 'unknown') === pName) {
                        cab.campaigns.forEach(function(c) {
                            (c.adsets || []).forEach(function(a) {
                                var aId = a.id || a.adset_id;
                                _selectedAdsets[aId] = { name: a.name || a.adset_name || aId };
                            });
                        });
                    }
                });
                renderTimerPanel();
            });
        });

        // Profile deselect all
        root.querySelectorAll('[data-deselprofile]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var pName = this.getAttribute('data-deselprofile');
                var cabs = getTopCampaignsByCab();
                cabs.forEach(function(cab) {
                    if (getProfileForCab(cab.id || 'unknown') === pName) {
                        cab.campaigns.forEach(function(c) {
                            (c.adsets || []).forEach(function(a) {
                                var aId = a.id || a.adset_id;
                                delete _selectedAdsets[aId];
                            });
                        });
                    }
                });
                renderTimerPanel();
            });
        });

        // Ads toggle
        root.querySelectorAll('.timer-ads-toggle').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var key = this.getAttribute('data-adskey');
                _expandedAds[key] = !_expandedAds[key];
                renderTimerPanel();
            });
        });

        // Schedule button
        var goBtn = root.querySelector('#timerGoBtn');
        if (goBtn) {
            goBtn.addEventListener('click', function() {
                var dateVal = root.querySelector('#timerDate').value;
                var timeVal = root.querySelector('#timerTime').value;
                if (!dateVal || !timeVal) { alert('Select date and time'); return; }
                var timeStr = dateVal + ' ' + timeVal;
                var ids = Object.keys(_selectedAdsets);
                if (!ids.length) { alert('Select at least one adset'); return; }
                if (!confirm('Schedule ' + ids.length + ' adsets to enable at ' + timeStr + ' Kyiv?')) return;

                if (typeof window.scheduleEnableBatch === 'function') {
                    window.scheduleEnableBatch(ids, timeStr);
                } else {
                    ids.forEach(function(id) { window.scheduleEnable(id, timeStr); });
                }
                _selectedAdsets = {};
                _subTab = 'active';
                renderTimerPanel();
            });
        }

        // Clear
        var clearBtn = root.querySelector('#timerClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', function() {
                _selectedAdsets = {};
                renderTimerPanel();
            });
        }

        // Cancel individual
        root.querySelectorAll('[data-cancel]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = this.getAttribute('data-cancel');
                if (confirm('Cancel timer?')) {
                    window.cancelScheduled(id);
                    renderTimerPanel();
                }
            });
        });

        // Cancel all
        var cancelAll = root.querySelector('#timerCancelAll');
        if (cancelAll) {
            cancelAll.addEventListener('click', function() {
                if (confirm('Cancel ALL timers?')) {
                    window.cancelAllScheduled();
                    renderTimerPanel();
                }
            });
        }
    }

    // ========== INIT ==========
    function init() {
        if (!window._scheduledEnables) {
            console.log('[TIMER-UI] Waiting for scheduled_enable.js...');
            setTimeout(init, 500);
            return;
        }
        injectStyles();
        injectTabButton();
        patchSwitchTab();
        console.log('[TIMER-UI] ✅ Timer UI loaded. Tab "Timer" added to Step 4.');
    }

    // Wait for DOM + app ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 1500); });
    } else {
        setTimeout(init, 1500);
    }
})();
