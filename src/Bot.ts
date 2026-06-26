import {
  assertType,
  UserCache,
  LRUCache,
  resolveLIDAndPN,
  toError,
  TTLCache,
} from './utils/index.js';
import { pino } from 'pino';
import libpn from 'libphonenumber-js';
import { Boom } from '@hapi/boom';
import type { Output } from '@hapi/boom';
import ms from 'ms';
import type { GroupMetadata, WAMessage } from 'baileys';
import { delay, DisconnectReason, isJidGroup, isLidUser, isPnUser } from 'baileys';
import { EventEmitter } from 'node:events';
import { Message } from './Message.js';
import { Socket } from './Socket.js';
import { Auth } from './Auth.js';

/** It represents a structured WhatsApp user identity */
export interface User {
  lid: string;
  pn: string;
  name?: string;
}
/** List of core events emitted by the {@link Bot} instance */
export enum Events {
  ERROR = 'error',
  QR = 'qr',
  OTP = 'otp',
  CLOSE = 'close',
  OPEN = 'open',
  MESSAGE = 'message',
  COMMAND = 'command',
}
interface EventMap {
  error: [err: Error];
  qr: [str: string];
  otp: [code: string];
  close: [out: Output];
  open: [user: User];
  message: [message: Message];
  command: [message: Message, name: string, args: string[]];
}
/**
 * Core class
 *
 * @example
 * import { Bot, Auth, Events, jidDecode } from '@jzszdznzzl/wabotjs';
 * import { join } from 'node:path';
 * import { toString } from 'qrcode';
 *
 * const id = 'my-bot';
 * const auth = new Auth(join(process.cwd(), 'sessions', id));
 * const bot = new Bot(id, auth)
 *   .on(Events.CLOSE, (out) => {
 *     console.warn('Bot connection closed');
 *     console.dir(out, { depth: null });
 *   })
 *   .on(Events.OPEN, (user) => {
 *     console.log(`Bot connection open in ${user.name}(${jidDecode(user.pn)!.user})`);
 *   })
 *   .on(Events.QR, async (str) => {
 *     const qr = await toString(str, { type: 'terminal', small: true });
 *     console.log('QR code');
 *     console.log(qr);
 *   })
 *   .on(Events.OTP, (code) => {
 *     console.log('Pairing code');
 *     console.log(code);
 *   })
 *   .setPrefix('!')
 *   .on(Events.COMMAND, async (msg, name, args) => {
 *     try {
 *       if (['ping', 'p'].includes(name)) {
 *         await msg.reply({ text: '¡Pong!' });
 *         return;
 *       }
 *       if (['echo', 'say'].includes(name)) {
 *         await msg.reply({ text: args.length > 0 ? args.join(' ') : '¡Hello, World!' });
 *         return;
 *       }
 *       await msg.reply({ text: `The ${bot.prefix + name} command does not exist` });
 *     } catch (e) {
 *       console.warn(`Error executing the ${bot.prefix + name} command`);
 *       console.error(e);
 *     }
 *   })
 *   .on(Events.ERROR, (err) => {
 *     console.warn('An error occurred');
 *     console.error(err);
 *   });
 * await bot.login();
 */
