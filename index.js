import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import pino from 'pino';
import { CONFIG } from './config.js';
import Database from './database/db.js';
import { MessageFormatter } from './utils/formatter.js';
import SecurityManager from './utils/security.js';
import CommandHandler from './commands/commands.js';
import MessageHandler from './handler.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = pino({ level: CONFIG.LOG_LEVEL });

let sock;
let isConnecting = false;

async function startBot() {
  try {
    logger.info(chalk.blue('🚀 جاري تشغيل البوت...'));

    await fs.mkdir(path.join(__dirname, 'auth_info'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

    const db = new Database();
    const security = new SecurityManager(db);

    const { state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, 'auth_info')
    );

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      emitOwnEvents: true,
      defaultQueryTimeoutMs: undefined,
      retryRequestDelayMs: 100,
      shouldSyncHistoryMessage: () => false,
      getMessage: async key => {
        try {
          return await sock.loadMessage(key.remoteJid, key.id, undefined);
        } catch {
          return { conversation: '' };
        }
      }
    });

    const commands = new CommandHandler(sock, db, security, logger);
    const messageHandler = new MessageHandler(sock, db, security, commands, logger);

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          logger.info(chalk.yellow('📱 ماسح QR:'));
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          logger.info(chalk.green('✅ البوت متصل بنجاح!'));
          logger.info(chalk.cyan(`📱 الرقم: ${sock.user.id}`));
          isConnecting = false;
        } else if (connection === 'connecting') {
          logger.info(chalk.yellow('🔄 جاري الاتصال...'));
          isConnecting = true;
        } else if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

          if (reason === DisconnectReason.loggedOut) {
            logger.error(chalk.red('❌ تم تسجيل الخروج'));
            process.exit();
          } else if (reason === DisconnectReason.connectionClosed) {
            logger.warn(chalk.yellow('⚠️ الاتصال مغلق، إعادة محاولة...'));
            setTimeout(startBot, 3000);
          } else if (reason === DisconnectReason.connectionLost) {
            logger.warn(chalk.yellow('⚠️ فقدان الاتصال، إعادة محاولة...'));
            setTimeout(startBot, 3000);
          } else if (reason === DisconnectReason.timedOut) {
            logger.warn(chalk.yellow('⚠️ انتهاء المهلة الزمنية، إعادة محاولة...'));
            setTimeout(startBot, 3000);
          } else if (reason === DisconnectReason.multideviceMismatch) {
            logger.warn(chalk.yellow('⚠️ تحديث متعدد الأجهزة، إعادة محاولة...'));
            setTimeout(startBot, 3000);
          }
        }
      } catch (error) {
        logger.error(chalk.red('خطأ في تحديث الاتصال:'), error);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        for (const message of messages) {
          if (!message.key.fromMe && !message.key.remoteJid.includes('status@broadcast')) {
            await messageHandler.handleMessage(message);
          }
        }
      } catch (error) {
        logger.error(chalk.red('خطأ في معالجة الرسالة:'), error);
      }
    });

    sock.ev.on('groups.update', async (updates) => {
      try {
        for (const update of updates) {
          await messageHandler.handleGroupUpdate(update);
        }
      } catch (error) {
        logger.error(chalk.red('خطأ في تحديث المجموعة:'), error);
      }
    });

    process.on('SIGINT', async () => {
      logger.info(chalk.yellow('🛑 إيقاف البوت...'));
      await security.terminate();
      process.exit();
    });

  } catch (error) {
    logger.error(chalk.red('❌ خطأ في بدء البوت:'), error);
    setTimeout(startBot, 5000);
  }
}

const DisconnectReason = {
  connectionClosed: 408,
  intentional: 401,
  businessAccountChanged: 411,
  connectionLost: 408,
  connectionReplaced: 409,
  connectionAbandoned: 410,
  connectionMade: 200,
  socketClosed: 403,
  socketError: 500,
  streamError: 501,
  unknownError: 999,
  loggedOut: 401,
  timedOut: 408,
  multideviceMismatch: 411,
  badRequest: 400,
  forbidden: 403,
  accountDeactivated: 410,
  deviceNotConnected: 411,
  multideviceConflict: 412
};

logger.info(chalk.cyan('═══════════════════════════════════'));
logger.info(chalk.cyan('🤖 WhatsApp Bot v' + CONFIG.BOT_VERSION));
logger.info(chalk.cyan('👨‍💻 Developer: ' + CONFIG.BOT_DEVELOPER));
logger.info(chalk.cyan('═══════════════════════════════════'));

startBot().catch(error => {
  logger.error(chalk.red('❌ خطأ غير متوقع:'), error);
  process.exit(1);
});

export { sock };