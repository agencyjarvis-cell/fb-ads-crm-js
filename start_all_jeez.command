#!/bin/bash
# ============================================================
# FB Ads CRM — Полный запуск (Jeez)
# ============================================================
# 1. Brave с remote debugging
# 2. CRM binary
# 3. CRM scraper
# 4. Auto-reload config from app_settings.json
# ============================================================

CRM_DIR="/Volumes/untitled/downloads/FB_Ads_CRM_Distribution"
SCRAPER="/Users/jeez/Downloads/crm_scraper.py"

echo "🚀 Запуск FB Ads CRM..."

# --- Step 1: Brave browser with remote debugging ---
echo "  [1/4] Brave browser..."
if ! lsof -i :9223 > /dev/null 2>&1; then
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' \
        '--remote-debugging-port=9223' \
        '--remote-allow-origins=*' \
        '--user-data-dir=/Users/jeez/Library/Application Support/BraveSoftware/Brave-Browser' \
        '--profile-directory=Profile 1' &
    sleep 3
else
    echo "    (уже запущен на порту 9223)"
fi

# --- Step 2: CRM application ---
echo "  [2/4] CRM application..."
cd "$CRM_DIR" && ./FB_Ads_CRM.app/Contents/MacOS/FB_Ads_CRM &
CRM_PID=$!

# --- Step 3: CRM scraper ---
echo "  [3/4] CRM scraper..."
if [ -f "$SCRAPER" ]; then
    python3 "$SCRAPER" &
else
    echo "    ⚠️  crm_scraper.py не найден: $SCRAPER"
fi

# --- Step 4: Auto-reload config from app_settings.json ---
echo "  [4/4] Ожидание CRM и загрузка настроек..."
for i in $(seq 1 30); do
    if curl -s http://localhost:5001/api/settings > /dev/null 2>&1; then
        # Trigger reload_config_from_settings() — reads app_settings.json into globals
        curl -s -X POST 'http://localhost:5001/api/settings' \
            -H 'Content-Type: application/json' \
            -d '{}' > /dev/null 2>&1
        echo "    ✅ Настройки загружены из app_settings.json"
        break
    fi
    sleep 1
done

echo ""
echo "============================================================"
echo "  ✅ Всё запущено!"
echo "  📍 CRM: http://localhost:5001"
echo "  📍 Brave CDP: localhost:9223"
echo "============================================================"
