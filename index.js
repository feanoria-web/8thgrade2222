const { Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, ChannelType, ActionRowBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'rpqm.log');
const DATA_DIR = path.join(__dirname, 'data');
const ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');

// İzin verilen rol ID'leri - bu rollere sahip kullanıcılar tüm komutları kullanabilir
const ALLOWED_ROLE_IDS = [
    '1457026034976161944'
];

// Google Sheets sütun indexleri (0-based)
const SHEETS_COLUMNS = {
    LINK: 1,            // B sütunu - Bildiri Bağlantısı
    UCP_NAME: 5,        // F sütunu - UCP Kullanıcı Adı
    ADMIN_NAME: 6       // G sütunu - İlgilenen Yetkili
};

// Cache for Google Sheets data
let sheetsCache = {
    data: null,
    lastFetch: 0,
    CACHE_DURATION: 5 * 60 * 1000 // 5 dakika
};

// Kullanıcının gerekli yetkiye veya izin verilen role sahip olup olmadığını kontrol eder
function hasPermission(member, permission) {
    // İzin verilen rollerden birine sahip mi kontrol et
    const hasAllowedRole = ALLOWED_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
    if (hasAllowedRole) return true;

    // Normal Discord yetkisi kontrolü
    return member.permissions.has(permission);
}

// Data directory kontrolü
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

// JSON dosyalarını yükle
function loadAdmins() {
    try {
        if (fs.existsSync(ADMINS_FILE)) {
            return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('admins.json yüklenirken hata:', error);
    }
    return {};
}

function saveAdmins(admins) {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2), 'utf8');
}

function loadPending() {
    try {
        if (fs.existsSync(PENDING_FILE)) {
            return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('pending.json yüklenirken hata:', error);
    }
    return [];
}

function savePending(pending) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8');
}

// In-memory state
let admins = loadAdmins();
let pending = loadPending();

function logUsage(user, channel, guild, message) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${user.tag} (${user.id}) → #${channel.name} @ ${guild.name}: ${message}\n`;
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
    console.log(`[LOG] ${entry.trim()}`);
}

// Google Sheets API - Service Account Authentication
let sheetsAuth = null;

async function getGoogleAuth() {
    if (sheetsAuth) return sheetsAuth;

    const credentialsFile = process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json';
    const credentialsPath = path.join(__dirname, credentialsFile);

    if (!fs.existsSync(credentialsPath)) {
        console.log('[SHEETS] credentials.json dosyası bulunamadı');
        return null;
    }

    try {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
        sheetsAuth = auth;
        return auth;
    } catch (error) {
        console.error('[SHEETS] Credentials yüklenirken hata:', error.message);
        return null;
    }
}

async function fetchSheetsData() {
    const now = Date.now();

    // Cache kontrolü
    if (sheetsCache.data && (now - sheetsCache.lastFetch) < sheetsCache.CACHE_DURATION) {
        return sheetsCache.data;
    }

    if (!process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SHEETS_ID === 'sheets_id_buraya') {
        console.log('[SHEETS] Google Sheets ID yapılandırılmamış');
        return null;
    }

    const auth = await getGoogleAuth();
    if (!auth) return null;

    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: 'A:G' // A'dan G'ye tüm sütunlar
        });

        sheetsCache.data = response.data.values || [];
        sheetsCache.lastFetch = now;
        console.log(`[SHEETS] Veri güncellendi: ${sheetsCache.data.length} satır`);
        return sheetsCache.data;
    } catch (error) {
        console.error('[SHEETS] Veri çekilirken hata:', error.message);
        return sheetsCache.data; // Eski cache'i döndür
    }
}

// Mesaj içinde UCP adı ara (aynı UCP için en son satırı al)
async function findUCPInMessage(messageContent) {
    const data = await fetchSheetsData();
    if (!data) return null;

    const normalizedMessage = messageContent.toLowerCase().trim();
    const words = normalizedMessage.split(/\s+/);

    console.log(`[UCP-DEBUG] Mesajdaki kelimeler: ${JSON.stringify(words)}`);

    let lastMatch = null;

    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row && row[SHEETS_COLUMNS.UCP_NAME]) {
            const sheetUCP = row[SHEETS_COLUMNS.UCP_NAME].toLowerCase().trim();

            if (words.includes(sheetUCP)) {
                console.log(`[UCP-DEBUG] UCP eşleşti satır ${i}: "${sheetUCP}", Admin: "${row[SHEETS_COLUMNS.ADMIN_NAME]}"`);
                lastMatch = {
                    ucpName: row[SHEETS_COLUMNS.UCP_NAME],
                    adminName: row[SHEETS_COLUMNS.ADMIN_NAME] || null,
                    link: row[SHEETS_COLUMNS.LINK] || null,
                    rowIndex: i
                };
            }
        }
    }

    if (lastMatch) {
        console.log(`[UCP-DEBUG] En son eşleşme kullanılıyor: satır ${lastMatch.rowIndex}, Admin: "${lastMatch.adminName}"`);
    } else {
        console.log(`[UCP-DEBUG] Eşleşme bulunamadı`);
    }

    return lastMatch;
}

