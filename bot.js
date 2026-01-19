require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

// 1. Setup Client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 2. Define the Slash Command
const commands = [
  {
    name: 'verify',
    description: 'Get a secure link to subscribe and verify your account',
  },
];

// 3. Register Command with Discord API
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Refreshing application (/) commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// 4. Handle Interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    // Tell Discord we are working on it (hides the "Application did not respond" error)
    await interaction.deferReply({ ephemeral: true });

    try {
      // Call YOUR backend to get the link
      // MAKE SURE this URL matches your Railway URL exactly
      const backendUrl = process.env.PUBLIC_BACKEND_URL || "https://discord-gatekeeper-backend-production.up.railway.app";
      
      const response = await fetch(`${backendUrl}/link/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordId: interaction.user.id })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Backend error: ${errText}`);
      }
      
      const data = await response.json();
      
      // Send the link to the user
      await interaction.editReply({
        content: `**Subscription Verification**\nClick here to link your account: ${data.url}\n(Link expires in 48 hours)`,
      });

    } catch (error) {
      console.error("Bot Error:", error);
      await interaction.editReply({ content: '❌ Failed to generate link. Please contact an admin.' });
    }
  }
});

client.once('ready', () => {
  console.log(`🤖 Bot is online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);