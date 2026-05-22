const { EmailClient } = require('./dist/email-client.js');
const { ServiceRegistry, EventBus } = require('@evoclaw/core');

async function testEmailClient() {
  console.log('🔍 开始测试 EmailClient...\n');

  try {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    const client = new EmailClient(registry, eventBus, {
      dataDir: 'D:\\abc\\EvoClaw\\data\\email'
    });

    await client.initialize();
    console.log('✅ EmailClient 初始化成功');

    const accounts = client.listAccounts();
    console.log(`📧 账号数量: ${accounts.length}`);
    console.log('账号列表:', accounts.map(a => ({ id: a.id, email: a.email, provider: a.provider })));

    if (accounts.length === 0) {
      console.log('❌ 没有配置邮箱账号');
      return;
    }

    const accountId = accounts[0].id;
    console.log(`\n🎯 使用账号: ${accountId}`);

    // 测试 getInboxSummary
    console.log('\n📊 测试 getInboxSummary...');
    try {
      const summary = await client.getInboxSummary(accountId);
      console.log('✅ getInboxSummary 成功:');
      console.log('  total:', summary.total);
      console.log('  unread:', summary.unread);
      console.log('  recent数量:', summary.recent.length);
      console.log('  categories:', summary.categories);
    } catch (err) {
      console.error('❌ getInboxSummary 失败:', err.message);
      console.error('错误堆栈:', err.stack);
    }

    // 测试 listEmails
    console.log('\n📋 测试 listEmails...');
    try {
      const emails = await client.listEmails({ accountId, limit: 5 });
      console.log(`✅ listEmails 成功，获取了 ${emails.length} 封邮件`);
      emails.forEach((email, i) => {
        console.log(`  ${i+1}. ${email.subject} (from: ${email.from})`);
      });
    } catch (err) {
      console.error('❌ listEmails 失败:', err.message);
      console.error('错误堆栈:', err.stack);
    }

  } catch (err) {
    console.error('❌ 测试失败:', err);
    console.error('错误堆栈:', err.stack);
  }
}

testEmailClient();
