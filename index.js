const { Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, ChannelType, ActionRowBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'rpqm.log');

// İzin verilen rol ID'leri - bu rollere sahip kullanıcılar tüm komutları kullanabilir
const ALLOWED_ROLE_IDS = [
    '1457026034976161944'
];

// Kullanıcının gerekli yetkiye veya izin verilen role sahip olup olmadığını kontrol eder
function hasPermission(member, permission) {
    // İzin verilen rollerden birine sahip mi kontrol et
    const hasAllowedRole = ALLOWED_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
    if (hasAllowedRole) return true;

    // Normal Discord yetkisi kontrolü
    return member.permissions.has(permission);
}

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

function logUsage(user, channel, guild, message) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${user.tag} (${user.id}) → #${channel.name} @ ${guild.name}: ${message}\n`;
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
    console.log(`[LOG] ${entry.trim()}`);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
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

client.once('ready', () => {
    console.log(`✓ ${client.user.tag} aktif!`);
    console.log(`✓ ${client.guilds.cache.size} sunucuda çalışıyor`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content === '!refresh') {
        // Only admins or allowed roles can refresh commands
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('❌ Bu komutu kullanma yetkiniz yok.');
        }

        try {
            await message.reply('⏳ Komutlar yenileniyor...');
            await refreshCommands(message.guild.id);
            await message.channel.send('✓ Slash komutları yenilendi! `/rpqm` artık kullanılabilir.');
        } catch (error) {
            console.error('Refresh hatası:', error);
            await message.reply('❌ Komutlar yenilenirken hata oluştu.');
        }
    }

    if (message.content.startsWith('!log')) {
        if (!hasPermission(message.member, PermissionFlagsBits.Administrator)) {
            return message.reply('❌ Bu komutu kullanma yetkiniz yok.');
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
            return message.reply('❌ Bu komutu kullanma yetkiniz yok.');
        }

        if (!message.reference) {
            return message.reply('❌ Bir mesajı alıntılayarak (reply) `!rpqm` yazmalısınız.');
        }

        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            const content = referencedMessage.content;

            if (!content || content.length === 0) {
                return message.reply('❌ Alıntılanan mesajda metin bulunamadı.');
            }

            // Sadece "ticket" ile başlayan kanalları filtrele
            const ticketChannels = message.guild.channels.cache
                .filter(ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase().startsWith('ticket'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .first(25); // Discord limiti: maksimum 25 seçenek

            if (ticketChannels.length === 0) {
                return message.reply('❌ Sunucuda "ticket" ile başlayan kanal bulunamadı.');
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
                        content: `✓ Mesaj **#${targetChannel.name}** kanalına gönderildi.`,
                        components: []
                    });
                } catch (error) {
                    console.error('Mesaj gönderilemedi:', error);
                    await i.update({
                        content: '❌ Mesaj gönderilemedi. Bot bu kanala erişemiyor olabilir.',
                        components: []
                    });
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    prompt.edit({ content: '❌ Süre doldu, kanal seçilmedi.', components: [] });
                }
            });
        } catch (error) {
            console.error('Alıntılanan mesaj alınamadı:', error);
            await message.reply('❌ Alıntılanan mesaj alınamadı.');
        }
    }

    // !rpqm2 kanal-adı - Manuel kanal adı girişi ile mesaj gönderme
    if (message.content.startsWith('!rpqm2 ')) {
        if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ Bu komutu kullanma yetkiniz yok.');
        }

        if (!message.reference) {
            return message.reply('❌ Bir mesajı alıntılayarak (reply) `!rpqm2 kanal-adı` yazmalısınız.');
        }

        const channelName = message.content.slice(7).trim().toLowerCase(); // "!rpqm2 " = 7 karakter

        if (!channelName) {
            return message.reply('❌ Kanal adı belirtmelisiniz. Örnek: `!rpqm2 ticket-1234`');
        }

        try {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
            const content = referencedMessage.content;

            if (!content || content.length === 0) {
                return message.reply('❌ Alıntılanan mesajda metin bulunamadı.');
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
                    return message.reply(`❌ Kanal bulunamadı. Benzer kanallar:\n${similarChannels.join(', ')}`);
                }
                return message.reply('❌ Bu isimde bir ticket kanalı bulunamadı.');
            }

            // Mesajı gönder
            await targetChannel.send({ content });
            logUsage(message.author, targetChannel, message.guild, content);
            await message.reply(`✓ Mesaj **#${targetChannel.name}** kanalına gönderildi.`);

        } catch (error) {
            console.error('rpqm2 hatası:', error);
            await message.reply('❌ Bir hata oluştu.');
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
                content: '❌ Bu komutu kullanma yetkiniz yok.',
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
                content: `✓ Mesaj **#${kanal.name}** kanalına gönderildi.`,
                ephemeral: true // Sadece komutu kullanan görür
            });
        } catch (error) {
            console.error('Mesaj gönderilemedi:', error);
            await interaction.reply({
                content: '❌ Mesaj gönderilemedi. Bot bu kanala erişemiyor olabilir.',
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

client.login(process.env.DISCORD_TOKEN);
