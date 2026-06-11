const fs = require('fs');
const obj = {
  message: "查一下今天上海天气怎么样",
  sessionId: "test-execution-001"
};
fs.writeFileSync('d:/abc/EvoClaw/scripts/req-exec.json', JSON.stringify(obj, null, 2), 'utf8');
console.log('Written:', JSON.stringify(obj));
