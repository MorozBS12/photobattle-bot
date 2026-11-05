// Фотобатл-бот для Telegram (grammY + JSON-сховище)
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
const ANONYMOUS = process.env.ANONYMOUS !== 'false'; // за замовчуванням без ніків у каналі

const CONTEST = {
  theme: process.env.THEME || 'Вільна тема',
  prize: process.env.PRIZE || 'Приз ще уточнюється 🎁',
  deadline: process.env.DEADLINE || 'буде оголошено',
  votingEnd: process.env.VOTING_END || 'буде оголошено',
};

if (!BOT_TOKEN) throw new Error('Немає BOT_TOKEN у .env');
if (!CHANNEL_ID) throw new Error('Немає CHANNEL_ID у .env');
if (!ADMIN_IDS.length) console.warn('⚠️ ADMIN_IDS порожній — нікому буде модерувати фото');

// ───────────────────────── СХОВИЩЕ ─────────────────────────
// DATA_DIR — папка постійного сховища (на Railway: шлях до Volume, напр. /data)
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
let db = {
  settings: { submissions: true, voting: true, nextNumber: 1 },
  entries: {}, // userId -> entry
};
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = () => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};

const isAdmin = (id) => ADMIN_IDS.includes(id);
const approved = () => Object.values(db.entries).filter((e) => e.status === 'approved');
const byNumber = (n) => approved().find((e) => e.number === n);
const esc = (s = '') => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const who = (u) => (u.username ? '@' + u.username : esc(u.first_name || 'без імені'));
const channelLink = CHANNEL_ID.startsWith('@') ? `https://t.me/${CHANNEL_ID.slice(1)}` : null;

// ───────────────────────── ТЕКСТИ ─────────────────────────
const TXT = {
  welcome: (name) =>
    `Привіт, ${esc(name)}! 👋\n\n` +
    `<b>📸 ФОТОБАТЛ</b>\n` +
    `Тема: <b>${esc(CONTEST.theme)}</b>\n\n` +
    `<b>Як це працює:</b>\n` +
    `1️⃣ Надсилаєш мені одне фото\n` +
    `2️⃣ Адміни перевіряють його\n` +
    `3️⃣ Фото публікується в каналі під номером\n` +
    `4️⃣ Глядачі голосують ❤️ — у кого більше, той переміг\n\n` +
    `🏆 <b>Приз:</b> ${esc(CONTEST.prize)}\n` +
    `⏳ <b>Прийом фото до:</b> ${esc(CONTEST.deadline)}\n` +
    `🗳 <b>Голосування до:</b> ${esc(CONTEST.votingEnd)}\n\n` +
    (db.settings.submissions ? `Готовий? Тисни «Взяти участь» 👇` : `🔒 Прийом фото вже закрито.`),
  rules:
    `<b>📜 Правила фотобатлу</b>\n\n` +
    `• Одне фото від одного учасника\n` +
    `• Фото має бути <b>твоїм</b> — не з інтернету\n` +
    `• Відповідати темі: <b>${esc(CONTEST.theme)}</b>\n` +
    `• Без NSFW, образ і чужих облич без згоди\n` +
    `• Надсилай як <b>фото</b>, а не файлом\n` +
    `• Накрутка голосів = дискваліфікація\n` +
    `• Голосувати за себе не можна\n` +
    (REQUIRE_SUB ? `• Голосувати можуть лише підписники каналу\n` : '') +
    `\nАдміни можуть відхилити фото без пояснень.`,
  prize:
    `<b>🏆 Приз</b>\n\n${esc(CONTEST.prize)}\n\n` +
    `Переможця визначає кількість ❤️ під фото на момент закриття голосування ` +
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
const voteKb = (e) => new InlineKeyboard().text(`❤️ ${e.votes.length}`, `v:${e.userId}`);

const channelCaption = (e) =>
  `📸 <b>Учасник №${e.number}</b>` +
  (ANONYMOUS ? '' : ` — ${e.author}`) +
  (e.caption ? `\n\n${esc(e.caption)}` : '') +
  `\n\nТисни ❤️, щоб проголосувати`;

const bot = new Bot(BOT_TOKEN);
const pm = bot.chatType('private');

// безпечне редагування (ігнорує "message is not modified")
async function safe(fn) {
  try { await fn(); } catch (e) {
    if (!(e instanceof GrammyError && e.description.includes('not modified'))) console.error(e.message);
  }
}

// ───────────────────────── МЕНЮ ─────────────────────────
pm.command('start', (ctx) =>
  ctx.reply(TXT.welcome(ctx.from.first_name), { parse_mode: 'HTML', reply_markup: mainMenu() }));

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.welcome(ctx.from.first_name), { parse_mode: 'HTML', reply_markup: mainMenu() }));
});
bot.callbackQuery('rules', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.rules, { parse_mode: 'HTML', reply_markup: backKb }));
});
bot.callbackQuery('prize', async (ctx) => {
  await ctx.answerCallbackQuery();
  await safe(() => ctx.editMessageText(TXT.prize, { parse_mode: 'HTML', reply_markup: backKb }));
});

