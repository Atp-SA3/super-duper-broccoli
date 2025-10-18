// bot_server.mjs
// Node.js (ES Modules) + eris + express
import express from 'express';
import { Client, Constants } from 'eris';
import chalk from 'chalk';
import ora from 'ora';

const C = {
  RED: chalk.red,
  GREEN: chalk.green,
  YELLOW: chalk.yellow,
  BOLD: chalk.bold
};

// Config via env
const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const MESSAGE = process.env.MESSAGE || "Olá. (mensagem automática)";
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 60);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 6);
const PORT = Number(process.env.PORT || process.env.PORT_NUMBER || 3000);
const SECRET = process.env.SECRET || null; // usado para proteger /send-once

if (!TOKEN) {
  console.error(C.RED('Erro: BOT_TOKEN não definido.'));
  process.exit(1);
}
if (!GUILD_ID || !CHANNEL_ID) {
  console.error(C.RED('Erro: GUILD_ID e CHANNEL_ID obrigatórios.'));
  process.exit(1);
}
if (isNaN(INTERVAL_SEC) || INTERVAL_SEC <= 0) {
  console.error(C.RED('INTERVAL_SEC inválido. Use número > 0.'));
  process.exit(1);
}

// Eris client
const intents = Constants.Intents.guilds | Constants.Intents.guildMessages;
const bot = new Client(TOKEN, { intents, autoreconnect: true });

let stopped = false;
let sentCount = 0;
let attempt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffDelay(attemptNumber) {
  const base = Math.pow(2, Math.min(attemptNumber, 8)) * 1000;
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

async function sendMessageToChannel(channel, text) {
  try {
    await channel.createMessage(text);
    attempt = 0;
    sentCount++;
    console.log(`[${new Date().toISOString()}] Mensagem enviada (${sentCount}).`);
    return { ok: true };
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : null;
    console.error(C.YELLOW('Erro ao enviar:'), err?.message || err, 'statusCode=', status);
    const is429 = status === 429;
    if (is429) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        console.error(C.RED('Max retries atingido. Resetando contador de tentativas.'));
        attempt = 0;
        return { ok: false, rateLimited: true };
      }
      const delay = backoffDelay(attempt);
      console.warn(C.YELLOW(`Rate limit detectado. Backoff ${Math.round(delay/1000)}s (tentativa ${attempt}).`));
      await sleep(delay);
      return sendMessageToChannel(channel, text);
    } else {
      // wait a little and continue
      await sleep(2000);
      return { ok: false, error: err };
    }
  }
}

// Lógica do agendador
async function startScheduler(channel, text, intervalSeconds) {
  // send once immediately
  await sendMessageToChannel(channel, text);

  const timer = setInterval(async () => {
    if (stopped) {
      clearInterval(timer);
      return;
    }
    await sendMessageToChannel(channel, text);
  }, intervalSeconds * 1000);

  process.on('SIGINT', () => {
    stopped = true;
    clearInterval(timer);
  });

  process.on('SIGTERM', () => {
    stopped = true;
    clearInterval(timer);
  });

  return timer;
}

// Express server — mantém app "pingável" e oferece endpoints
function createServer(botRef) {
  const app = express();

  app.use(express.json());

  app.get('/', (req, res) => {
    res.send('OK - bot ativo');
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      botConnected: !!botRef.connected, // eris client has connected boolean
      sentCount
    });
  });

  // Endpoint protegido para envio manual uma vez
  app.post('/send-once', async (req, res) => {
    // Checa segredo se definido
    if (SECRET) {
      const key = req.headers['x-secret'] || req.query.secret || req.body.secret;
      if (!key || key !== SECRET) {
        return res.status(401).json({ ok: false, message: 'Unauthorized' });
      }
    }
    try {
      const channel = botRef.getChannel(CHANNEL_ID);
      if (!channel) return res.status(404).json({ ok: false, message: 'Canal não encontrado' });

      const text = req.body.message || MESSAGE;
      const result = await sendMessageToChannel(channel, text);
      if (result.ok) return res.json({ ok: true, sentCount });
      else return res.status(500).json({ ok: false, detail: result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // rota para verificar headers (útil pra debug de pings externos)
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, headers: req.headers });
  });

  return app;
}

// Start bot and server
(async () => {
  const spinner = ora('Inicializando bot e servidor...').start();

  bot.on('ready', async () => {
    spinner.succeed(`Bot conectado: ${bot.user.username}#${bot.user.discriminator}`);
    const guild = bot.guilds.get(GUILD_ID);
    if (!guild) {
      console.error(C.RED('Guild não encontrado ou bot não está no servidor.'));
      process.exit(1);
    }

    const channel = bot.getChannel(CHANNEL_ID);
    if (!channel) {
      console.error(C.RED('Canal não encontrado. Verifique o ID e permissões do bot.'));
      process.exit(1);
    }

    // inicia agendador
    await startScheduler(channel, MESSAGE, INTERVAL_SEC);
    console.log(C.GREEN(`Agendador ativo. Enviando a cada ${INTERVAL_SEC}s.`));

    // start express
    const app = createServer(bot);
    app.listen(PORT, () => {
      console.log(C.GREEN(`Servidor HTTP escutando na porta ${PORT}.`));
      console.log(C.YELLOW('Endpoints: GET /, GET /health, POST /send-once (protegido)'));
    });
  });

  bot.on('error', (err) => {
    console.error(C.RED('Erro do client:'), err?.message || err);
  });

  try {
    await bot.connect();
  } catch (e) {
    spinner.fail('Falha ao conectar o bot. Verifique token.');
    console.error(e);
    process.exit(1);
  }
})();
