// Фотобатл-бот для Telegram (grammY + JSON-сховище)
// Формат: фото збираються в чергу, кожні BATTLE_SIZE фото → пост-батл у каналі з голосуванням.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Bot, InlineKeyboard, GrammyError } = require('grammy');

// ───────────────────────── НАЛАШТУВАННЯ ─────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const CHANNEL_ID = process.env.CHANNEL_ID; // @mychannel або -100xxxxxxxxxx
const REQUIRE_SUB = process.env.REQUIRE_SUBSCRIPTION === 'true';
const ANONYMOUS = process.env.ANONYMOUS !== 'false';          // не показувати ніки в каналі
const MODERATION = process.env.MODERATION === 'true';         // true = адмін перевіряє кожне фото
const BATTLE_SIZE = Math.min(10, Math.max(2, Number(process.env.BATTLE_SIZE) || 2));
const AUTO_CLOSE_HOURS = Number(process.env.AUTO_CLOSE_HOURS) || 0; // 0 = закривати вручну
const BATTLE_TEXT = process.env.BATTLE_TEXT ||
  '⚔️ <b>Батл №{n}</b>\n\nЯке фото краще? Голосуй кнопками під постом 👇';

const CONTEST = {
  theme: process.env.THEME || 'Вільна тема',
  prize: process.env.PRIZE || 'Приз ще уточнюється 🎁',
  deadline: process.env.DEADLINE || '',
  votingEnd: process.env.VOTING_END || 'буде оголошено',
};

if (!BOT_TOKEN) throw new Error('Немає BOT_TOKEN у .env');
if (!CHANNEL_ID) throw new Error('Немає CHANNEL_ID у .env');
if (!ADMIN_IDS.length) console.warn('⚠️ ADMIN_IDS порожній — адмін-команди нікому не доступні');

// ───────────────────────── СХОВИЩЕ ─────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
let db = {
  settings: { submissions: false, voting: true, nextNumber: 1, nextBattle: 1, startedAt: null },
  entries: {}, // userId -> entry
  battles: {}, // battleId -> battle
};
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
db.battles ||= {};
db.settings.nextBattle ||= 1;
const save = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const isAdmin = (id) => ADMIN_IDS.includes(id);
const entries = () => Object.values(db.entries);
const queue = () => entries()
  .filter((e) => e.status === 'approved' && !e.battleId)
  .sort((a, b) => a.approvedAt - b.approvedAt);