bot.callbackQuery('join', async (ctx) => {
  await ctx.answerCallbackQuery();
  const e = db.entries[ctx.from.id];
  let text;
  if (!db.settings.submissions) text = '🔒 Прийом фото вже закрито.';
  else if (e?.status === 'approved') text = `✅ Ти вже учасник під №${e.number}. Друге фото надіслати не можна.`;
  else if (e?.status === 'pending') text = '⏳ Твоє фото вже на перевірці. Можеш надіслати інше — воно замінить попереднє.';
  else if (e?.status === 'rejected') text = '❌ Попереднє фото відхилили. Можеш надіслати нове 📸';
  else text = `📸 Надішли мені <b>одне фото</b> на тему «${esc(CONTEST.theme)}».\n\nМожна додати підпис — він з'явиться під фото в каналі.`;
  await safe(() => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKb }));
});

bot.callbackQuery('my', async (ctx) => {
  await ctx.answerCallbackQuery();
  const e = db.entries[ctx.from.id];
  if (!e || e.status === 'draft') {
    return safe(() => ctx.editMessageText('У тебе ще немає заявки. Тисни «Взяти участь» 📸', { reply_markup: backKb }));
  }
  const status = {
    pending: '⏳ На перевірці',
    approved: `✅ Опубліковано, №${e.number} — ❤️ ${e.votes?.length || 0}`,
    rejected: '❌ Відхилено',
  }[e.status];
  await ctx.replyWithPhoto(e.fileId, { caption: `Твоя заявка\nСтатус: ${status}` });
});

