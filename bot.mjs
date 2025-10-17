// bot.mjs
import { Client, Constants } from 'eris';
import ora from 'ora';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

const C = {
  RED: chalk.red,
  GREEN: chalk.green,
  YELLOW: chalk.yellow,
  BOLD: chalk.bold
};

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MESSAGE = process.env.MESSAGE || "Olá. (bot automático)";
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 60); // default 60s
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 6);

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error(C.RED('Faltam variáveis de ambiente. Configure BOT_TOKEN, GUILD_ID e CHANNEL_ID.'));
  process.exit(1);
}

if (isNaN(INTERVAL_SEC) || INTERVAL_SEC <= 0) {
  console.error(C.RED('INTERVAL_SEC inválido. Use número > 0.'));
  process.exit(1);
}

console.log(C.YELLOW(`Iniciando bot — intervalo: ${INTERVAL_SEC}s`));

// Intents mínimos
const intents = Constants.Intents.guilds | Constants.Intents.guildMessages;
const bot = new Client(TOKEN, { intents });

let stopped = false;

// Simple exponential backoff helper
function backoffDelay(attempt) {
  // base jittered exponential backoff: 2^attempt * 1000ms with jitter
  const base = Math.pow(2, Math.min(attempt, 8)) * 1000;
  const jitter = Math.floor(Math.random() * 500); // 0-499ms
  return base + jitter;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

bot.on('ready', async () => {
  console.log(C.GREEN(`Conectado como ${bot.user.username}#${bot.user.discriminator}`));

  const guild = bot.guilds.get(GUILD_ID);
  if (!guild) {
    console.error(C.RED('Guild não encontrado ou bot não está no servidor.'));
    process.exit(1);
  }

  const channel = bot.getChannel(CHANNEL_ID);
  if (!channel) {
    console.error(C.RED('Canal não encontrado. Verifique o ID e permissões.'));
    process.exit(1);
  }

  // make sure channel is text-like
  const textTypes = [0, 5]; // text, news
  if (!textTypes.includes(channel.type)) {
    console.error(C.RED('O canal informado não é um canal de texto válido.'));
    process.exit(1);
  }

  const spinner = ora('Agendando envios...').start();

  let sentCount = 0;
  let attempt = 0;

  // envia imediatamente, depois por intervalo
  const sendOnce = async () => {
    if (stopped) return;
    try {
      await channel.createMessage(MESSAGE);
      sentCount++;
      attempt = 0; // reset backoff on success
      const now = new Date();
      console.log(`[${now.toISOString()}] Mensagem enviada (${sentCount}).`);
    } catch (err) {
      const errStr = err && err.message ? err.message : String(err);
      console.error(C.RED('Erro ao enviar:'), errStr);

      // tentativa de detectar rate limit (Eris normalmente lança com err.code 429 ou err.statusCode)
      const is429 = err && (err.statusCode === 429 || (err.errors && err.errors.code === 429));
      if (is429) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          console.error(C.RED('Excedeu tentativas de backoff. Aguardando intervalo normal.'));
          attempt = 0;
          return;
        }
        const delay = backoffDelay(attempt);
        console.warn(C.YELLOW(`Rate limit detectado. Fazendo backoff por ${Math.round(delay/1000)}s (tentativa ${attempt}).`));
        await sleep(delay);
        // tenta novamente uma vez, recursivamente
        await sendOnce();
      } else {
        // outros erros: aguarda um pouco e segue
        await sleep(2000);
      }
    }
  };

  await sendOnce();

  // cria timer com jitter para reduzir chance de sincronização com outros bots
  const timer = setInterval(async () => {
    await sendOnce();
  }, INTERVAL_SEC * 1000);

  process.on('SIGINT', async () => {
    stopped = true;
    clearInterval(timer);
    spinner.succeed('Interrompido pelo sinal.');
    try { await bot.disconnect(); } catch {}
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    stopped = true;
    clearInterval(timer);
    spinner.succeed('Interrompido pelo sinal.');
    try { await bot.disconnect(); } catch {}
    process.exit(0);
  });

  spinner.succeed('Agendador ativo.');
});

bot.on('error', (err) => {
  console.error(C.RED('Erro do client:'), err && err.message ? err.message : err);
});

bot.connect();
