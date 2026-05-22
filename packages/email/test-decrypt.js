const crypto = require('crypto');

const ENCRYPTION_KEY = Buffer.from(process.env.EvoClaw_EMAIL_KEY || "evoclaw-email-key-32-bytes-here!", "utf-8").subarray(0, 32);

const accounts = [
  {
    id: "acct-1779364693787-64ih",
    encryptedPassword: "3f805dea251c4655b73b543aa5830772",
    iv: "c14168d2e3d2c1a8dd75465b62f64cb2"
  },
  {
    id: "acct-1779365171501-2ydb",
    encryptedPassword: "e7d826b8988fa906400c3c7497050da5936babbb441aea9ea4205c7736f39b09",
    iv: "53311a8136fcedeb535a720c4f7defe4"
  },
  {
    id: "acct-1779365317753-e9ud",
    encryptedPassword: "bf2aa2b32105403dfcd42edfb43e4266ca81084f7e06bb0ce1ddd85f0e270882",
    iv: "f816288f79b841ff98660fc0541b459e"
  },
  {
    id: "acct-1779367306972-u7s0",
    encryptedPassword: "b0dd8b059e4a24a1af1d3b7afeade098a0cffa8e821ee0514c09f9ebceeb788b",
    iv: "88f643497075b6b428fe7730b060bbf8"
  }
];

function decryptPassword(account) {
  try {
    const iv = Buffer.from(account.iv, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(account.encryptedPassword, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  } catch (err) {
    return `解密失败: ${err.message}`;
  }
}

console.log('🔑 测试密码解密...\n');
for (const acct of accounts) {
  const decrypted = decryptPassword(acct);
  console.log(`账号 ${acct.id}:`);
  console.log(`  解密结果: ${decrypted}`);
  console.log(`  长度: ${decrypted.length}`);
  console.log('');
}

// 用正确的密码直接测试IMAP
const { ImapFlow } = require('imapflow');

async function testWithPassword(password) {
  const client = new ImapFlow({
    host: 'imap.163.com',
    port: 993,
    secure: true,
    auth: {
      user: 'chydroid@163.com',
      pass: password
    },
    logger: false
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');
    console.log(`✅ 密码 "${password}" 连接成功，邮件数: ${mailbox?.exists || 0}`);
    await client.logout();
    return true;
  } catch (err) {
    console.log(`❌ 密码 "${password}" 连接失败: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('\n📡 用各账号解密后的密码测试IMAP连接...\n');
  for (const acct of accounts) {
    const password = decryptPassword(acct);
    if (!password.startsWith('解密失败')) {
      console.log(`\n测试账号 ${acct.id}:`);
      await testWithPassword(password);
    }
  }

  console.log('\n📡 用已知正确的密码测试...');
  await testWithPassword('DCq4QHXN46bMPCc9');
}

main().catch(console.error);