// ───────────────────────── ПРИЙОМ ФОТО ─────────────────────────
pm.on('message:photo', async (ctx) => {
  if (!db.settings.submissions) return ctx.reply('🔒 Прийом фото закрито.');
  const uid = ctx.from.id;
  const old = db.entries[uid];
  if (old?.status === 'approved') return ctx.reply(`Ти вже учасник під №${old.number} ✅ Друге фото не приймається.`);

  const photo = ctx.message.photo.at(-1); // найбільша якість
  db.entries[uid] = {
    userId: uid,
    author: who(ctx.from),
    fileId: photo.file_id,
    caption: (ctx.message.caption || '').slice(0, 300),
    status: 'draft',
    votes: [],
    createdAt: Date.now(),
  };
  save();

  await ctx.replyWithPhoto(photo.file_id, {
    caption: 'Ось твоє фото 👆 Надсилаємо на конкурс?',
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
  if (!db.settings.submissions) return ctx.answerCallbackQuery({ text: 'Прийом фото закрито', show_alert: true });
  e.status = 'pending';
  save();
  await ctx.answerCallbackQuery('Надіслано!');
  await safe(() => ctx.editMessageCaption({ caption: '⏳ Фото на перевірці. Я напишу, коли його опублікують!' }));

  const kb = new InlineKeyboard().text('✅ Прийняти', `ap:${e.userId}`).text('❌ Відхилити', `rj:${e.userId}`);
  for (const admin of ADMIN_IDS) {
    await ctx.api.sendPhoto(admin, e.fileId, {
      caption: `🆕 Нова заявка від ${e.author} (id ${e.userId})` + (e.caption ? `\n\n${esc(e.caption)}` : ''),
      parse_mode: 'HTML',
      reply_markup: kb,
    }).catch((err) => console.error('admin notify:', err.message));
  }
});

// ───────────────────────── МОДЕРАЦІЯ ─────────────────────────
bot.callbackQuery(/^(ap|rj):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('Ти не адмін');
  const [, action, uidStr] = ctx.match;
  const e = db.entries[uidStr];
  if (!e || e.status !== 'pending') {
    await ctx.answerCallbackQuery('Вже оброблено');
    return safe(() => ctx.editMessageReplyMarkup());
  }

  if (action === 'rj') {
    e.status = 'rejected';
    save();
    await ctx.answerCallbackQuery('Відхилено');
    await safe(() => ctx.editMessageCaption({ caption: `❌ Відхилено (${who(ctx.from)})\nАвтор: ${e.author}` }));
    await ctx.api.sendMessage(e.userId, '❌ На жаль, твоє фото не пройшло модерацію. Можеш надіслати інше через /start').catch(() => {});
    return;
  }

  e.status = 'approved';
  e.number = db.settings.nextNumber++;
  try {
    const msg = await ctx.api.sendPhoto(CHANNEL_ID, e.fileId, {
      caption: channelCaption(e), parse_mode: 'HTML', reply_markup: voteKb(e),
    });
    e.channelMsgId = msg.message_id;
  } catch (err) {
    e.status = 'pending'; db.settings.nextNumber--; save();
    return ctx.answerCallbackQuery({ text: 'Не вдалося запостити в канал: ' + err.message, show_alert: true });
  }
  save();
  await ctx.answerCallbackQuery(`Опубліковано як №${e.number}`);
  await safe(() => ctx.editMessageCaption({ caption: `✅ Прийнято як №${e.number} (${who(ctx.from)})\nАвтор: ${e.author}` }));
  await ctx.api.sendMessage(e.userId,
    `🎉 Твоє фото опубліковано під <b>№${e.number}</b>!\nКлич друзів голосувати ❤️` +
    (channelLink ? `\n${channelLink}/${e.channelMsgId}` : ''),
    { parse_mode: 'HTML' }).catch(() => {});
});

// ───────────────────────── ГОЛОСУВАННЯ ─────────────────────────
bot.callbackQuery(/^v:(\d+)$/, async (ctx) => {
  const e = db.entries[ctx.match[1]];
  const voter = ctx.from.id;
  if (!e || e.status !== 'approved') return ctx.answerCallbackQuery('Фото не бере участі');
  if (!db.settings.voting) return ctx.answerCallbackQuery({ text: '🔒 Голосування завершено', show_alert: true });
  if (voter === e.userId) return ctx.answerCallbackQuery({ text: 'За себе голосувати не можна 😉', show_alert: true });

  if (REQUIRE_SUB) {
    try {
      const m = await ctx.api.getChatMember(CHANNEL_ID, voter);
      if (!['member', 'administrator', 'creator'].includes(m.status)) {
        return ctx.answerCallbackQuery({ text: 'Щоб голосувати, підпишись на канал 🙏', show_alert: true });
      }
    } catch { return ctx.answerCallbackQuery('Не вдалося перевірити підписку'); }
  }

  const i = e.votes.indexOf(voter);
  if (i === -1) e.votes.push(voter); else e.votes.splice(i, 1);
  save();
  await ctx.answerCallbackQuery(i === -1 ? '❤️ Голос зараховано!' : 'Голос знято');
  await safe(() => ctx.editMessageReplyMarkup({ reply_markup: voteKb(e) }));
});

// ───────────────────────── АДМІН-КОМАНДИ ─────────────────────────
const admin = pm.filter((ctx) => isAdmin(ctx.from.id));

admin.command('admin', (ctx) => ctx.reply(
  `<b>Адмін-команди</b>\n\n` +
  `/stats — статистика\n` +
  `/top [N] — топ за голосами (за замовч. 10)\n` +
  `/close_photos — закрити прийом фото\n` +
  `/open_photos — відкрити прийом фото\n` +
  `/close_voting — зупинити голосування\n` +
  `/open_voting — відновити голосування\n` +
  `/remove N — дискваліфікувати учасника №N\n` +
  `/finish — закрити все й оголосити переможців у каналі\n` +
  `/broadcast текст — розсилка всім учасникам`,
  { parse_mode: 'HTML' }));

admin.command('stats', (ctx) => {
  const all = Object.values(db.entries);
  const count = (s) => all.filter((e) => e.status === s).length;
  const votes = approved().reduce((a, e) => a + e.votes.length, 0);
  ctx.reply(
    `📊 Статистика\n\nОпубліковано: ${count('approved')}\nНа перевірці: ${count('pending')}\n` +
    `Відхилено: ${count('rejected')}\nВсього голосів: ${votes}\n\n` +
    `Прийом фото: ${db.settings.submissions ? '🟢' : '🔴'}\nГолосування: ${db.settings.voting ? '🟢' : '🔴'}`);
});

const ranking = () => approved().sort((a, b) => b.votes.length - a.votes.length || a.createdAt - b.createdAt);

admin.command('top', (ctx) => {
  const n = Number(ctx.match) || 10;
  const list = ranking().slice(0, n);
  if (!list.length) return ctx.reply('Поки немає учасників');
  ctx.reply(list.map((e, i) => `${i + 1}. №${e.number} ${e.author} — ❤️ ${e.votes.length}`).join('\n'),
    { parse_mode: 'HTML' });
});

const toggle = (key, val, msg) => (ctx) => { db.settings[key] = val; save(); ctx.reply(msg); };
admin.command('close_photos', toggle('submissions', false, '🔴 Прийом фото закрито'));
admin.command('open_photos', toggle('submissions', true, '🟢 Прийом фото відкрито'));
admin.command('close_voting', toggle('voting', false, '🔴 Голосування зупинено'));
admin.command('open_voting', toggle('voting', true, '🟢 Голосування відновлено'));

admin.command('remove', async (ctx) => {
  const e = byNumber(Number(ctx.match));
  if (!e) return ctx.reply('Учасника з таким номером немає. Приклад: /remove 3');
  e.status = 'rejected';
  save();
  await ctx.api.deleteMessage(CHANNEL_ID, e.channelMsgId).catch(() => {});
  await ctx.api.sendMessage(e.userId, '⛔️ Твоє фото дискваліфіковано адміністрацією.').catch(() => {});
  ctx.reply(`Учасника №${e.number} (${e.author}) дискваліфіковано, пост видалено.`, { parse_mode: 'HTML' });
});

admin.command('finish', async (ctx) => {
  db.settings.submissions = false;
  db.settings.voting = false;
  save();
  const top = ranking().slice(0, 3);
  if (!top.length) return ctx.reply('Немає учасників — нема кого оголошувати.');
  const medals = ['🥇', '🥈', '🥉'];
  const text = `🏁 <b>Фотобатл завершено!</b>\n\n` +
    top.map((e, i) => `${medals[i]} Учасник №${e.number} — ${e.author} — ❤️ ${e.votes.length}`).join('\n') +
    `\n\n🏆 Приз: ${esc(CONTEST.prize)}\nДякуємо всім за участь! 💛`;
  await ctx.api.sendMessage(CHANNEL_ID, text, {
    parse_mode: 'HTML',
    reply_parameters: { message_id: top[0].channelMsgId, allow_sending_without_reply: true },
  });
  await ctx.api.sendMessage(top[0].userId,
    `🥇 Вітаємо, ти переміг у фотобатлі з ❤️ ${top[0].votes.length}! Адміни скоро зв'яжуться з тобою щодо призу 🎁`).catch(() => {});
  for (const a of ADMIN_IDS) {
    await ctx.api.sendMessage(a, `Переможець: ${top[0].author} (id ${top[0].userId})`, { parse_mode: 'HTML' }).catch(() => {});
  }
  ctx.reply('✅ Результати опубліковано в каналі');
});

admin.command('broadcast', async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) return ctx.reply('Приклад: /broadcast Голосування закінчується завтра о 20:00!');
  const ids = Object.keys(db.entries);
  let ok = 0;
  for (const id of ids) {
    try { await ctx.api.sendMessage(id, `📢 ${text}`); ok++; } catch {}
    await new Promise((r) => setTimeout(r, 50)); // щоб не впертися в ліміти Telegram
  }
  ctx.reply(`Надіслано: ${ok}/${ids.length}`);
});

// інший текст у ЛС
pm.on('message:text', (ctx) => ctx.reply('Тисни /start, щоб відкрити меню 📸'));

bot.catch((err) => console.error('Bot error:', err.error));

bot.api.setMyCommands([{ command: 'start', description: 'Меню фотобатлу' }]);
bot.start({ onStart: (me) => console.log(`✅ @${me.username} запущено`) });