// Bildirim gönder ve pending'e ekle
async function sendUCPNotification(client, ticketChannel, ucpName, adminName, adminId, bildiriLink) {
    const notificationChannelId = process.env.NOTIFICATION_CHANNEL_ID;

    if (!notificationChannelId || notificationChannelId === 'bildirim_kanal_id') {
        console.log('[UCP] Bildirim kanalı yapılandırılmamış');
        return false;
    }

    try {
        const notificationChannel = await client.channels.fetch(notificationChannelId);
        if (!notificationChannel) {
            console.error('[UCP] Bildirim kanalı bulunamadı');
            return false;
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('UCP Tespiti')
            .setDescription(`<#${ticketChannel.id}> kanalında **${ucpName}** UCP'si belirtildi.`)
            .addFields(
                { name: 'UCP Adı', value: ucpName, inline: true },
                { name: 'İlgilenen Yetkili', value: adminName, inline: true },
                { name: 'Ticket Kanalı', value: `<#${ticketChannel.id}>`, inline: true },
                { name: 'Bildiri Linki', value: bildiriLink ? `[Bildiriye Git](${bildiriLink})` : 'Link bulunamadı', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: 'Yanıtladığınızda ✅ tepkisine tıklayın' });

        const message = await notificationChannel.send({
            content: `<@${adminId}>`,
            embeds: [embed]
        });

        // ✅ tepki ekle
        await message.react('✅');

        // Pending'e ekle
        const pendingEntry = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            ticketChannelId: ticketChannel.id,
            ticketChannelName: ticketChannel.name,
            ucpName: ucpName,
            adminId: adminId,
            adminName: adminName,
            notificationMessageId: message.id,
            notificationChannelId: notificationChannelId,
            createdAt: Date.now(),
            lastReminderAt: Date.now(),
            reminderCount: 0
        };

        pending.push(pendingEntry);
        savePending(pending);

        console.log(`[UCP] Bildirim gönderildi: ${ucpName} → ${adminName}`);
        return true;
    } catch (error) {
        console.error('[UCP] Bildirim gönderilirken hata:', error);
        return false;
    }
}

// Tekrar bildirim kontrolü (aynı UCP + aynı ticket için)
function isDuplicateNotification(ticketChannelId, ucpName) {
    return pending.some(p =>
        p.ticketChannelId === ticketChannelId &&
        p.ucpName.toLowerCase() === ucpName.toLowerCase()
    );
}

