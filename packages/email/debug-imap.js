
const { ImapFlow } = require('imapflow');

async function testImapConnection() {
  try {
    console.log('🔍 开始测试 IMAP 连接...\n');

    // 使用我们直接测试成功过的账号
    const client = new ImapFlow({
      host: 'imap.163.com',
      port: 993,
      secure: true,
      auth: {
        user: 'chydroid@163.com',
        pass: 'DCq4QHXN46bMPCc9'
      },
      logger: false
    });

    console.log('📡 正在连接到 imap.163.com:993...');
    await client.connect();
    console.log('✅ 连接成功！\n');

    console.log('📂 正在打开 INBOX 文件夹...');
    const mailbox = await client.mailboxOpen('INBOX');
    console.log('✅ 成功打开 INBOX！\n');

    console.log('📨 邮箱信息:');
    console.log('   - exists:', mailbox?.exists || '未知');
    console.log('   - recent:', mailbox?.recent || '未知');
    console.log('   - unseen:', mailbox?.unseen || '未知');
    console.log('   - uidNext:', mailbox?.uidNext || '未知');
    console.log('   - uidValidity:', mailbox?.uidValidity || '未知');
    console.log('');

    // 尝试获取最近 10 封邮件
    console.log('📋 尝试获取最近的 10 封邮件...\n');
    
    // 方法1: 使用简单查询
    let emails = [];
    try {
      console.log('方法1: 使用 ALL 查询');
      let count = 0;
      for await (const msg of client.fetch('1:*', {
        envelope: true,
        flags: true,
        size: true,
        uid: true,
        bodyStructure: true
      })) {
        count++;
        emails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address,
          date: msg.envelope?.date,
          flags: msg.flags
        });
        
        if (count >= 10) break;
      }
      console.log(`✅ 方法1: 获取了 ${count} 封邮件\n`);
    } catch (err) {
      console.log('❌ 方法1失败:', err.message, '\n');
    }
    
    if (emails.length === 0) {
      // 方法2: 使用最后 N 封邮件查询
      try {
        console.log('方法2: 使用 last 10 条邮件');
        const mailboxData = await client.mailboxOpen('INBOX');
        const totalMessages = mailboxData && 'exists' in mailboxData ? mailboxData.exists : 0;
        console.log(`总邮件数: ${totalMessages}`);
        
        if (totalMessages > 0) {
          const startSeq = Math.max(1, totalMessages - 10 + 1);
          const sequence = `${startSeq}:*`;
          console.log(`查询范围: ${sequence}`);
          
          let count = 0;
          for await (const msg of client.fetch(sequence, {
            envelope: true,
            flags: true,
            size: true,
            uid: true
          })) {
            count++;
            emails.push({
              uid: msg.uid,
              subject: msg.envelope?.subject,
              from: msg.envelope?.from?.[0]?.address,
              date: msg.envelope?.date,
              flags: msg.flags
            });
          }
          console.log(`✅ 方法2: 获取了 ${count} 封邮件\n`);
        }
      } catch (err) {
        console.log('❌ 方法2失败:', err.message, '\n');
      }
    }
    
    // 显示获取到的邮件
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 获取到的邮件:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (emails.length > 0) {
      emails.forEach((email, index) => {
        console.log(`\n${index + 1}. 主题: ${email.subject || '(无主题)'}`);
        console.log(`   发件人: ${email.from || '(未知)'}`);
        console.log(`   日期: ${email.date || '(未知)'}`);
        console.log(`   UID: ${email.uid}`);
        console.log(`   标记: ${Array.from(email.flags || []).join(', ')}`);
      });
    } else {
      console.log('\n❌ 没有获取到任何邮件');
    }
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await client.logout();
    console.log('✅ 连接断开，测试结束。\n');
  } catch (err) {
    console.error('❌ IMAP 连接测试失败:', err);
    console.error('\n错误详情:', err.stack);
  }
}

testImapConnection();