const inBattles = () => entries().filter((e) => e.status === 'approved' && e.battleId);
const byNumber = (n) => entries().find((e) => e.number === n && e.status === 'approved');
const esc = (s = '') => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const who = (u) => (u.username ? '@' + u.username : esc(u.first_name || 'без імені'));
const channelLink = CHANNEL_ID.startsWith('@') ? `https://t.me/${CHANNEL_ID.slice(1)}` : null;
const postLink = (msgId) => (channelLink ? `${channelLink}/${msgId}` : '');
const fmtTime = (ts) => new Date(ts).toLocaleString('uk-UA', {
  timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
const deadlineText = () => {
  if (CONTEST.deadline) return CONTEST.deadline;
  if (AUTO_CLOSE_HOURS && db.settings.startedAt) return fmtTime(db.settings.startedAt + AUTO_CLOSE_HOURS * 3600e3);
  return AUTO_CLOSE_HOURS ? `${AUTO_CLOSE_HOURS} год. від старту` : 'буде оголошено';
};
const submitState = () =>
  db.settings.submissions ? 'open' : db.settings.startedAt ? 'closed' : 'not_started';

// ───────────────────────── ТЕКСТИ ─────────────────────────
const TXT = {
  welcome: (name) =>
    `Привіт, ${esc(name)}! 👋\n\n` +
    `<b>📸 ФОТОБАТЛ</b>\n` +
    `Тема: <b>${esc(CONTEST.theme)}</b>\n\n` +
    `<b>Як це працює:</b>\n` +
    `1️⃣ Надсилаєш мені одне фото\n` +
    `2️⃣ Коли збирається ${BATTLE_SIZE} фото — вони виходять у канал як батл\n` +
    `3️⃣ Глядачі голосують за краще фото\n` +
    `4️⃣ У кого найбільше голосів — той переміг 🏆\n\n` +
    `🏆 <b>Приз:</b> ${esc(CONTEST.prize)}\n` +
    `⏳ <b>Прийом фото до:</b> ${esc(deadlineText())}\n` +
    `🗳 <b>Голосування до:</b> ${esc(CONTEST.votingEnd)}\n\n` +
    ({
      open: 'Готовий? Тисни «Взяти участь» 👇',
      closed: '🔒 Прийом фото вже закрито.',
      not_started: '⏳ Прийом фото ще не почався — зовсім скоро!',
    })[submitState()],
  rules: () =>
    `<b>📜 Правила фотобатлу</b>\n\n` +
    `• Одне фото від одного учасника\n` +
    `• Фото має бути <b>твоїм</b> — не з інтернету\n` +
    `• Тема: <b>${esc(CONTEST.theme)}</b>\n` +
    `• Без NSFW, образ і чужих облич без згоди\n` +
    `• Надсилай як <b>фото</b>, а не файлом\n` +
    `• У кожному батлі можна віддати один голос\n` +
    `• Голосувати за себе не можна\n` +
    (REQUIRE_SUB ? `• Голосувати можуть лише підписники каналу\n` : '') +
    `• Накрутка голосів = дискваліфікація\n` +
    `\nАдміни можуть прибрати фото без пояснень.`,
  prize: () =>
    `<b>🏆 Приз</b>\n\n${esc(CONTEST.prize)}\n\n` +
    `Перемагає фото з найбільшою кількістю голосів на момент закриття голосування ` +
    `(${esc(CONTEST.votingEnd)}).`,
};

const mainMenu = () => {
  const kb = new InlineKeyboard()
    .text('📸 Взяти участь', 'join').row()
    .text('📜 Правила', 'rules').text('🏆 Приз', 'prize').row()
    .text('📄 Моя заявка', 'my');
  if (channelLink) kb.row().url('🗳 Голосувати в каналі', channelLink);
  return kb;
};
const backKb = new InlineKeyboard().text('⬅️ Назад', 'menu');

const battleKb = (b) => {
  const kb = new InlineKeyboard();
  b.entries.forEach((uid, i) => {
    const e = db.entries[uid];
    const label = e && e.status === 'approved' ? `${NUM[i]} ❤️ ${e.votes.length}` : `${NUM[i]} ❌`;
    kb.text(label, `v:${b.id}:${i}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  return kb;
};

const bot = new Bot(BOT_TOKEN);
const pm = bot.chatType('private');

async function safe(fn) {
  try { await fn(); } catch (e) {
    if (!(e instanceof GrammyError && e.description.includes('not modified'))) console.error(e.message);
  }
}
const toAdmins = (text, extra = {}) => Promise.all(ADMIN_IDS.map((a) =>
  bot.api.sendMessage(a, text, { parse_mode: 'HTML', ...extra }).catch(() => {})));

// оновлення кнопок голосування не частіше ніж раз на 1.5 с на батл (ліміти Telegram)
const kbTimers = {};
function refreshBattleKb(b) {
  if (kbTimers[b.id]) return;
  kbTimers[b.id] = setTimeout(async () => {
    delete kbTimers[b.id];
    await safe(() => bot.api.editMessageReplyMarkup(CHANNEL_ID, b.voteMsgId, { reply_markup: battleKb(b) }));
  }, 1500);
}

// ───────────────────────── ПУБЛІКАЦІЯ БАТЛІВ ─────────────────────────
async function publishBattle(group) {
  const id = db.settings.nextBattle;
  const lines = group.map((e, i) =>
    `${NUM[i]} Учасник №${e.number}` + (ANONYMOUS ? '' : ` — ${e.author}`) + (e.caption ? `: ${esc(e.caption)}` : ''));
  const caption = (BATTLE_TEXT.replaceAll('{n}', id) + '\n\n' + lines.join('\n')).slice(0, 1024);

  const msgs = await bot.api.sendMediaGroup(CHANNEL_ID, group.map((e, i) => ({
    type: 'photo', media: e.fileId, ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
  })));
  db.settings.nextBattle++;
  const b = { id, entries: group.map((e) => e.userId), msgIds: msgs.map((m) => m.message_id) };
  group.forEach((e, i) => { e.battleId = id; e.slot = i; e.channelMsgId = msgs[i].message_id; });
  db.battles[id] = b;
  save();

  const vm = await bot.api.sendMessage(CHANNEL_ID, `🗳 Голосування — батл №${id}. Тисни на номер фото:`, {
    reply_markup: battleKb(b),
    reply_parameters: { message_id: msgs[0].message_id, allow_sending_without_reply: true },
  });
  b.voteMsgId = vm.message_id;
  save();

  for (const e of group) {
    await bot.api.sendMessage(e.userId,
      `⚔️ Твоє фото вийшло в <b>батлі №${id}</b> під номером ${NUM[e.slot]}!\nКлич друзів голосувати ❤️` +
      (channelLink ? `\n${postLink(msgs[0].message_id)}` : ''),
      { parse_mode: 'HTML' }).catch(() => {});
  }
}

let publishing = false;
async function tryPublish(force = false) {
  if (publishing) return;
  publishing = true;
  try {
    let q = queue();
    while (q.length >= BATTLE_SIZE || (force && q.length >= 2)) {
      await publishBattle(q.slice(0, BATTLE_SIZE));
      q = queue();
    }
  } catch (err) {
    console.error('publish:', err.message);
    await toAdmins(`⚠️ Не вдалося опублікувати батл: ${esc(err.message)}\nПеревір, що бот — адмін каналу. Повторити: /flush`);
  } finally {
    publishing = false;
  }
}

function approve(e) {
  e.status = 'approved';
  e.number = db.settings.nextNumber++;
  e.approvedAt = Date.now();
  save();
}

async function closeSubmissions(reason) {
  db.settings.submissions = false;
  save();
  await tryPublish(true);
  const left = queue();
  await toAdmins(`🔒 Прийом фото закрито (${reason}).` +
    (left.length ? `\n⚠️ У черзі залишилось ${left.length} фото без пари — /flush не допоможе для одного фото, можна відкрити прийом знову (/open_photos).` : ''));
}

// автозакриття прийому
setInterval(() => {
  const s = db.settings;
  if (AUTO_CLOSE_HOURS && s.submissions && s.startedAt && Date.now() > s.startedAt + AUTO_CLOSE_HOURS * 3600e3) {
    closeSubmissions(`минуло ${AUTO_CLOSE_HOURS} год.`).catch(console.error);
  }
}, 60e3);

// ───────────────────────── МЕНЮ ─────────────────────────
pm.command('start', (ctx) =>
  ctx.reply(TXT.welcome(ctx.from.first_name), { parse_mode: 'HTML', reply_markup: mainMenu() }));

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.welcome(ctx.from.first_name), { parse_mode: 'HTML', reply_markup: mainMenu() }));
});
bot.callbackQuery('rules', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.rules(), { parse_mode: 'HTML', reply_markup: backKb }));
});
bot.callbackQuery('prize', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.prize(), { parse_mode: 'HTML', reply_markup: backKb }));
});

bot.callbackQuery('join', async (ctx) => {
  await ctx.answerCallbackQuery();
  const e = db.entries[ctx.from.id];
  const st = submitState();
  let text;
  if (st === 'not_started') text = '⏳ Прийом фото ще не почався. Я напишу в каналі, коли стартуємо!';
  else if (st === 'closed') text = '🔒 Прийом фото вже закрито.';
  else if (e?.status === 'approved') text = `✅ Ти вже учасник №${e.number}. Друге фото надіслати не можна.`;
  else if (e?.status === 'pending') text = '⏳ Твоє фото на перевірці. Можеш надіслати інше — воно замінить попереднє.';
  else if (e?.status === 'rejected') text = '❌ Попереднє фото не пройшло. Можеш надіслати нове 📸';
  else text = `📸 Надішли мені <b>одне фото</b> на тему «${esc(CONTEST.theme)}».\n\nМожна додати короткий підпис — він буде в пості.`;
  await safe(() => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKb }));
});

bot.callbackQuery('my', async (ctx) => {
  await ctx.answerCallbackQuery();
  const e = db.entries[ctx.from.id];
  if (!e || e.status === 'draft') {
    return safe(() => ctx.editMessageText('У тебе ще немає заявки. Тисни «Взяти участь» 📸', { reply_markup: backKb }));
  }
  let status;
  if (e.status === 'pending') status = '⏳ На перевірці';
  else if (e.status === 'rejected') status = '❌ Відхилено';
  else if (!e.battleId) status = `✅ Учасник №${e.number}, чекаєш суперника в черзі`;
  else status = `⚔️ Батл №${e.battleId}, фото ${NUM[e.slot]} — ❤️ ${e.votes.length}`;
  await ctx.replyWithPhoto(e.fileId, { caption: `Твоя заявка\nСтатус: ${status}` });
});

// ───────────────────────── ПРИЙОМ ФОТО ─────────────────────────
pm.on('message:photo', async (ctx) => {
  const st = submitState();
  if (st === 'not_started') return ctx.reply('⏳ Прийом фото ще не почався.');
  if (st === 'closed') return ctx.reply('🔒 Прийом фото закрито.');
  const uid = ctx.from.id;
  const old = db.entries[uid];
  if (old?.status === 'approved') return ctx.reply(`Ти вже учасник №${old.number} ✅ Друге фото не приймається.`);

  const photo = ctx.message.photo.at(-1);
  db.entries[uid] = {
    userId: uid,
    author: who(ctx.from),
    fileId: photo.file_id,
    caption: (ctx.message.caption || '').slice(0, 100),
    status: 'draft',
    votes: [],
    createdAt: Date.now(),
  };
  save();

  await ctx.replyWithPhoto(photo.file_id, {
    caption: 'Ось твоє фото 👆 Надсилаємо на батл?',
    reply_markup: new InlineKeyboard().text('✅ Надіслати', 'confirm').text('🔄 Інше фото', 'redo'),
  });
});

pm.on('message:document', (ctx) =>
  ctx.reply('Надішли, будь ласка, як <b>фото</b>, а не файлом 🙏', { parse_mode: 'HTML' }));

bot.callbackQuery('redo', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageCaption({ caption: 'Ок, надішли інше фото 📸' }));
});

bot.callbackQuery('confirm', async (ctx) => {
  const e = db.entries[ctx.from.id];
  if (!e || e.status !== 'draft') return ctx.answerCallbackQuery('Заявку вже надіслано або не знайдено');
  if (submitState() !== 'open') return ctx.answerCallbackQuery({ text: 'Прийом фото закрито', show_alert: true });

  if (MODERATION) {
    e.status = 'pending';
    save();
    await ctx.answerCallbackQuery('Надіслано!');
    await safe(() => ctx.editMessageCaption({ caption: '⏳ Фото на перевірці. Я напишу, коли воно потрапить у батл!' }));
    const kb = new InlineKeyboard().text('✅ Прийняти', `ap:${e.userId}`).text('❌ Відхилити', `rj:${e.userId}`);
    for (const a of ADMIN_IDS) {
      await ctx.api.sendPhoto(a, e.fileId, {
        caption: `🆕 Заявка від ${e.author} (id ${e.userId})` + (e.caption ? `\n\n${esc(e.caption)}` : ''),
        parse_mode: 'HTML', reply_markup: kb,
      }).catch(() => {});
    }
    return;
  }

  approve(e);
  const waiting = BATTLE_SIZE - (queue().length % BATTLE_SIZE || BATTLE_SIZE);
  await ctx.answerCallbackQuery('Прийнято!');
  await safe(() => ctx.editMessageCaption({
    caption: `✅ Прийнято! Ти учасник №${e.number}.\n` +
      (waiting ? `Чекаємо ще ${waiting} фото — і батл вийде в канал. Я напишу!` : 'Батл виходить у канал прямо зараз ⚔️'),
  }));
  for (const a of ADMIN_IDS) {
    await ctx.api.sendPhoto(a, e.fileId, {
      caption: `📥 Учасник №${e.number}: ${e.author} (id ${e.userId})`,
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⛔ Прибрати', `rj:${e.userId}`),
    }).catch(() => {});
  }
  await tryPublish();
});

// ───────────────────────── МОДЕРАЦІЯ ─────────────────────────
bot.callbackQuery(/^(ap|rj):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('Ти не адмін');
  const [, action, uidStr] = ctx.match;
  const e = db.entries[uidStr];
  const removable = e && (e.status === 'pending' || (e.status === 'approved' && !e.battleId));
  if (!removable || (action === 'ap' && e.status !== 'pending')) {
    await ctx.answerCallbackQuery(e?.battleId ? 'Вже в батлі — використай /remove ' + e.number : 'Вже оброблено');
    return safe(() => ctx.editMessageReplyMarkup());
  }

  if (action === 'rj') {
    e.status = 'rejected';
    save();
    await ctx.answerCallbackQuery('Прибрано');
    await safe(() => ctx.editMessageCaption({ caption: `❌ Прибрано (${who(ctx.from)})\nАвтор: ${e.author}` }));
    await ctx.api.sendMessage(e.userId, '❌ Твоє фото не пройшло перевірку. Можеш надіслати інше через /start').catch(() => {});
    return;
  }

  approve(e);
  await ctx.answerCallbackQuery(`Прийнято як №${e.number}`);
  await safe(() => ctx.editMessageCaption({ caption: `✅ Прийнято як №${e.number} (${who(ctx.from)})\nАвтор: ${e.author}` }));
  await ctx.api.sendMessage(e.userId, `✅ Фото прийнято, ти учасник №${e.number}! Щойно знайдеться суперник — батл вийде в канал.`).catch(() => {});
  await tryPublish();
});

// ───────────────────────── ГОЛОСУВАННЯ ─────────────────────────
bot.callbackQuery(/^v:(\d+):(\d+)$/, async (ctx) => {
  const b = db.battles[ctx.match[1]];
  const e = b && db.entries[b.entries[Number(ctx.match[2])]];
  const voter = ctx.from.id;
  if (!e || e.status !== 'approved') return ctx.answerCallbackQuery('Це фото не бере участі');
  if (!db.settings.voting) return ctx.answerCallbackQuery({ text: '🔒 Голосування завершено', show_alert: true });
  if (b.entries.includes(voter)) return ctx.answerCallbackQuery({ text: 'Ти учасник цього батлу — голосувати тут не можна 😉', show_alert: true });

  if (REQUIRE_SUB) {
    try {
      const m = await ctx.api.getChatMember(CHANNEL_ID, voter);
      if (!['member', 'administrator', 'creator'].includes(m.status)) {
        return ctx.answerCallbackQuery({ text: 'Щоб голосувати, підпишись на канал 🙏', show_alert: true });
      }
    } catch { return ctx.answerCallbackQuery('Не вдалося перевірити підписку'); }
  }

  let answer;
  if (e.votes.includes(voter)) {
    e.votes = e.votes.filter((v) => v !== voter);
    answer = 'Голос знято';
  } else {
    let switched = false;
    for (const uid of b.entries) {
      const other = db.entries[uid];
      if (other && other !== e && other.votes.includes(voter)) {
        other.votes = other.votes.filter((v) => v !== voter);
        switched = true;
      }
    }
    e.votes.push(voter);
    answer = switched ? `Голос перенесено на фото ${NUM[e.slot]}` : `❤️ Голос за фото ${NUM[e.slot]} зараховано!`;
  }
  save();
  await ctx.answerCallbackQuery(answer);
  refreshBattleKb(b);
});

// ───────────────────────── АДМІН-КОМАНДИ ─────────────────────────
const admin = pm.filter((ctx) => isAdmin(ctx.from.id));

admin.command('admin', (ctx) => ctx.reply(
  `<b>Адмін-команди</b>\n\n` +
  `/open_photos — почати прийом фото` + (AUTO_CLOSE_HOURS ? ` (закриється сам через ${AUTO_CLOSE_HOURS} год.)` : '') + `\n` +
  `/close_photos — закрити прийом фото\n` +
  `/flush — опублікувати фото з черги, навіть якщо не набралось ${BATTLE_SIZE}\n` +
  `/stats — статистика\n` +
  `/top [N] — топ за голосами\n` +
  `/close_voting · /open_voting — зупинити/відновити голосування\n` +
  `/remove N — дискваліфікувати учасника №N\n` +
  `/finish — завершити й оголосити переможців у каналі\n` +
  `/poll — опитування в каналі (питання й варіанти з нового рядка)\n` +
  `/broadcast текст — розсилка всім учасникам`,
  { parse_mode: 'HTML' }));

admin.command('open_photos', async (ctx) => {
  db.settings.submissions = true;
  db.settings.startedAt = Date.now();
  save();
  ctx.reply(`🟢 Прийом фото відкрито` + (AUTO_CLOSE_HOURS ? `, закриється ${deadlineText()}` : ''));
});
admin.command('close_photos', async (ctx) => {
  await closeSubmissions('вручну');
});
admin.command('flush', async (ctx) => {
  const n = queue().length;
  if (n < 2) return ctx.reply(`У черзі ${n} фото — для батлу треба хоча б 2.`);
  await tryPublish(true);
  ctx.reply('✅ Опубліковано');
});

admin.command('stats', (ctx) => {
  const all = entries();
  const count = (s) => all.filter((e) => e.status === s).length;
  const votes = inBattles().reduce((a, e) => a + e.votes.length, 0);
  ctx.reply(
    `📊 Статистика\n\nУчасників: ${count('approved')}\nУ черзі без пари: ${queue().length}\n` +
    `Батлів: ${Object.keys(db.battles).length}\n` +
    (MODERATION ? `На перевірці: ${count('pending')}\n` : '') +
    `Прибрано: ${count('rejected')}\nВсього голосів: ${votes}\n\n` +
    `Прийом фото: ${db.settings.submissions ? '🟢 до ' + deadlineText() : '🔴'}\nГолосування: ${db.settings.voting ? '🟢' : '🔴'}`);
});

const ranking = () => inBattles().sort((a, b) => b.votes.length - a.votes.length || a.approvedAt - b.approvedAt);

admin.command('top', (ctx) => {
  const n = Number(ctx.match) || 10;
  const list = ranking().slice(0, n);
  if (!list.length) return ctx.reply('Поки немає батлів');
  ctx.reply(list.map((e, i) => `${i + 1}. №${e.number} ${e.author} (батл ${e.battleId}) — ❤️ ${e.votes.length}`).join('\n'),
    { parse_mode: 'HTML' });
});

admin.command('close_voting', (ctx) => { db.settings.voting = false; save(); ctx.reply('🔴 Голосування зупинено'); });
admin.command('open_voting', (ctx) => { db.settings.voting = true; save(); ctx.reply('🟢 Голосування відновлено'); });

admin.command('remove', async (ctx) => {
  const e = byNumber(Number(ctx.match));
  if (!e) return ctx.reply('Учасника з таким номером немає. Приклад: /remove 3');
  e.status = 'rejected';
  e.votes = [];
  save();
  if (e.battleId) {
    await ctx.api.deleteMessage(CHANNEL_ID, e.channelMsgId).catch(() => {});
    refreshBattleKb(db.battles[e.battleId]);
  }
  await ctx.api.sendMessage(e.userId, '⛔️ Твоє фото дискваліфіковано адміністрацією.').catch(() => {});
  ctx.reply(`Учасника №${e.number} (${e.author}) дискваліфіковано.`, { parse_mode: 'HTML' });
});

admin.command('finish', async (ctx) => {
  db.settings.submissions = false;
  db.settings.voting = false;
  save();
  const top = ranking().slice(0, 3);
  if (!top.length) return ctx.reply('Немає жодного батлу — нема кого оголошувати.');
  const medals = ['🥇', '🥈', '🥉'];
  const text = `🏁 <b>Фотобатл завершено!</b>\n\n` +
    top.map((e, i) => `${medals[i]} Учасник №${e.number} — ${e.author} — ❤️ ${e.votes.length}`).join('\n') +
    `\n\n🏆 Приз: ${esc(CONTEST.prize)}\nДякуємо всім за участь! 💛`;
  await ctx.api.sendMessage(CHANNEL_ID, text, {
    parse_mode: 'HTML',
    reply_parameters: { message_id: top[0].channelMsgId, allow_sending_without_reply: true },
  });
  await ctx.api.sendMessage(top[0].userId,
    `🥇 Вітаємо, ти переміг у фотобатлі з ❤️ ${top[0].votes.length}! Адміни скоро напишуть щодо призу 🎁`).catch(() => {});
  await toAdmins(`🏆 Переможець: ${top[0].author} (id ${top[0].userId}) — напиши йому щодо призу`);
  ctx.reply('✅ Результати опубліковано в каналі');
});

// /poll Питання
// Варіант 1
// Варіант 2
// (або в один рядок: /poll Питання | Варіант 1 | Варіант 2)
admin.command('poll', async (ctx) => {
  const raw = (ctx.match || '').trim();
  const parts = (raw.includes('\n') ? raw.split('\n') : raw.split('|'))
    .map((s) => s.trim()).filter(Boolean);
  const [question, ...options] = parts;
  if (!question || options.length < 2 || options.length > 10) {
    return ctx.reply(
      'Як зробити опитування в каналі:\n\n' +
      '/poll Що робимо з каналом?\nРобимо фотобатли\nЩось інше\n\n' +
      'Перший рядок — питання, далі кожен варіант з нового рядка (від 2 до 10).');
  }
  try {
    const m = await ctx.api.sendPoll(CHANNEL_ID, question.slice(0, 300),
      options.map((o) => ({ text: o.slice(0, 100) })), { is_anonymous: true });
    ctx.reply('✅ Опитування опубліковано в каналі' + (channelLink ? `\n${postLink(m.message_id)}` : ''));
  } catch (err) {
    ctx.reply('⚠️ Не вдалося: ' + err.message);
  }
});

admin.command('broadcast', async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) return ctx.reply('Приклад: /broadcast Голосування закінчується завтра о 20:00!');
  const ids = Object.keys(db.entries);
  let ok = 0;
  for (const id of ids) {
    try { await ctx.api.sendMessage(id, `📢 ${text}`); ok++; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  ctx.reply(`Надіслано: ${ok}/${ids.length}`);
});

pm.on('message:text', (ctx) => ctx.reply('Тисни /start, щоб відкрити меню 📸'));

bot.catch((err) => console.error('Bot error:', err.error));

bot.api.setMyCommands([{ command: 'start', description: 'Меню фотобатлу' }]);
bot.start({ onStart: (me) => console.log(`✅ @${me.username} запущено`) });
