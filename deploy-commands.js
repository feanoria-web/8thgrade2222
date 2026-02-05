const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
require('dotenv').config();

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

(async () => {
    try {
        console.log('Slash komutları kaydediliyor...');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log('✓ Slash komutları başarıyla kaydedildi!');
    } catch (error) {
        console.error('Hata:', error);
    }
})();
