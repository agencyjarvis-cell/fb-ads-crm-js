#!/usr/bin/env python3
"""CRM Refresh Server v5 — port 5099
Combines cache serving + CDP scraping in one process.
Endpoints:
  GET  /api/refresh-crm  — return cached data (fast)
  POST /api/refresh-crm  — scrape CRM via Brave CDP, update cache, return fresh data
  POST /api/scrape        — alias for POST refresh-crm
"""
import json, os, sys, time, urllib.request, urllib.parse, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

BASE = '/Volumes/untitled/downloads/FB_Ads_CRM_Distribution'
BRAVE_PORT = 9223
SETTINGS = os.path.join(BASE, 'app_settings.json')
CACHE = os.path.join(BASE, 'FB_Ads_CRM.app', 'Contents', 'Frameworks', 'crm_cache.json')

try:
    import websocket
    HAS_WS = True
except ImportError:
    HAS_WS = False
    print("[server] WARNING: websocket-client not installed. Scraping disabled.")

scrape_lock = threading.Lock()

def get_crm_url():
    try:
        with open(SETTINGS) as f: s = json.load(f)
        bid = s.get('crm_buyer_id', '64')
    except: bid = '64'
    now = datetime.now()
    ds = now.strftime('%Y-%m-%d') + ' 00:00:00'
    de = now.strftime('%Y-%m-%d') + ' 23:59:59'
    p = urllib.parse.urlencode({'scroll':'707','page_size':'100','pagination_page':'',
        'type':'','payout_type':'','target':'all','date_start':ds,'date_end':de,
        'utm_campaign':'','utm_content':'','utm_term':'','utm_source':'',
        'landing_name':'','domain':'','link_parameters':'','buyers[]':bid})
    return f"https://crm.apex-team.pro/view/statistics/buyers.php?{p}"

def find_crm_tab():
    try:
        data = urllib.request.urlopen(f'http://127.0.0.1:{BRAVE_PORT}/json/list').read()
        tabs = json.loads(data)
        for t in tabs:
            if 'apex-team.pro' in t.get('url', ''):
                return t
    except: pass
    return None