export class Bot extends EventEmitter<EventMap> {
  #prefix = '/';
  #reconnectionAttempts = 0;
  #id: string;
  #sock?: Socket;
  #me?: User;
  #logging = false;
  #logged = false;
  /** An instance of the {@link Auth} class that manages authentication credentials and signal keys */
  auth: Auth;
  /** Unified multi-tier layer containing specific cache maps for performance optimization */
  cache: {
    /** High-performance O(1) bi-indexed cache tracking mapped {@link User} models */
    users: UserCache;
    /** LRU (Least Recently Used) cache tracking {@link GroupMetadata} structures */
    groups: LRUCache<GroupMetadata>;
    /** TTL (Time To Live) cache storing raw messages to handle structural retries */
    messages: TTLCache<WAMessage>;
    /** Utility method shortcut to completely flush and empty all three underlying cache layers */
    flush: () => void;
  };
  constructor(id: string, auth: Auth) {
    assertType(id, 'id', 'string');
    super();
    this.#id = id;
    this.auth = auth;
    this.cache = {
      users: new UserCache(),
      groups: new LRUCache(5),
      messages: new TTLCache(ms('1h')),
      flush: () => {
        this.cache.users.clear();
        this.cache.groups.clear();
        this.cache.messages.clear();
      },
    };
  }
  #handleEvents(pn?: string) {
    this.sock.ev.on('creds.update', () => {
      try {
        this.auth.save();
      } catch (e) {
        this.emit(Events.ERROR, toError(e));
      }
    });
    this.sock.ev.on('connection.update', async (upd) => {
      try {
        if (upd.qr) {
          if (pn && !this.auth.creds.registered) {
            const code = await this.sock.requestPairingCode(pn.replace(/[^0-9]/g, ''));
            this.emit(Events.OTP, code);
          } else {
            this.emit(Events.QR, upd.qr);
          }
        }
        if (upd.connection === 'close') {
          await this.close();
          const out = new Boom(upd.lastDisconnect?.error).output;
          this.emit(Events.CLOSE, out);
          if (
            out.statusCode !== DisconnectReason.loggedOut &&
            out.statusCode !== DisconnectReason.forbidden &&
            out.statusCode !== 405
          ) {
            if (this.#reconnectionAttempts >= 5) {
              await this.logout(new Boom('number of reconnection attempts exceeded'));
              return;
            }
            if (out.statusCode !== DisconnectReason.restartRequired) {
              await delay(ms('5s'));
            }
            this.#reconnectionAttempts++;
            await this.login(pn);
          } else {
            await this.logout();
          }
          return;
        }
        if (upd.connection === 'open') {
          const me: User | undefined = resolveLIDAndPN(
            this.sock.user?.id,
            this.sock.user?.lid,
            this.sock.user?.phoneNumber,
          );
          if (!me) {
            await this.close(
              new Boom('restart required', {
                statusCode: DisconnectReason.restartRequired,
              }),
            );
            return;
          }
          this.#logged = true;
          this.#logging = false;
          this.#reconnectionAttempts = 0;
          this.#me = {
            ...me,
            name: this.sock.user!.verifiedName || this.sock.user!.name,
          };
          this.cache.users.set(this.me);
          this.emit(Events.OPEN, this.me);
          return;
        }
        if (upd.connection === 'connecting') {
          setTimeout(async () => {
            if (!this.#logged) {
              await this.close(
                new Boom(`time to log in expired`, { statusCode: DisconnectReason.loggedOut }),
              );
            }
          }, ms('60s'));
        }
      } catch (e) {
        this.emit(Events.ERROR, toError(e));
      }
    });
    this.sock.ev.on('messages.upsert', async (ups) => {
      try {
        for (const msg of ups.messages) {
          if (!msg.message || !msg.key.remoteJid || !msg.key.id) {
            return;
          }
          if (isJidGroup(msg.key.remoteJid) && !this.cache.groups.has(msg.key.remoteJid)) {
            const metadata = await this.sock
              .groupMetadata(msg.key.remoteJid)
              .catch(() => undefined);
            if (metadata) {
              metadata.participants.forEach((p) => {
                const user: User | undefined = resolveLIDAndPN(p.id, p.lid, p.phoneNumber);
                if (user && !this.cache.users.has(user)) {
                  user.name = undefined;
                  this.cache.users.set(user);
                }
              });
              this.cache.groups.set(msg.key.remoteJid, metadata);
            }
          }
          const sender =
            resolveLIDAndPN(msg.key.participant, msg.key.participantAlt) ||
            resolveLIDAndPN(msg.key.remoteJid, msg.key.remoteJidAlt);
          if (sender) {
            const name = msg.verifiedBizName || msg.pushName || undefined;
            const user = this.cache.users.get(sender);
            if (!user) {
              this.cache.users.set({
                ...sender,
                name: msg.key.fromMe ? undefined : name,
              });
            } else {
              // Do not modify the username if it was submitted by the bot
              if (name && user.name !== name && !msg.key.fromMe) {
                user.name = name;
              }
              // Update the bot's name if this changes
              if (name && this.me.name !== name && msg.key.fromMe) {
                this.#me!.name = name;
              }
              // A user's pn may change, but not their lid
              if (user.pn !== sender.pn) {
                user.pn = sender.pn;
              }
            }
          }
          if (ups.type === 'append') {
            // We only cache the messages sent by the bot
            this.cache.messages.set(msg.key.id, msg);
            return;
          }
          const message = new Message(msg, this);
          this.emit(Events.MESSAGE, message);
          if (!message.text?.startsWith(this.prefix)) {
            return;
          }
          const [name, ...args] = message.text
            .substring(this.#prefix.length)
            .split(/\s+/)
            .map((p, i) => (i === 0 ? p.toLowerCase() : p));
          // We ignore messages that only have the prefix
          if (name.length < 1) {
            return;
          }
          this.emit(Events.COMMAND, message, name, args);
        }
      } catch (e) {
        this.emit(Events.ERROR, toError(e));
      }
    });
    this.sock.ev.on('group-participants.update', (upd) => {
      try {
        if (this.cache.groups.has(upd.id)) {
          const participants = new Set(upd.participants.map((p) => p.id));
          const cached = this.cache.groups.get(upd.id)!;
          if (upd.action === 'remove') {
            cached.participants = cached.participants.filter((p) => !participants.has(p.id));
            return;
          }
          if (upd.action === 'add') {
            upd.participants.forEach((up) => {
              if (!cached.participants.some((cp) => participants.has(cp.id))) {
                cached.participants.push({
                  ...up,
                  // Just for consistency
                  lid: undefined,
                  username: undefined,
                });
              }
            });
            return;
          }
          if (upd.action === 'demote') {
            cached.participants.forEach((p) => {
              if (participants.has(p.id)) {
                p.admin = null;
              }
            });
            return;
          }
          if (upd.action === 'promote') {
            cached.participants.forEach((p) => {
              if (participants.has(p.id)) {
                p.admin = 'admin';
              }
            });
            return;
          }
        }
      } catch (e) {
        this.emit(Events.ERROR, toError(e));
      }
    });
    this.sock.ev.on('groups.update', (upd) => {
      try {
        upd.forEach((u) => {
          if (u.id && this.cache.groups.has(u.id)) {
            const cached = this.cache.groups.get(u.id)!;
            Object.assign(cached, u);
          }
        });
      } catch (e) {
        this.emit(Events.ERROR, toError(e));
      }
    });
  }
  /** Gets the unique identifier assigned to this bot instance session */
  get id() {
    return this.#id;
  }
  /** Gets the current symbol string prefix used to match incoming commands. Defaults to `/`. */
  get prefix() {
    return this.#prefix;
  }
  /** Gets the active custom connection {@link Socket} wrapper instance */
  get sock() {
    if (!this.#sock) {
      throw new Error('unlogged, calling .login() first');
    }
    return this.#sock;
  }
  /** Gets the authenticated bot user profile object */
  get me() {
    if (!this.#me) {
      throw new Error('unlogged, calling .login() first');
    }
    return this.#me;
  }
  /** Updates the global symbol prefix used to command executions */
  setPrefix(prefix: string) {
    assertType(prefix, 'prefix', 'string');
    this.#prefix = prefix;
    return this;
  }
  /**
   * Triggers the connection lifecycle setup sequence.
   * If a phone number is provided, log in will be done using an OTP code; otherwise, it will be done using a QR code.
   */
  async login(pn?: string) {
    try {
      if (this.#logged || this.#logging) {
        return;
      }
      this.#logging = true;
      if (pn) {
        assertType(pn, 'pn', 'string');
        if (!libpn(pn.startsWith('+') ? pn : '+' + pn)?.isValid()) {
          throw new TypeError('invalid phone number');
        }
      }
      const waver = await fetch(
        'https://raw.githubusercontent.com/jzszdznzzl/wabotjs/refs/heads/main/wa-version.json',
      ).then((r) => r.json() as Promise<[number, number, number]>);
      this.auth.load();
      this.#sock = new Socket({
        auth: { creds: this.auth.creds, keys: this.auth.keys },
        version: waver,
        browser: ['Ubuntu', 'Firefox', '26.0'],
        logger: pino({ level: 'silent' }),
        options: {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0',
          },
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        linkPreviewImageThumbnailWidth: 1080,
        qrTimeout: ms('30s'),
        maxMsgRetryCount: 5,
        shouldIgnoreJid: (jid) => {
          // Do not process messages that are not from users or a group
          return !isPnUser(jid) && !isLidUser(jid) && !isJidGroup(jid);
        },
        getMessage: async (key) => {
          if (key.id) {
            return this.cache.messages.get(key.id)?.message || undefined;
          }
          return undefined;
        },
        cachedGroupMetadata: async (id) => {
          if (this.cache.groups.has(id)) {
            return this.cache.groups.get(id);
          }
          const metadata = await this.sock.groupMetadata(id).catch(() => undefined);
          if (metadata) {
            metadata.participants.forEach((p) => {
              const user: User | undefined = resolveLIDAndPN(p.id, p.lid, p.phoneNumber);
              if (user && !this.cache.users.has(user)) {
                user.name = undefined;
                this.cache.users.set(user);
              }
            });
            this.cache.groups.set(id, metadata);
          }
          return metadata;
        },
      });
      this.#handleEvents(pn);
    } catch (e) {
      this.#logged = false;
      this.#logging = false;
      throw toError(e);
    }
  }
  /** It closes the current account session, completely erasing saved authentication data, closing sockets, and removing internal cache instances */
  async logout(err?: Error) {
    try {
      if (!this.#sock) {
        throw new Error('unlogged');
      }
      await this.sock.logout(err).catch(() => void 0);
      //@ts-ignore
      this.sock.ev.removeAllListeners(undefined);
      this.auth.drop();
    } catch (e) {
      throw toError(e);
    } finally {
      this.#sock = undefined;
      this.#logging = false;
      this.#logged = false;
      this.cache.flush();
      this.#reconnectionAttempts = 0;
    }
  }
  /** Closes the active network socket connection without removing local authentication credentials, allowing for subsequent automatic reconnections */
  async close(err?: Error) {
    try {
      if (!this.#sock) {
        throw new Error('unlogged');
      }
      await this.sock.end(err).catch(() => void 0);
      //@ts-ignore
      this.sock.ev.removeAllListeners(undefined);
    } catch (e) {
      throw toError(e);
    } finally {
      this.#sock = undefined;
      this.#logging = false;
      this.#logged = false;
      this.#reconnectionAttempts = 0;
    }
  }
}
