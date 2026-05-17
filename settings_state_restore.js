// === SETTINGS STATE RESTORE ===
// Зберігає поточний крок і дані між переходами на сторінку Налаштувань.
// При поверненні "Назад до панелі" (повний reload) — автоматично відновлює
// крок, вибрані аккаунти/кабінети і дані результатів.
// Disable працює ТІЛЬКИ якщо в localStorage є збережений крок > 1.

(function(){
    'use strict';

    var LS_KEY = 'crm_step_state';

    // ========================================================================
    // SAVE: перехоплюємо showStep щоб зберігати номер кроку
    // ========================================================================
    var _origShowStep = window.showStep;

    function patchShowStep() {
        // showStep визначена всередині DOMContentLoaded closure,
        // тому ми патчимо її через MutationObserver або напряму коли доступна.
        // Використовуємо monkey-patch на рівні DOM — перехоплюємо onclick кнопок навігації.

        // Зберігаємо крок при кожному виклику showStep
        var origShowStep = null;

        // Шукаємо showStep в глобальному scope (вона може бути глобальною або в closure)
        // Оскільки goToStep1, goToStep2Direct і т.д. викликають showStep напряму,
        // ми перехоплюємо їх.

        // Патч goToStep* функцій
        var stepFunctions = {
            'goToStep1': 1,
            'goToStep2': 2,
            'goToStep2Direct': 2,
            'goToStep3': 3,
            'goToStep4': 4
        };

        Object.keys(stepFunctions).forEach(function(fnName) {
            var origFn = window[fnName];
            if (typeof origFn === 'function') {
                window[fnName] = function() {
                    var result = origFn.apply(this, arguments);
                    // Зберігаємо крок ПІСЛЯ виклику (щоб переконатись що перехід відбувся)
                    saveCurrentStep(stepFunctions[fnName]);
                    // Якщо результат — Promise (async функція), зберігаємо після resolve
                    if (result && typeof result.then === 'function') {
                        result.then(function() {
                            saveCurrentStep(stepFunctions[fnName]);
                        });
                    }
                    return result;
                };
                console.log('[STATE-RESTORE] Patched ' + fnName);
            }
        });
    }

    function saveCurrentStep(stepNumber) {
        try {
            var state = {
                step: stepNumber,
                timestamp: Date.now(),
                // Зберігаємо cabinetsToUpdate якщо є
                cabinetsToUpdate: window.cabinetsToUpdate
                    ? Array.from(window.cabinetsToUpdate)
                    : [],
                // Зберігаємо cabinetsPaused якщо є
                cabinetsPaused: window.cabinetsPaused
                    ? Array.from(window.cabinetsPaused)
                    : []
            };
            localStorage.setItem(LS_KEY, JSON.stringify(state));
            console.log('[STATE-RESTORE] Saved step ' + stepNumber);
        } catch(e) {
            console.warn('[STATE-RESTORE] Save error:', e);
        }
    }

    // Зберігаємо крок також перед виходом зі сторінки (перехід в Налаштування)
    window.addEventListener('beforeunload', function() {
        // Визначаємо поточний крок по активному .step елементу
        var activeStep = document.querySelector('.step.active');
        if (activeStep) {
            var match = activeStep.id && activeStep.id.match(/step(\d+)/);
            if (match) {
                saveCurrentStep(parseInt(match[1]));
            }
        }
    });

    // ========================================================================
    // RESTORE: при завантаженні сторінки відновлюємо крок
    // ========================================================================
    function restoreState() {
        try {
            var saved = localStorage.getItem(LS_KEY);
            if (!saved) return;

            var state = JSON.parse(saved);
            var step = state.step;

            // Не відновлюємо якщо крок 1 (і так дефолт)
            if (!step || step <= 1) return;

            // Не відновлюємо якщо стан старший за 24 години
            if (state.timestamp && (Date.now() - state.timestamp) > 24 * 3600 * 1000) {
                console.log('[STATE-RESTORE] State too old, skipping restore');
                localStorage.removeItem(LS_KEY);
                return;
            }

            console.log('[STATE-RESTORE] Restoring to step ' + step);

            // Відновлюємо cabinetsToUpdate
            if (state.cabinetsToUpdate && state.cabinetsToUpdate.length > 0) {
                window.cabinetsToUpdate = new Set(state.cabinetsToUpdate);
                // Також AppState якщо використовується
                if (window.AppState) {
                    window.AppState.cabinetsToUpdate = window.cabinetsToUpdate;
                }
                console.log('[STATE-RESTORE] Restored cabinetsToUpdate:', state.cabinetsToUpdate.length);
            }

            if (state.cabinetsPaused && state.cabinetsPaused.length > 0) {
                window.cabinetsPaused = new Set(state.cabinetsPaused);
                if (window.AppState) {
                    window.AppState.cabinetsPaused = window.cabinetsPaused;
                }
            }

            // Чекаємо поки loadAccounts() закінчить (рендер аккаунтів),
            // потім автоматично переходимо на збережений крок.
            waitForAccountsAndRestore(step);

        } catch(e) {
            console.warn('[STATE-RESTORE] Restore error:', e);
        }
    }

    function waitForAccountsAndRestore(targetStep) {
        var attempts = 0;
        var maxAttempts = 50; // 5 секунд максимум

        var interval = setInterval(function() {
            attempts++;

            // Перевіряємо чи аккаунти вже завантажились
            var accountsList = document.getElementById('accountsList');
            var hasAccounts = accountsList &&
                accountsList.querySelectorAll('input[type="checkbox"]').length > 0;

            if (!hasAccounts && attempts < maxAttempts) return;

            clearInterval(interval);

            if (!hasAccounts) {
                console.warn('[STATE-RESTORE] Accounts not loaded after 5s, aborting restore');
                return;
            }

            console.log('[STATE-RESTORE] Accounts loaded, restoring to step ' + targetStep);

            // Перевіряємо що selectedAccounts відновлено
            var selectedAccounts = window.selectedAccounts || [];
            if (window.AppState) {
                selectedAccounts = window.AppState.selectedAccounts || selectedAccounts;
            }

            if (selectedAccounts.length === 0) {
                console.warn('[STATE-RESTORE] No selected accounts, staying at step 1');
                return;
            }

            // Крок 2+: завантажуємо кабінети
            if (targetStep >= 2) {
                autoLoadCabinetsAndGo(targetStep);
            }
        }, 100);
    }

    function autoLoadCabinetsAndGo(targetStep) {
        // Використовуємо той самий API що й goToStep2()
        var selectedAccounts = window.selectedAccounts || [];
        if (window.AppState) {
            selectedAccounts = window.AppState.selectedAccounts || selectedAccounts;
        }

        console.log('[STATE-RESTORE] Loading cabinets for', selectedAccounts.length, 'accounts...');

        fetch('/api/adaccounts', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({account_ids: selectedAccounts})
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (!data.success) {
                console.error('[STATE-RESTORE] Failed to load cabinets:', data.error);
                return;
            }

            // Встановлюємо дані кабінетів
            window.adaccounts = data.adaccounts;
            if (window.AppState) {
                window.AppState.adaccounts = data.adaccounts;
            }

            // Рендеримо кабінети
            if (typeof window.renderAdaccounts === 'function') {
                window.renderAdaccounts();
            }

            // Переходимо на потрібний крок
            // Використовуємо showStep напряму (без goToStep* щоб не trigger'ити перевірки)
            var stepEl = document.getElementById('step' + targetStep);
            if (stepEl) {
                document.querySelectorAll('.step').forEach(function(s) {
                    s.classList.remove('active');
                });
                stepEl.classList.add('active');
                console.log('[STATE-RESTORE] ✅ Restored to step ' + targetStep);

                // Якщо крок 4 — синхронізуємо кнопки
                if (targetStep === 4 && typeof window.syncStep4Buttons === 'function') {
                    window.syncStep4Buttons();
                }

                // Завантажуємо автоправила якщо потрібно
                if (typeof window.loadAutoRulesV2Settings === 'function') {
                    window.loadAutoRulesV2Settings();
                }
            }
        })
        .catch(function(err) {
            console.error('[STATE-RESTORE] Fetch error:', err);
        });
    }

    // ========================================================================
    // INIT
    // ========================================================================

    // Патчимо навігацію одразу
    // Але goToStep* можуть бути ще не визначені (вони в DOMContentLoaded closure)
    // Тому чекаємо DOMContentLoaded + невеликий delay
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(function() {
                patchShowStep();
                restoreState();
            }, 200);
        });
    } else {
        setTimeout(function() {
            patchShowStep();
            restoreState();
        }, 200);
    }

    console.log('[STATE-RESTORE] Loaded');
})();
