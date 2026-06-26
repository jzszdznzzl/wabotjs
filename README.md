<div align='center'>

# ⚡ WABotJS ⚡

A WhatsApp bot library built on [baileys](https://github.com/whiskeysockets/baileys) and TypeScript

</div>

## 📋 Requirements

- Node.js >= 24
- `npm`, `pnpm`, or `yarn`

> [!IMPORTANT]
> You must have Node.js version v24 or higher; otherwise, you will not be able to use this library. This library requires the native module `node:sqlite` to function

## 🚀 Installation

```bash
npm install @jzszdznzzl/wabotjs -E

# or
pnpm install @jzszdznzzl/wabotjs -E

# or
yarn install @jzszdznzzl/wabotjs -E
```

## 💡 Basic Usage

```ts
import { Bot, Auth, Events, jidDecode } from '@jzszdznzzl/wabotjs';
import { join } from 'node:path';
import { toString } from 'qrcode';

const id = 'my-bot';
const auth = new Auth(join(process.cwd(), 'sessions', id));
const bot = new Bot(id, auth)
  .on(Events.CLOSE, (out) => {
    console.warn('Bot connection closed');
    console.dir(out, { depth: null });
  })
  .on(Events.OPEN, (user) => {
    console.log(`Bot connection open in ${user.name}(${jidDecode(user.pn)!.user})`);
  })
  .on(Events.QR, async (str) => {
    const qr = await toString(str, { type: 'terminal', small: true });
    console.log('QR code');
    console.log(qr);
  })
  .on(Events.OTP, (code) => {
    console.log('Pairing code');
    console.log(code);
  })
  .setPrefix('!')
  .on(Events.COMMAND, async (msg, name, args) => {
    try {
      if (['ping', 'p'].includes(name)) {
        await msg.reply({ text: '¡Pong!' });
        return;
      }
      if (['echo', 'say'].includes(name)) {
        await msg.reply({ text: args.length > 0 ? args.join(' ') : '¡Hello, World!' });
        return;
      }
      await msg.reply({ text: `The ${bot.prefix + name} command does not exist` });
    } catch (e) {
      console.warn(`Error executing the ${bot.prefix + name} command`);
      console.error(e);
    }
  })
  .on(Events.ERROR, (err) => {
    console.warn('An error occurred');
    console.error(err);
  });
await bot.login();
```

## 🔌 API's

### - Auth -> Look [Auth.ts](src/Auth.ts)

### - Bot -> Look [Bot.ts](src/Bot.ts)

### - Message -> Look [Message.ts](src/Message.ts)

### - Socket -> Look [Socket.ts](src/Socket.ts)

## 🏗️ Architecture

It's advisable to take a look at the internal code to better understand how it works

```text
src/
├── utils/
│    ├── asserts.ts
│    ├── converters.ts
│    ├── generics.ts
│    ├── index.ts
│    ├── LRUCache.ts
│    ├── SQLiteStore.ts
│    ├── TTLCache.ts
│    └── UserCache.ts
├── Auth.ts
├── Bot.ts
├── index.ts
├── Message.ts
└── Socket.ts
```

> [!CAUTION]
> DISCLAIMER
>
> This software is provided "as is" without warranty of any kind. WABotJS is an independent tool and holds no affiliation with WhatsApp. Meta Platforms, Inc. reserves the right to ban accounts utilizing unauthorized third-party clients. The creator [jzszdznzzl](https://github.com/jzszdznzzl) shall not be held liable for any account restrictions, bans, or repercussions stemming from the use of this library. Use at your own risk.

<div align='center'>

## 📄 License

[MIT License](LICENSE)

</div>