def scrape_crm():
    """Scrape CRM via Brave CDP. Returns dict or None on error."""
    if not HAS_WS:
        return None
    if not scrape_lock.acquire(blocking=False):
        return {'error': 'Scrape already in progress', 'busy': True}
    try:
        print("[scraper] Starting CDP scrape...", flush=True)
        ver = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{BRAVE_PORT}/json/version').read())
        bws = ver.get('webSocketDebuggerUrl')
        if not bws: return None

        crm_tab = find_crm_tab()
        crm_url = get_crm_url()
        created_tab = False

        ws = websocket.create_connection(bws, timeout=30)
        mid = [1]
        def cdp(method, params=None, sid=None):
            m = {'id': mid[0], 'method': method}
            if params: m['params'] = params
            if sid: m['sessionId'] = sid
            ws.send(json.dumps(m)); mid[0] += 1
            while True:
                r = json.loads(ws.recv())
                if r.get('id') == mid[0]-1: return r

        if crm_tab:
            tid = crm_tab.get('id')
            r = cdp('Target.attachToTarget', {'targetId': tid, 'flatten': True})
            if 'error' in r: ws.close(); return None
            session_id = r['result']['sessionId']
            cdp('Page.navigate', {'url': crm_url}, session_id)
        else:
            r = cdp('Target.createTarget', {'url': crm_url})
            if 'error' in r: ws.close(); return None
            tid = r['result']['targetId']
            created_tab = True
            r = cdp('Target.attachToTarget', {'targetId': tid, 'flatten': True})
            if 'error' in r:
                cdp('Target.closeTarget', {'targetId': tid})
                ws.close(); return None
            session_id = r['result']['sessionId']

        time.sleep(12)
        cdp('Runtime.evaluate', {'expression': 'window.scrollTo(0,document.body.scrollHeight)'}, session_id)
        time.sleep(2)
        cdp('Runtime.evaluate', {'expression': 'window.scrollTo(0,0)'}, session_id)
        time.sleep(2)

        js = """(function(){var r=[];var h3s=document.querySelectorAll('h3');var sec=null;for(var i=0;i<h3s.length;i++){var t=h3s[i].textContent.trim();if(t.indexOf('Creative')!==-1&&t.toLowerCase().indexOf('leads')!==-1){sec=h3s[i].closest('.frame')||h3s[i].parentElement;break;}}if(!sec)return JSON.stringify({error:'Creative leads section not found',h3s:Array.from(h3s).map(h=>h.textContent.trim())});var sb=sec.querySelector('div.dataTables_scrollBody');if(!sb)return JSON.stringify({error:'scrollBody not found'});var tb=sb.querySelector('tbody');if(!tb)return JSON.stringify({error:'tbody not found'});var rows=tb.querySelectorAll("tr[role='row']");for(var j=0;j<rows.length;j++){var ne=rows[j].querySelector('div.statistic-type-name');if(!ne)continue;var n=ne.textContent.trim();var cells=rows[j].querySelectorAll('td');var l=0;if(cells.length>=2)l=parseInt(cells[1].textContent.trim())||0;if(n)r.push({campaign_name:n,leads:l});}return JSON.stringify({success:true,data:r});})()"""
        resp = cdp('Runtime.evaluate', {'expression': js, 'returnByValue': True}, session_id)

        if created_tab and tid:
            cdp('Target.closeTarget', {'targetId': tid})
        ws.close()

        if 'result' in resp and 'result' in resp['result']:
            val = resp['result']['result'].get('value','{}')
            parsed = json.loads(val)
            if parsed.get('success'):
                camps = parsed['data']
                total = sum(c.get('leads',0) for c in camps)
                result = {'data': camps, 'total_campaigns': len(camps),
                          'total_leads': total,
                          'timestamp': datetime.now().isoformat(), 'source': 'crm_scraper'}
                with open(CACHE, 'w') as f: json.dump(result, f, ensure_ascii=False, indent=2)
                print(f"[scraper] OK: {len(camps)} campaigns, {total} leads", flush=True)
                return result
            else:
                print(f"[scraper] Parse error: {parsed.get('error')}", flush=True)
        return None
    except Exception as e:
        print(f"[scraper] Error: {e}", flush=True)
        return None
    finally:
        scrape_lock.release()

def read_cache():
    try:
        with open(CACHE) as f: return json.load(f)
    except: return {'data':[], 'total_campaigns':0, 'total_leads':0}

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json_response(self, data, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if '/api/refresh-crm' in self.path:
            d = read_cache()
            self._json_response({'success':True, 'data':d.get('data',[]),
                'total_campaigns':d.get('total_campaigns',0),
                'total_leads':d.get('total_leads',0),
                'campaigns':d.get('total_campaigns',0),
                'leads':d.get('total_leads',0),
                'timestamp':d.get('timestamp',''),
                'source':d.get('source','cache')})
        else:
            self._json_response({'error':'not found'}, 404)

    def do_POST(self):
        if '/api/refresh-crm' in self.path or '/api/scrape' in self.path:
            result = scrape_crm()
            if result and result.get('busy'):
                self._json_response({'success':False, 'error':'Scrape in progress, try again'}, 429)
            elif result:
                self._json_response({'success':True,
                    'campaigns':result['total_campaigns'],
                    'leads':result['total_leads'],
                    'data':result['data'],
                    'timestamp':result['timestamp'],
                    'message':'CRM scraped fresh via CDP'})
            else:
                d = read_cache()
                self._json_response({'success':True,
                    'campaigns':d.get('total_campaigns',0),
                    'leads':d.get('total_leads',0),
                    'data':d.get('data',[]),
                    'timestamp':d.get('timestamp',''),
                    'message':'Scrape failed, returning cached data',
                    'cached':True})
        else:
            self._json_response({'error':'not found'}, 404)

    def log_message(self, format, *args):
        print(f"[5099] {args[0]}", flush=True)

if __name__ == '__main__':
    port = 5099
    server = HTTPServer(('', port), Handler)
    print(f"[CRM Server v5] Running on port {port}", flush=True)
    print(f"[CRM Server v5] GET  /api/refresh-crm = read cache", flush=True)
    print(f"[CRM Server v5] POST /api/refresh-crm = scrape + update", flush=True)
    server.serve_forever()