// Hatırlatma kontrolü (her saat çalışır)
async function checkReminders(client) {
    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    const escalationRoleId = process.env.ESCALATION_ROLE_ID;
    const notificationChannelId = process.env.NOTIFICATION_CHANNEL_ID;

    if (!notificationChannelId || notificationChannelId === 'bildirim_kanal_id') {
        return;
    }

    let notificationChannel;
    try {
        notificationChannel = await client.channels.fetch(notificationChannelId);
    } catch (error) {
        console.error('[REMINDER] Bildirim kanalı bulunamadı:', error);
        return;
    }

    let hasChanges = false;

    for (const entry of pending) {
        const timeSinceCreation = now - entry.createdAt;
        const timeSinceLastReminder = now - entry.lastReminderAt;

        // Her 24 saatte bir hatırlatma
        const expectedReminders = Math.floor(timeSinceCreation / DAY_MS);

        if (expectedReminders > entry.reminderCount && timeSinceLastReminder >= DAY_MS) {
            entry.reminderCount++;
            entry.lastReminderAt = now;
            hasChanges = true;

            const embed = new EmbedBuilder()
                .setColor(entry.reminderCount >= 3 ? 0xe74c3c : 0xf39c12)
                .setTitle(`Hatırlatma #${entry.reminderCount}`)
                .setDescription(`<#${entry.ticketChannelId}> kanalındaki **${entry.ucpName}** UCP'si hâlâ yanıt bekliyor.`)
                .addFields(
                    { name: 'İlgilenen Yetkili', value: entry.adminName, inline: true },
                    { name: 'Bekleyen Süre', value: `${Math.floor(timeSinceCreation / DAY_MS)} gün`, inline: true }
                )
                .setTimestamp();

            let content = `<@${entry.adminId}>`;

            // 3. hatırlatmadan sonra escalation role ekle
            if (entry.reminderCount >= 3 && escalationRoleId && escalationRoleId !== 'ust_yetkili_rol_id') {
                content += ` <@&${escalationRoleId}>`;
                embed.setFooter({ text: 'Üst yetkililere iletildi' });
            }

            try {
                await notificationChannel.send({
                    content: content,
                    embeds: [embed]
                });
                console.log(`[REMINDER] Hatırlatma #${entry.reminderCount} gönderildi: ${entry.ucpName}`);
            } catch (error) {
                console.error('[REMINDER] Hatırlatma gönderilemedi:', error);
            }
        }
    }

    if (hasChanges) {
        savePending(pending);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

async function refreshCommands(guildId) {
    const commands = [
        new SlashCommandBuilder()
            .setName('rpqm')
            .setDescription('RPQM olarak anonim mesaj gönder')
            .addChannelOption(option =>
                option
                    .setName('kanal')
                    .setDescription('Mesajın gönderileceği kanal')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)
            )
            .addStringOption(option =>
                option
                    .setName('mesaj')
                    .setDescription('Gönderilecek mesaj')
                    .setRequired(true)
            )
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    // Register for specific guild (instant) instead of global (takes up to 1 hour)
    await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
    );
}

client.once('ready', async () => {
    console.log(`✓ ${client.user.tag} aktif!`);
    console.log(`✓ ${client.guilds.cache.size} sunucuda çalışıyor`);

    // Google Sheets bağlantı testi
    const sheetsData = await fetchSheetsData();
    if (sheetsData) {
        console.log(`✓ Google Sheets bağlantısı başarılı: ${sheetsData.length} satır`);
    } else {
        console.log('⚠ Google Sheets yapılandırılmamış veya bağlantı kurulamadı');
    }

    // Pending bildirimleri yükle
    console.log(`✓ ${pending.length} bekleyen bildirim yüklendi`);

    // Hatırlatma kontrolü interval'ı (her saat)
    setInterval(() => checkReminders(client), 60 * 60 * 1000);

    // İlk çalıştırmada da kontrol et
    setTimeout(() => checkReminders(client), 10000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // === MEVCUT KOMUTLAR ===

    if (message.content === '!refresh') {
        // Only admins or allowed roles can refresh commands
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        try {
            await message.reply('Komutlar yenileniyor...');
            await refreshCommands(message.guild.id);
            await message.channel.send('Slash komutları yenilendi! `/rpqm` artık kullanılabilir.');
        } catch (error) {
            console.error('Refresh hatası:', error);
            await message.reply('Komutlar yenilenirken hata oluştu.');
        }
    }

    if (message.content.startsWith('!log')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        if (!fs.existsSync(LOG_FILE)) {
            return message.reply('Henüz log kaydı yok.');
        }

        const arg = message.content.split(' ')[1];
        const count = Math.min(parseInt(arg) || 10, 50);

        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        const recent = lines.slice(-count);

        const output = recent.join('\n');
        if (output.length > 1900) {
            // Too long for a message, send as a file
            await message.reply({
                content: `Son ${recent.length} log kaydı:`,
                files: [{ attachment: Buffer.from(output, 'utf8'), name: 'rpqm-log.txt' }]
            });
        } else {
            await message.reply(`**Son ${recent.length} log kaydı:**\n\`\`\`\n${output}\n\`\`\``);
        }
    }

    if (message.content.trim() === '!rpqm') {
        if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        if (!message.reference) {
            return message.reply('Bir mesajı alıntılayarak (reply) `!rpqm` yazmalısınız.');
        }

        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            const content = referencedMessage.content;

            if (!content || content.length === 0) {
                return message.reply('Alıntılanan mesajda metin bulunamadı.');
            }

            // Sadece "ticket" ile başlayan kanalları filtrele
            const ticketChannels = message.guild.channels.cache
                .filter(ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase().startsWith('ticket'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .first(25); // Discord limiti: maksimum 25 seçenek

            if (ticketChannels.length === 0) {
                return message.reply('Sunucuda "ticket" ile başlayan kanal bulunamadı.');
            }

            const options = ticketChannels.map(ch => ({
                label: `#${ch.name}`.substring(0, 100),
                value: ch.id,
                description: ch.parent?.name?.substring(0, 100) || 'Kategori yok'
            }));

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`rpqm_channel_${message.id}`)
                    .setPlaceholder('Ticket kanalı seçin...')
                    .addOptions(options)
            );

            const prompt = await message.reply({
                content: `Mesajı hangi kanala göndermek istiyorsunuz?\n> ${content.length > 100 ? content.substring(0, 100) + '...' : content}`,
                components: [row]
            });

            const collector = prompt.createMessageComponentCollector({
                filter: (i) => i.user.id === message.author.id,
                time: 30000,
                max: 1
            });

            collector.on('collect', async (i) => {
                const targetChannelId = i.values[0];
                const targetChannel = await message.guild.channels.fetch(targetChannelId);

                try {
                    await targetChannel.send({ content });
                    logUsage(message.author, targetChannel, message.guild, content);
                    await i.update({
                        content: `Mesaj **#${targetChannel.name}** kanalına gönderildi.`,
                        components: []
                    });
                } catch (error) {
                    console.error('Mesaj gönderilemedi:', error);
                    await i.update({
                        content: 'Mesaj gönderilemedi. Bot bu kanala erişemiyor olabilir.',
                        components: []
                    });
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    prompt.edit({ content: 'Süre doldu, kanal seçilmedi.', components: [] });
                }
            });
        } catch (error) {
            console.error('Alıntılanan mesaj alınamadı:', error);
            await message.reply('Alıntılanan mesaj alınamadı.');
        }
    }

    // !rpqm2 kanal-adı - Manuel kanal adı girişi ile mesaj gönderme
    if (message.content.startsWith('!rpqm2 ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        if (!message.reference) {
            return message.reply('Bir mesajı alıntılayarak (reply) `!rpqm2 kanal-adı` yazmalısınız.');
        }

        const channelName = message.content.slice(7).trim().toLowerCase(); // "!rpqm2 " = 7 karakter

        if (!channelName) {
            return message.reply('Kanal adı belirtmelisiniz. Örnek: `!rpqm2 ticket-1234`');
        }

        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            const content = referencedMessage.content;

            if (!content || content.length === 0) {
                return message.reply('Alıntılanan mesajda metin bulunamadı.');
            }

            // Kanal adını ara (ticket ile başlayanlar arasında)
            const targetChannel = message.guild.channels.cache.find(
                ch => ch.type === ChannelType.GuildText &&
                      ch.name.toLowerCase().startsWith('ticket') &&
                      ch.name.toLowerCase() === channelName
            );

            if (!targetChannel) {
                // Tam eşleşme bulunamazsa, içeren kanalları listele
                const similarChannels = message.guild.channels.cache
                    .filter(ch => ch.type === ChannelType.GuildText &&
                                  ch.name.toLowerCase().startsWith('ticket') &&
                                  ch.name.toLowerCase().includes(channelName))
                    .map(ch => `\`${ch.name}\``)
                    .slice(0, 10);

                if (similarChannels.length > 0) {
                    return message.reply(`Kanal bulunamadı. Benzer kanallar:\n${similarChannels.join(', ')}`);
                }
                return message.reply('Bu isimde bir ticket kanalı bulunamadı.');
            }

            // Mesajı gönder
            await targetChannel.send({ content });
            logUsage(message.author, targetChannel, message.guild, content);
            await message.reply(`Mesaj **#${targetChannel.name}** kanalına gönderildi.`);

        } catch (error) {
            console.error('rpqm2 hatası:', error);
            await message.reply('Bir hata oluştu.');
        }
    }

    // === YENİ KOMUTLAR ===

    // !esle @kullanıcı YetkiliAdı - Admin eşleştirmesi oluştur
    if (message.content.startsWith('!esle ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        const args = message.content.slice(6).trim();
        const mentionMatch = args.match(/^<@!?(\d+)>\s+(.+)$/);

        if (!mentionMatch) {
            return message.reply('Kullanım: `!esle @kullanıcı YetkiliAdı`\nÖrnek: `!esle @Feanor Loi`');
        }

        const userId = mentionMatch[1];
        const adminName = mentionMatch[2].trim();

        if (!adminName) {
            return message.reply('Yetkili adı belirtmelisiniz.');
        }

        admins[adminName] = userId;
        saveAdmins(admins);

        await message.reply(`**${adminName}** ismi artık <@${userId}> kullanıcısını etiketleyecek.`);
        console.log(`[ADMIN] Eşleştirme oluşturuldu: ${adminName} → ${userId}`);
    }

    // !esleler - Mevcut eşleştirmeleri listele
    if (message.content.trim() === '!esleler') {
        if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        const entries = Object.entries(admins);

        if (entries.length === 0) {
            return message.reply('Henüz eşleştirme yapılmamış. `!esle @kullanıcı YetkiliAdı` ile ekleyebilirsiniz.');
        }

        const list = entries.map(([name, id]) => `• **${name}** → <@${id}>`).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('Admin Eşleştirmeleri')
            .setDescription(list)
            .setFooter({ text: `Toplam ${entries.length} eşleştirme` });

        await message.reply({ embeds: [embed] });
    }

    // !eslekaldır YetkiliAdı - Eşleştirme sil
    if (message.content.startsWith('!eslekaldır ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        const adminName = message.content.slice(12).trim();

        if (!adminName) {
            return message.reply('Kullanım: `!eslekaldır YetkiliAdı`');
        }

        if (!admins[adminName]) {
            return message.reply(`**${adminName}** adında bir eşleştirme bulunamadı.`);
        }

        delete admins[adminName];
        saveAdmins(admins);

        await message.reply(`**${adminName}** eşleştirmesi kaldırıldı.`);
        console.log(`[ADMIN] Eşleştirme kaldırıldı: ${adminName}`);
    }

    // !bekleyenler - Yanıt bekleyen bildirimleri listele
    if (message.content.trim() === '!bekleyenler') {
        if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        if (pending.length === 0) {
            return message.reply('Yanıt bekleyen bildirim yok.');
        }

        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;

        const list = pending.map(p => {
            const days = Math.floor((now - p.createdAt) / DAY_MS);
            return `• **${p.ucpName}** → ${p.adminName} (${days} gün, ${p.reminderCount} hatırlatma) - <#${p.ticketChannelId}>`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle('Yanıt Bekleyen Bildirimler')
            .setDescription(list)
            .setFooter({ text: `Toplam ${pending.length} bekleyen bildirim` });

        await message.reply({ embeds: [embed] });
    }

    // !embed #kanal - RPQM Rehber embed'i gönder
    if (message.content.startsWith('!embed')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        // Kanal mention'ı al
        const channelMention = message.mentions.channels.first();
        if (!channelMention) {
            return message.reply('Kullanım: `!embed #kanal`');
        }

        const rehberEmbed = new EmbedBuilder()
            .setColor(0x1e8449) // Koyu yeşil
            .setTitle('Roleplay Quality Management Rehberleri')
            .setDescription(
                `Rehberler güncel olup yeni içerikler zaman içerisinde eklenmeye devam edecektir.\n\n` +
                `[[REHBER] Karakter Kurguları](https://forum-tr.gta.world/index.php?/topic/21081-rehber-karakter-kurguları/)\n` +
                `[[REHBER] Sanatçı Rolleri](https://forum-tr.gta.world/index.php?/topic/21187-rehber-sanatçı-rolleri/)\n` +
                `[[REHBER] Ev Satın Alımları](https://forum-tr.gta.world/index.php?/topic/21402-rehber-ev-satın-alımları/)\n` +
                `[[REHBER] Çeteciler ve Etkileşimler](https://forum-tr.gta.world/index.php?/topic/22952-rpqm-çeteciler-ve-etkileşimler/)\n` +
                `[[REHBER] Karakter Oluşturma Rehberi](https://forum-tr.gta.world/index.php?/topic/22953-rpqm-karakter-oluşturma-rehberi/)\n` +
                `[[REHBER] Araç Satın Alımları ve Tercihleri](https://forum-tr.gta.world/index.php?/topic/26100-rpqm-araç-satın-alımları-ve-tercihleri/)`
            )
            .addFields({
                name: 'Roleplay Quality Management Gündem',
                value: `Gündem başlığı büyük değişiklikler ve güncellemelerle birlikte yayınlanır. Zaman zaman rehber niteliği görür.\n\n[Roleplay Quality Management — Gündem](https://forum-tr.gta.world/index.php?/topic/13810-roleplay-quality-management-—-gündem/)`
            });

        try {
            await channelMention.send({ embeds: [rehberEmbed] });
            await message.reply(`Embed **#${channelMention.name}** kanalına gönderildi.`);
        } catch (error) {
            console.error('Embed gönderilemedi:', error);
            await message.reply('Embed gönderilemedi. Bot bu kanala erişemiyor olabilir.');
        }
    }

    // !rehberekle mesaj_id satır - Embed'e rehber satırı ekle
    if (message.content.startsWith('!rehberekle ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        const args = message.content.slice(12).trim();
        const spaceIndex = args.indexOf(' ');

        if (spaceIndex === -1) {
            return message.reply('Kullanım: `!rehberekle mesaj_id [[REHBER] İsim](link)`');
        }

        const messageId = args.substring(0, spaceIndex);
        const newLine = args.substring(spaceIndex + 1).trim();

        if (!newLine) {
            return message.reply('Eklenecek satırı belirtmelisiniz.');
        }

        try {
            // Mesajı bul (aynı kanalda)
            const targetMessage = await message.channel.messages.fetch(messageId);

            if (targetMessage.author.id !== client.user.id) {
                return message.reply('Bu mesaj bota ait değil.');
            }

            if (!targetMessage.embeds || targetMessage.embeds.length === 0) {
                return message.reply('Bu mesajda embed bulunamadı.');
            }

            const oldEmbed = targetMessage.embeds[0];
            const newDescription = oldEmbed.description + '\n' + newLine;

            const updatedEmbed = EmbedBuilder.from(oldEmbed).setDescription(newDescription);

            // Diğer embed'leri koru
            const otherEmbeds = targetMessage.embeds.slice(1).map(e => EmbedBuilder.from(e));

            await targetMessage.edit({ embeds: [updatedEmbed, ...otherEmbeds] });
            await message.reply('Rehber eklendi.');
        } catch (error) {
            console.error('Rehber eklenemedi:', error);
            await message.reply('Rehber eklenemedi. Mesaj ID\'sini kontrol edin.');
        }
    }

    // !rehbersil mesaj_id satır_metni - Embed'den rehber satırı sil
    if (message.content.startsWith('!rehbersil ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        const args = message.content.slice(11).trim();
        const spaceIndex = args.indexOf(' ');

        if (spaceIndex === -1) {
            return message.reply('Kullanım: `!rehbersil mesaj_id aranacak_metin`');
        }

        const messageId = args.substring(0, spaceIndex);
        const searchText = args.substring(spaceIndex + 1).trim().toLowerCase();

        if (!searchText) {
            return message.reply('Silinecek satırı belirtmelisiniz.');
        }

        try {
            const targetMessage = await message.channel.messages.fetch(messageId);

            if (targetMessage.author.id !== client.user.id) {
                return message.reply('Bu mesaj bota ait değil.');
            }

            if (!targetMessage.embeds || targetMessage.embeds.length === 0) {
                return message.reply('Bu mesajda embed bulunamadı.');
            }

            const oldEmbed = targetMessage.embeds[0];
            const lines = oldEmbed.description.split('\n');

            const newLines = lines.filter(line => !line.toLowerCase().includes(searchText));

            if (newLines.length === lines.length) {
                return message.reply('Bu metin embed\'de bulunamadı.');
            }

            const updatedEmbed = EmbedBuilder.from(oldEmbed).setDescription(newLines.join('\n'));
            const otherEmbeds = targetMessage.embeds.slice(1).map(e => EmbedBuilder.from(e));

            await targetMessage.edit({ embeds: [updatedEmbed, ...otherEmbeds] });
            await message.reply('Rehber silindi.');
        } catch (error) {
            console.error('Rehber silinemedi:', error);
            await message.reply('Rehber silinemedi. Mesaj ID\'sini kontrol edin.');
        }
    }


    // !sheetstest - Google Sheets bağlantı testi
    if (message.content.trim() === '!sheetstest') {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('Bu komutu kullanma yetkiniz yok.');
        }

        await message.reply('Google Sheets bağlantısı test ediliyor...');

        // Cache'i temizle ve yeniden çek
        sheetsCache.lastFetch = 0;
        const data = await fetchSheetsData();

        if (!data) {
            return message.channel.send('Google Sheets bağlantısı kurulamadı. `.env` dosyasındaki ayarları kontrol edin.');
        }

        // İlk birkaç satırı göster
        const preview = data.slice(0, 5).map((row, i) => {
            const ucp = row[SHEETS_COLUMNS.UCP_NAME] || '-';
            const admin = row[SHEETS_COLUMNS.ADMIN_NAME] || '-';
            return `${i}: UCP: ${ucp}, Yetkili: ${admin}`;
        }).join('\n');

        await message.channel.send(`Google Sheets bağlantısı başarılı!\n**${data.length} satır bulundu.**\n\n**Önizleme:**\n\`\`\`\n${preview}\n\`\`\``);
    }

    // === UCP TESPİT SİSTEMİ ===
    // Sadece ticket kanallarında çalış
    if (message.channel.type === ChannelType.GuildText &&
        message.channel.name.toLowerCase().startsWith('ticket')) {

        // Mesaj içeriğini kontrol et
        const content = message.content.trim();

        console.log(`[UCP-DEBUG] Ticket kanalında mesaj: "${content}" (${content.length} karakter)`);

        // Çok kısa veya çok uzun mesajları atla
        if (content.length < 2 || content.length > 50) {
            console.log(`[UCP-DEBUG] Mesaj uzunluğu uygun değil, atlanıyor`);
            return;
        }

        // Komut veya mention içeriyorsa atla
        if (content.startsWith('!') || content.startsWith('/') || content.startsWith('<@')) {
            console.log(`[UCP-DEBUG] Komut/mention, atlanıyor`);
            return;
        }

        // Google Sheets'te ara
        console.log(`[UCP-DEBUG] Sheets'te aranıyor: "${content}"`);
        const ucpMatch = await findUCPInMessage(content);

        if (ucpMatch) {
            console.log(`[UCP-DEBUG] Eşleşme bulundu: UCP="${ucpMatch.ucpName}", Admin="${ucpMatch.adminName}"`);
        } else {
            console.log(`[UCP-DEBUG] Sheets'te eşleşme bulunamadı`);
        }

        if (ucpMatch && ucpMatch.adminName) {
            // Duplicate kontrolü
            if (isDuplicateNotification(message.channel.id, ucpMatch.ucpName)) {
                console.log(`[UCP] Duplicate tespit edildi: ${ucpMatch.ucpName} in ${message.channel.name}`);
                return;
            }

            // Admin eşleştirmesini bul
            const adminId = admins[ucpMatch.adminName];
            console.log(`[UCP-DEBUG] Admin aranıyor: "${ucpMatch.adminName}" -> ${adminId || 'BULUNAMADI'}`);

            if (!adminId) {
                console.log(`[UCP] Admin eşleştirmesi bulunamadı: ${ucpMatch.adminName}`);
                return;
            }

            // Bildirim gönder
            console.log(`[UCP-DEBUG] Bildirim gönderiliyor...`);
            await sendUCPNotification(client, message.channel, ucpMatch.ucpName, ucpMatch.adminName, adminId, ucpMatch.link);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    // Channel select menu interactions are handled by the collector
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'rpqm') {
        // Yetki kontrolü - belirli yetkiye veya izin verilen role sahip kişiler kullanabilsin
        if (!hasPermission(interaction.member, PermissionFlagsBits.ManageMessages)) {
            return interaction.reply({
                content: 'Bu komutu kullanma yetkiniz yok.',
                ephemeral: true
            });
        }

        const kanal = interaction.options.getChannel('kanal');
        const mesaj = interaction.options.getString('mesaj');

        try {
            // Mesajı seçilen kanala gönder (bot adıyla, kim gönderdiği belli olmaz)
            await kanal.send({
                content: mesaj
            });

            logUsage(interaction.user, kanal, interaction.guild, mesaj);

            // Komutu kullanan kişiye gizli onay mesajı
            await interaction.reply({
                content: `Mesaj **#${kanal.name}** kanalına gönderildi.`,
                ephemeral: true // Sadece komutu kullanan görür
            });
        } catch (error) {
            console.error('Mesaj gönderilemedi:', error);
            await interaction.reply({
                content: 'Mesaj gönderilemedi. Bot bu kanala erişemiyor olabilir.',
                ephemeral: true
            });
        }
    }
});

// Ticket kanalı oluşturulduğunda otomatik embed mesaj gönder
client.on('channelCreate', async (channel) => {
    // Sadece text kanallarını kontrol et
    if (channel.type !== ChannelType.GuildText) return;

    // Kanal adı "ticket" ile başlıyor mu kontrol et
    if (!channel.name.toLowerCase().startsWith('ticket')) return;

    try {
        const ticketEmbed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('TİCKET AÇMADAN ÖNCE OKUYUN')
            .setDescription(
                `RPQM takımına sorularınızı yöneltmek ve bilgi almak adına yukarıdaki butona tıklayarak bir ticket oluşturabilirsiniz.\n\n` +
                `**Dikkat!**\n` +
                `Ticket yoluyla birer RPQ Bildirisi / İzin Talebi oluşturamazsınız. Bu tip konular [forum ana sayfamızda](https://forum-tr.gta.world/index.php?/forum/198-roleplay-quality-talepleri-bildiri-i%CC%87zin/) ilerler.\n\n` +
                `[RPQ Bildirisi oluşturmak](https://gtaw.link/rpqmbildiri)\n` +
                `[RPQ İzin Talebi oluşturmak](https://gtaw.link/rpqmizin)\n\n` +
                `**Öncesinde Bilinmesi Gerekenler**\n` +
                `Bir RPQ Ticketi oluşturmak şu sebeplerden kaynaklanmamalıdır:\n\n` +
                `• **Bir araç/mülk/işletme satın almak istiyorum, inceler misiniz?** -> Ticketiniz incelenemez, satın alımlarda otokontrol önceliği vardır.\n\n` +
                `• **Bir RPQ yetkilisiyle özel konuşmak veya şikayette bulunmak istiyorum.** -> Head of RPQM'e doğrudan ulaşabilir veya Staff Report oluşturabilirsiniz.\n\n` +
                `• **Bir bildiri/izin talebi oluşturdum, ne zaman sonuçlanacağını soracağım.** -> RPQ Bildiri ve izinleri en kısa sürede incelenir, nihai sonuçlar gizli tutulur.\n\n` +
                `• **Başka bir takımdan başvuruma dair ret aldım, burada hakkımı arayacağım.** -> RPQM, diğer takımlara dair yakınmanız gereken takım değildir. Zaten diğer takımlarla ortak çalışır.`
            );

        await channel.send({ embeds: [ticketEmbed] });
        console.log(`[TICKET] ${channel.guild.name} sunucusunda #${channel.name} kanalına bilgi mesajı gönderildi.`);
    } catch (error) {
        console.error(`[TICKET] Embed gönderilemedi:`, error);
    }
});

// ✅ Tepki takibi - Admin yanıtladığında pending'den kaldır
client.on('messageReactionAdd', async (reaction, user) => {
    // Bot tepkilerini yoksay
    if (user.bot) return;

    // Sadece ✅ tepkisini kontrol et
    if (reaction.emoji.name !== '✅') return;

    // Partial reaction ise fetch et
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('[REACTION] Reaction fetch hatası:', error);
            return;
        }
    }

    const messageId = reaction.message.id;

    // Bu mesaj pending listesinde mi?
    const pendingIndex = pending.findIndex(p => p.notificationMessageId === messageId);

    if (pendingIndex !== -1) {
        const entry = pending[pendingIndex];

        // Sadece ilgili admin veya yönetici onaylayabilir
        const isAssignedAdmin = user.id === entry.adminId;

        // Yönetici kontrolü için guild member'ı al
        let isAdmin = false;
        try {
            const guild = reaction.message.guild;
            if (guild) {
                const member = await guild.members.fetch(user.id);
                isAdmin = hasPermission(member, PermissionFlagsBits.Administrator);
            }
        } catch (error) {
            console.error('[REACTION] Member fetch hatası:', error);
        }

        if (isAssignedAdmin || isAdmin) {
            // Pending'den kaldır
            pending.splice(pendingIndex, 1);
            savePending(pending);

            console.log(`[UCP] Bildirim kapatıldı: ${entry.ucpName} by ${user.tag}`);

            // Mesajı güncelle
            try {
                const embed = new EmbedBuilder()
                    .setColor(0x2ecc71)
                    .setTitle('UCP Tespiti - Yanıtlandı')
                    .setDescription(`~~<#${entry.ticketChannelId}> kanalında **${entry.ucpName}** UCP'si belirtildi.~~`)
                    .addFields(
                        { name: 'Yanıtlayan', value: `<@${user.id}>`, inline: true },
                        { name: 'Yanıt Süresi', value: `${Math.floor((Date.now() - entry.createdAt) / (60 * 60 * 1000))} saat`, inline: true }
                    )
                    .setTimestamp();

                await reaction.message.edit({ embeds: [embed] });
            } catch (error) {
                console.error('[REACTION] Mesaj düzenleme hatası:', error);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
