const bearer = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0Iiwicm9sZXMiOlsidXNlciJdLCJpYXQiOjE3NzkxMDM2NTMsImV4cCI6MTc3OTE5MDA1M30.k82TM12Y5Y9owaV-qicvxnms4eI85aWljRQf8V3d4_0";

async function main() {
  const resp = await fetch("http://localhost:17788/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearer}`
    },
    body: JSON.stringify({
      message: "在D盘创建一个文件夹newweb，在其中生成一个简单的网页，包括有CSS和JS代码",
      sessionId: "test-fix"
    })
  });
  const data = await resp.json();
  console.log("Status:", resp.status);
  console.log("Reply (first 2000 chars):");
  console.log(data.reply ? data.reply.substring(0, 2000) : "(empty)");
  console.log("Tokens:", data.tokensUsed, "Duration:", data.duration + "ms");
}

main().catch(err => console.error("Error:", err.message));